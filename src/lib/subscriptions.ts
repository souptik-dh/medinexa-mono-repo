import { createHmac, randomBytes } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { ApiError, conflict, notFound } from "@/lib/errors";
import { newId } from "@/lib/ids";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export type SubscriptionStatus = "TRIAL" | "ACTIVE" | "EXPIRING" | "EXPIRED" | "INACTIVE";
export type StoredSubscriptionStatus = "TRIAL" | "ACTIVE" | "EXPIRED" | "INACTIVE";

export const DEFAULT_MONTHLY_AMOUNT = 49.0;
export const DEFAULT_CURRENCY = "INR";
export const DEFAULT_TRIAL_MONTHS = 2;
export const DEFAULT_EXPIRING_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * HMAC secret used to verify gateway-style payment callbacks. Razorpay signs
 * `order_id|payment_id` with RAZORPAY_KEY_SECRET, so that must take precedence
 * whenever real Razorpay orders are in play; SUBSCRIPTION_PAYMENT_SECRET only
 * covers the generic mock-gateway fallback when no Razorpay keys are set.
 */
function paymentSecret(): string {
  const secret =
    process.env.RAZORPAY_KEY_SECRET ?? process.env.SUBSCRIPTION_PAYMENT_SECRET ?? null;
  if (!secret) {
    throw new ApiError(
      503,
      "PAYMENT_VERIFICATION_UNAVAILABLE",
      "Payment verification is not configured on the server. Set RAZORPAY_KEY_SECRET.",
    );
  }
  return secret;
}

/** Creates a real order via Razorpay's Orders API so checkout.js has a valid order_id to open. */
async function createRazorpayOrder(opts: {
  amount: number;
  currency: string;
  receipt: string;
}): Promise<string> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new ApiError(
      503,
      "PAYMENT_GATEWAY_UNAVAILABLE",
      "Razorpay is not configured on the server. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
    );
  }
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    },
    body: JSON.stringify({
      amount: Math.round(opts.amount * 100),
      currency: opts.currency,
      receipt: opts.receipt,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ApiError(502, "PAYMENT_GATEWAY_ERROR", `Razorpay order creation failed: ${detail || res.statusText}`);
  }
  const order = (await res.json()) as { id: string };
  return order.id;
}

export function computeProviderSignature(orderId: string, paymentId: string): string {
  return createHmac("sha256", paymentSecret())
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

export function verifyProviderSignature(
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const expected = computeProviderSignature(orderId, paymentId);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? "");
  return a.length === b.length && a.toString("hex") === b.toString("hex");
}

/** pool runs with dateStrings:true — DATETIME(3) arrives as 'YYYY-MM-DD HH:MM:SS[.mmm]'. */
export function toUtcMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string") return NaN;
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /[Z+\-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  return Date.parse(withZone);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Plans & settings
// ---------------------------------------------------------------------------

export interface ActivePlan {
  id: string | null;
  name: string;
  amount: number;
  currency: string;
  trial_months: number;
}

export async function getActivePlan(db: Db): Promise<ActivePlan> {
  const [rows] = await db.query<Row[]>(
    `SELECT id, name, amount, currency, trial_months
       FROM subscription_plans
      WHERE is_active = 1 AND effective_from <= UTC_TIMESTAMP(3)
      ORDER BY effective_from DESC LIMIT 1`,
  );
  const row = rows[0];
  if (!row) {
    // Self-heal if settings were wiped: fall back to built-in defaults.
    return {
      id: null,
      name: "Clinic Monthly",
      amount: DEFAULT_MONTHLY_AMOUNT,
      currency: DEFAULT_CURRENCY,
      trial_months: DEFAULT_TRIAL_MONTHS,
    };
  }
  return {
    id: row.id,
    name: row.name,
    amount: Number(row.amount),
    currency: row.currency,
    trial_months: Number(row.trial_months),
  };
}

export interface PlatformSettings {
  expiring_warning_days: number;
  max_months_per_payment: number;
  currency: string;
}

export async function getPlatformSettings(db: Db): Promise<PlatformSettings> {
  const [rows] = await db.query<Row[]>(`SELECT setting_key, setting_value FROM platform_settings`);
  const map = new Map(rows.map((r) => [String(r.setting_key), String(r.setting_value)]));
  const intOr = (key: string, fallback: number): number => {
    const raw = Number(map.get(key));
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  };
  return {
    expiring_warning_days: intOr("subscription.expiring_warning_days", DEFAULT_EXPIRING_WARNING_DAYS),
    max_months_per_payment: Math.max(1, intOr("subscription.max_months_per_payment", 12)),
    currency: map.get("subscription.currency") ?? DEFAULT_CURRENCY,
  };
}

// ---------------------------------------------------------------------------
// Subscription fetch / lazy provisioning / state computation
// ---------------------------------------------------------------------------

export async function getClinicSubscriptionRow(db: Db, clinicId: string): Promise<Row | null> {
  const [rows] = await db.query<Row[]>(
    `SELECT cs.* FROM clinic_subscriptions cs WHERE cs.clinic_id = ?`,
    [clinicId],
  );
  return rows[0] ?? null;
}

async function readSubscriptionNoLock(db: Db, clinicId: string): Promise<Row | null> {
  const [rows] = await db.query<Row[]>(
    `SELECT cs.*, c.created_at AS clinic_created_at, c.deleted_at AS clinic_deleted_at
       FROM clinics c LEFT JOIN clinic_subscriptions cs ON cs.clinic_id = c.id
      WHERE c.id = ?`,
    [clinicId],
  );
  return rows[0] ?? null;
}

/**
 * Returns the clinic's subscription row, lazily creating a TRIAL row (anchored at the
 * clinic's own created_at date) for clinics that predate the subscription system or
 * were inserted without one. Safe under concurrency via the unique key.
 */
export async function ensureClinicSubscription(db: Db, clinicId: string): Promise<Row> {
  const existing = await readSubscriptionNoLock(db, clinicId);
  if (existing?.id) return existing;

  const plan = await getActivePlan(db);
  await db.query(
    `INSERT IGNORE INTO clinic_subscriptions
       (id, clinic_id, status, plan_id, monthly_amount, currency,
        period_start, period_end, is_trial, trial_started_at, trial_ends_at)
     SELECT ?, c.id, 'TRIAL', ?, ?, ?,
            c.created_at, DATE_ADD(c.created_at, INTERVAL ? MONTH), 1, c.created_at,
            DATE_ADD(c.created_at, INTERVAL ? MONTH)
       FROM clinics c WHERE c.id = ?`,
    [
      newId(),
      plan.id,
      plan.amount,
      plan.currency,
      plan.trial_months,
      plan.trial_months,
      clinicId,
    ],
  );
  const created = await readSubscriptionNoLock(db, clinicId);
  if (!created?.id) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");
  return created;
}

export interface LiveSubscriptionState {
  storedStatus: StoredSubscriptionStatus;
  /** Display status — includes the derived EXPIRING state. */
  status: SubscriptionStatus;
  blocked: boolean;
  blockedReason: string | null;
  effectiveEndMs: number;
  daysRemaining: number;
  expiringSoon: boolean;
}

export function computeLiveState(sub: Row, warningDays: number): LiveSubscriptionState {
  const now = Date.now();
  const storedStatus = String(sub.status) as StoredSubscriptionStatus;
  const isTrial = Boolean(sub.is_trial);
  const endMs = isTrial ? toUtcMs(sub.trial_ends_at) : toUtcMs(sub.period_end);

  let expiredLive = false;
  let blocked = false;
  let blockedReason: string | null = null;

  if (storedStatus === "INACTIVE") {
    blocked = true;
    expiredLive = true;
    blockedReason = sub.deactivation_reason
      ? `Clinic deactivated by platform administrator: ${sub.deactivation_reason}`
      : "Clinic deactivated by platform administrator.";
  } else if (endMs <= now) {
    expiredLive = true;
    blocked = true;
    blockedReason = isTrial
      ? "The free trial period has ended. Pay the monthly subscription to restore clinic access."
      : "The subscription has expired. Renew the subscription to restore clinic access.";
  }

  const daysRemaining = Math.max(0, Math.ceil((endMs - now) / DAY_MS));
  const expiringSoon = !expiredLive && daysRemaining <= warningDays;
  const status: SubscriptionStatus = expiredLive
    ? "EXPIRED"
    : expiringSoon && storedStatus === "ACTIVE"
      ? "EXPIRING"
      : storedStatus;

  return { storedStatus, status, blocked, blockedReason, effectiveEndMs: endMs, daysRemaining, expiringSoon };
}

/**
 * The subscription gate. Throws 402 PAYMENT_REQUIRED when clinic operations are not
 * allowed because the trial/subscription has lapsed or the clinic was deactivated.
 * Never deletes anything — it only restricts operations.
 */
export async function assertClinicOperational(db: Db, clinicId: string): Promise<void> {
  const [sub, settings] = await Promise.all([
    ensureClinicSubscription(db, clinicId),
    getPlatformSettings(db),
  ]);
  const live = computeLiveState(sub, settings.expiring_warning_days);
  if (live.blocked) {
    throw new ApiError(
      402,
      "SUBSCRIPTION_INACTIVE",
      live.blockedReason ??
        "Clinic subscription is inactive. Renew the subscription to restore clinic access.",
    );
  }
}

export async function resolveClinicIdByBranch(db: Db, branchId: string): Promise<string | null> {
  const [rows] = await db.query<Row[]>(
    `SELECT clinic_id FROM branches WHERE id = ? AND deleted_at IS NULL`,
    [branchId],
  );
  return rows[0] ? String(rows[0].clinic_id) : null;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeSubscription(sub: Row, live: LiveSubscriptionState): Record<string, unknown> {
  const iso = (v: unknown): string | null =>
    typeof v === "string" ? `${v.includes("T") ? v : v.replace(" ", "T")}Z`.replace(/(\.\d+)?Z$/, "Z") : null;
  return {
    id: sub.id,
    clinic_id: sub.clinic_id,
    status: live.status,
    stored_status: live.storedStatus,
    is_trial: Boolean(sub.is_trial),
    monthly_amount: Number(sub.monthly_amount),
    currency: sub.currency,
    period_start: iso(sub.period_start),
    period_end: iso(sub.period_end),
    trial_started_at: iso(sub.trial_started_at),
    trial_ends_at: iso(sub.trial_ends_at),
    days_remaining: live.daysRemaining,
    expiring_soon: live.expiringSoon || live.status === "EXPIRING",
    auto_renew: Boolean(sub.auto_renew),
    inactive_since: iso(sub.deactivated_at),
    deactivation_reason: sub.deactivation_reason ?? null,
    blocked: live.blocked,
    blocked_reason: live.blockedReason,
  };
}

export function serializeSubscriptionPayment(p: Row): Record<string, unknown> {
  const iso = (v: unknown): string | null =>
    typeof v === "string" ? `${v.replace(" ", "T")}Z` : null;
  return {
    id: p.id,
    clinic_id: p.clinic_id,
    subscription_id: p.subscription_id,
    invoice_no: p.invoice_no,
    amount: Number(p.amount),
    currency: p.currency,
    months: Number(p.months),
    method: p.method,
    provider: p.provider ?? null,
    provider_order_id: p.provider_order_id ?? null,
    provider_payment_id: p.provider_payment_id ?? null,
    status: p.status,
    failure_reason: p.failure_reason ?? null,
    reference_no: p.reference_no ?? null,
    verification_method: p.verification_method ?? null,
    verified_by: p.verified_by ?? null,
    verified_at: iso(p.verified_at),
    period_start: iso(p.period_start),
    period_end: iso(p.period_end),
    initiated_by: p.initiated_by ?? null,
    created_at: iso(p.created_at),
  };
}

export function serializeHistory(h: Row): Record<string, unknown> {
  return {
    id: h.id,
    clinic_id: h.clinic_id,
    from_status: h.from_status ?? null,
    to_status: h.to_status,
    reason: h.reason ?? null,
    changed_by: h.changed_by ?? null,
    source: h.source,
    created_at: typeof h.created_at === "string" ? `${h.created_at.replace(" ", "T")}Z` : h.created_at,
  };
}

// ---------------------------------------------------------------------------
// Payment lifecycle
// ---------------------------------------------------------------------------

export async function initiateSubscriptionPayment(
  db: Db,
  clinicId: string,
  opts: { months: number; method: string; userId: string },
): Promise<Row> {
  const sub = await ensureClinicSubscription(db, clinicId);
  const settings = await getPlatformSettings(db);
  if (opts.months < 1 || opts.months > settings.max_months_per_payment) {
    throw new ApiError(
      400,
      "INVALID_MONTHS",
      `months must be between 1 and ${settings.max_months_per_payment}.`,
      "months",
    );
  }
  // Price is ALWAYS computed server-side from the current active plan — never from
  // the request. Changing the plan affects payments initiated afterwards only.
  const plan = await getActivePlan(db);
  const amount = round2(plan.amount * opts.months);
  const invoiceNo = `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4)
    .toString("hex")
    .toUpperCase()}`;
  const orderId = await createRazorpayOrder({ amount, currency: plan.currency, receipt: invoiceNo });

  const id = newId();
  await db.query(
    `INSERT INTO subscription_payments
       (id, clinic_id, subscription_id, plan_id, invoice_no, amount, currency, months,
        method, provider, provider_order_id, status, initiated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'subscription_gateway', ?, 'PENDING', ?)`,
    [
      id,
      clinicId,
      sub.id,
      plan.id,
      invoiceNo,
      amount.toFixed(2),
      plan.currency,
      opts.months,
      opts.method,
      orderId,
      opts.userId,
    ],
  );
  const [rows] = await db.query<Row[]>(`SELECT * FROM subscription_payments WHERE id = ?`, [id]);
  return rows[0];
}

async function loadPaymentForUpdate(db: Db, paymentId: string): Promise<Row> {
  const [rows] = await db.query<Row[]>(
    `SELECT * FROM subscription_payments WHERE id = ? OR provider_order_id = ? FOR UPDATE`,
    [paymentId, paymentId],
  );
  const row = rows[0];
  if (!row) throw notFound("PAYMENT_NOT_FOUND", "Subscription payment not found.");
  return row;
}

/**
 * Marks a PENDING payment as PAID and applies it to the subscription in the same
 * transaction: extends/sets the paid period, flips the subscription to ACTIVE and
 * re-enables clinic operations. The single activation path shared by client-side
 * signature verification, gateway webhooks and Super Admin manual confirmation.
 */
export async function applyPaidPayment(
  conn: PoolConnection,
  payment: Row,
  meta: { verificationMethod: "signature" | "webhook" | "manual"; verifiedBy: string | null; source: "payment" | "webhook" | "super_admin" },
): Promise<{ payment: Row; subscription: Row }> {
  if (payment.status === "PAID") {
    throw conflict("PAYMENT_ALREADY_VERIFIED", "This payment has already been verified.");
  }
  if (payment.status === "FAILED") {
    throw conflict("PAYMENT_FAILED", "This payment attempt failed and cannot be verified.");
  }

  const [subRows] = await conn.query<Row[]>(
    `SELECT * FROM clinic_subscriptions WHERE id = ? FOR UPDATE`,
    [payment.subscription_id],
  );
  const sub = subRows[0];
  if (!sub) throw notFound("SUBSCRIPTION_NOT_FOUND", "Subscription not found.");

  const nowMs = Date.now();
  const trialEndsMs = toUtcMs(sub.trial_ends_at);
  const periodEndMs = toUtcMs(sub.period_end);
  // Paying while still inside a valid window never loses the remaining time:
  // the new paid period starts when the current window ends.
  let baseMs = nowMs;
  if ((sub.is_trial && trialEndsMs > baseMs) || (!sub.is_trial && String(sub.status) === "ACTIVE" && periodEndMs > baseMs)) {
    baseMs = Math.max(trialEndsMs, periodEndMs);
  }
  const baseSql = new Date(baseMs).toISOString().slice(0, 19).replace("T", " ");
  const months = Number(payment.months);

  await conn.query(
    `UPDATE subscription_payments SET
        status = 'PAID',
        verification_method = ?,
        verified_by = ?,
        verified_at = UTC_TIMESTAMP(3),
        period_start = ?,
        period_end = DATE_ADD(?, INTERVAL ? MONTH)
      WHERE id = ?`,
    [meta.verificationMethod, meta.verifiedBy, baseSql, baseSql, months, payment.id],
  );

  await conn.query(
    `UPDATE clinic_subscriptions SET
        status = 'ACTIVE',
        is_trial = 0,
        monthly_amount = ROUND(? / ?, 2),
        currency = ?,
        period_start = ?,
        period_end = DATE_ADD(?, INTERVAL ? MONTH),
        auto_renew = 1,
        deactivated_at = NULL,
        deactivated_by = NULL,
        deactivation_reason = NULL,
        last_paid_payment_id = ?
      WHERE id = ?`,
    [Number(payment.amount), months, payment.currency, baseSql, baseSql, months, payment.id, sub.id],
  );

  await conn.query(
    `INSERT INTO subscription_history
       (id, clinic_id, subscription_id, from_status, to_status, reason, changed_by, source)
     VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [
      newId(),
      sub.clinic_id,
      sub.id,
      sub.status,
      `Payment ${payment.invoice_no} verified (${meta.verificationMethod}); +${months} month(s)`,
      meta.verifiedBy,
      meta.source,
    ],
  );

  await notifyClinicOwner(conn, sub.clinic_id, "subscription_activated", {
    clinic_id: sub.clinic_id,
    message: `Your clinic subscription is active until the paid period ending after ${months} month(s).`,
    invoice_no: payment.invoice_no,
    amount: Number(payment.amount),
  });

  const [paidRows] = await conn.query<Row[]>(`SELECT * FROM subscription_payments WHERE id = ?`, [payment.id]);
  const [subAfter] = await conn.query<Row[]>(`SELECT * FROM clinic_subscriptions WHERE id = ?`, [sub.id]);
  return { payment: paidRows[0], subscription: subAfter[0] };
}

export async function verifySubscriptionPaymentByClient(
  poolDb: Pool,
  paymentId: string,
  opts: { providerPaymentId: string; providerSignature: string; referenceNo?: string | null },
): Promise<{ payment: Row; subscription: Row }> {
  return runInPoolTransaction(poolDb, async (conn) => {
    const payment = await loadPaymentForUpdate(conn, paymentId);
    // Server-side HMAC check over order|payment ids. A frontend claiming "paid"
    // without a valid signature changes nothing.
    if (!verifyProviderSignature(String(payment.provider_order_id), opts.providerPaymentId, opts.providerSignature)) {
      await markPaymentFailed(conn, payment.id, "Invalid payment signature.");
      throw new ApiError(400, "PAYMENT_SIGNATURE_INVALID", "Payment signature verification failed.");
    }
    await conn.query(
      `UPDATE subscription_payments SET provider_payment_id = ?, provider_signature = ?, reference_no = COALESCE(?, reference_no) WHERE id = ?`,
      [opts.providerPaymentId, opts.providerSignature, opts.referenceNo ?? null, payment.id],
    );
    const refreshed = await loadPaymentForUpdate(conn, paymentId);
    return applyPaidPayment(conn, refreshed, {
      verificationMethod: "signature",
      verifiedBy: null,
      source: "payment",
    });
  });
}

async function markPaymentFailed(conn: PoolConnection, paymentId: string, reason: string): Promise<void> {
  await conn.query(
    `UPDATE subscription_payments SET status = 'FAILED', failure_reason = ? WHERE id = ? AND status = 'PENDING'`,
    [reason.slice(0, 500), paymentId],
  );
}

/**
 * Reactivation helper: lets a clinic restore operations from an ALREADY-VERIFIED
 * payment whose purchased window is still current (e.g. activation never took effect,
 * or the row was later manually suspended). Never extends beyond what was paid.
 * Returns whether anything was applied.
 */
export async function reactivateWithLatestPayment(
  conn: PoolConnection,
  clinicId: string,
): Promise<{ applied: boolean; payment: Row | null; reason: string | null }> {
  const [rows] = await conn.query<Row[]>(
    `SELECT * FROM subscription_payments
      WHERE clinic_id = ? AND status = 'PAID'
      ORDER BY verified_at DESC LIMIT 1`,
    [clinicId],
  );
  const latest = rows[0];
  if (!latest) {
    return { applied: false, payment: null, reason: "No verified subscription payment found." };
  }

  const sub = await ensureClinicSubscription(conn, clinicId);
  const settings = await getPlatformSettings(conn);
  const live = computeLiveState(sub, settings.expiring_warning_days);
  if (!live.blocked) {
    return { applied: false, payment: latest, reason: "Clinic operations are already active." };
  }
  // Manual platform suspensions are lifted only by the Super Admin.
  if (live.storedStatus === "INACTIVE") {
    return {
      applied: false,
      payment: latest,
      reason: "Clinic was deactivated by the platform administrator. Contact support.",
    };
  }

  const periodEndMs = toUtcMs(latest.period_end);
  if (!latest.period_end || periodEndMs <= Date.now()) {
    return {
      applied: false,
      payment: latest,
      reason: "The most recent verified payment has already been fully consumed. Initiate a new payment.",
    };
  }

  // The payment bought time that isn't currently reflected on the subscription —
  // restore exactly the purchased window (never more).
  await conn.query(
    `UPDATE clinic_subscriptions SET
        status = 'ACTIVE', is_trial = 0,
        period_start = ?, period_end = ?,
        deactivated_at = NULL, deactivated_by = NULL, deactivation_reason = NULL
      WHERE id = ?`,
    [latest.period_start, latest.period_end, sub.id],
  );
  await conn.query(
    `INSERT INTO subscription_history
       (id, clinic_id, subscription_id, from_status, to_status, reason, changed_by, source)
     VALUES (?, ?, ?, ?, 'ACTIVE', ?, NULL, 'payment')`,
    [
      newId(),
      sub.clinic_id,
      sub.id,
      sub.status,
      `Reactivated from verified payment ${latest.invoice_no} through ${String(latest.period_end).slice(0, 19)}`,
    ],
  );
  await notifyClinicOwner(conn, sub.clinic_id, "subscription_activated", {
    clinic_id: sub.clinic_id,
    message: "Your clinic has been reactivated from your verified subscription payment.",
  });

  return { applied: true, payment: latest, reason: null };
}

// ---------------------------------------------------------------------------
// Super Admin operations
// ---------------------------------------------------------------------------

export async function deactivateClinicManually(
  conn: PoolConnection,
  clinicId: string,
  reason: string,
  actorId: string,
): Promise<Row> {
  const sub = await ensureClinicSubscription(conn, clinicId);
  if (String(sub.status) === "INACTIVE") {
    throw conflict("CLINIC_ALREADY_DEACTIVATED", "Clinic is already deactivated.");
  }
  await conn.query(
    `UPDATE clinic_subscriptions SET status = 'INACTIVE', deactivated_at = UTC_TIMESTAMP(3), deactivated_by = ?, deactivation_reason = ? WHERE id = ?`,
    [actorId, reason.slice(0, 500), sub.id],
  );
  await conn.query(
    `INSERT INTO subscription_history
       (id, clinic_id, subscription_id, from_status, to_status, reason, changed_by, source)
     VALUES (?, ?, ?, ?, 'INACTIVE', ?, ?, 'super_admin')`,
    [newId(), sub.clinic_id, sub.id, sub.status, `Manual deactivation: ${reason}`, actorId],
  );
  await notifyClinicOwner(conn, sub.clinic_id, "subscription_deactivated", {
    clinic_id: sub.clinic_id,
    message: reason,
  });
  const [after] = await conn.query<Row[]>(`SELECT * FROM clinic_subscriptions WHERE id = ?`, [sub.id]);
  return after[0];
}

export async function activateClinicManually(conn: PoolConnection, clinicId: string, actorId: string): Promise<Row> {
  const sub = await ensureClinicSubscription(conn, clinicId);
  if (String(sub.status) !== "INACTIVE") {
    throw conflict("CLINIC_NOT_DEACTIVATED", "Clinic is not manually deactivated. Use extend for more coverage.");
  }
  // Restore the honest underlying state; if everything lapsed it becomes EXPIRED
  // (still operationally restricted until a payment/extension lands).
  const restored: StoredSubscriptionStatus =
    sub.is_trial && toUtcMs(sub.trial_ends_at) > Date.now()
      ? "TRIAL"
      : !sub.is_trial && toUtcMs(sub.period_end) > Date.now()
        ? "ACTIVE"
        : "EXPIRED";
  await conn.query(
    `UPDATE clinic_subscriptions SET status = ?, deactivated_at = NULL, deactivated_by = NULL, deactivation_reason = NULL WHERE id = ?`,
    [restored, sub.id],
  );
  await conn.query(
    `INSERT INTO subscription_history
       (id, clinic_id, subscription_id, from_status, to_status, reason, changed_by, source)
     VALUES (?, ?, ?, 'INACTIVE', ?, 'Manual activation by super admin', ?, 'super_admin')`,
    [newId(), sub.clinic_id, sub.id, restored, actorId],
  );
  if (restored === "TRIAL" || restored === "ACTIVE") {
    await notifyClinicOwner(conn, sub.clinic_id, "subscription_activated", {
      clinic_id: sub.clinic_id,
      message: "Your clinic has been reactivated by the platform administrator.",
    });
  }
  const [after] = await conn.query<Row[]>(`SELECT * FROM clinic_subscriptions WHERE id = ?`, [sub.id]);
  return after[0];
}

export async function extendSubscription(
  conn: PoolConnection,
  clinicId: string,
  opts: { months?: number; trialDays?: number; reason: string },
  actorId: string,
): Promise<Row> {
  if (!opts.months && !opts.trialDays) {
    throw new ApiError(400, "EXTEND_TARGET_REQUIRED", "Provide months or trial_days to extend.", "months");
  }
  const sub = await ensureClinicSubscription(conn, clinicId);
  const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

  if (opts.months && opts.months > 0) {
    // Stack on top of whatever coverage currently remains (trial tail included).
    let baseMs = Date.now();
    for (const candidate of [toUtcMs(sub.period_end), toUtcMs(sub.trial_ends_at)]) {
      if (candidate > baseMs) baseMs = candidate;
    }
    const baseSql = new Date(baseMs).toISOString().slice(0, 19).replace("T", " ");
    await conn.query(
      `UPDATE clinic_subscriptions SET
          status = 'ACTIVE', is_trial = 0,
          period_start = ?, period_end = DATE_ADD(?, INTERVAL ? MONTH),
          deactivated_at = NULL, deactivated_by = NULL, deactivation_reason = NULL
        WHERE id = ?`,
      [baseSql, baseSql, opts.months, sub.id],
    );
  } else if (opts.trialDays && opts.trialDays > 0) {
    const currentTrial = toUtcMs(sub.trial_ends_at);
    const baseMs = currentTrial > Date.now() ? currentTrial : Date.now();
    const baseSql = new Date(baseMs).toISOString().slice(0, 19).replace("T", " ");
    await conn.query(
      `UPDATE clinic_subscriptions SET
          status = 'TRIAL', is_trial = 1,
          trial_started_at = COALESCE(trial_started_at, ?),
          trial_ends_at = DATE_ADD(?, INTERVAL ? DAY),
          period_end = DATE_ADD(?, INTERVAL ? DAY),
          deactivated_at = NULL, deactivated_by = NULL, deactivation_reason = NULL
        WHERE id = ?`,
      [nowSql(), baseSql, opts.trialDays, baseSql, opts.trialDays, sub.id],
    );
  }

  await conn.query(
    `INSERT INTO subscription_history
       (id, clinic_id, subscription_id, from_status, to_status, reason, changed_by, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'super_admin')`,
    [
      newId(),
      sub.clinic_id,
      sub.id,
      sub.status,
      opts.months ? "ACTIVE" : "TRIAL",
      `Extended by super admin (+${opts.months ? `${opts.months} month(s)` : `${opts.trialDays} trial day(s)`}): ${opts.reason}`,
      actorId,
    ],
  );
  await notifyClinicOwner(conn, sub.clinic_id, "subscription_activated", {
    clinic_id: sub.clinic_id,
    message: `Your clinic subscription was extended by the platform administrator.`,
  });
  const [after] = await conn.query<Row[]>(`SELECT * FROM clinic_subscriptions WHERE id = ?`, [sub.id]);
  return after[0];
}

// ---------------------------------------------------------------------------
// Scheduled processing (cron sweep)
// ---------------------------------------------------------------------------

export interface SweepResult {
  expiredTrials: number;
  expiredSubscriptions: number;
  expiringNotified: number;
}

async function notifyClinicOwner(
  conn: PoolConnection,
  clinicId: string,
  type: "subscription_expiring" | "subscription_expired" | "subscription_activated" | "subscription_deactivated",
  payload: Record<string, unknown>,
): Promise<void> {
  const [rows] = await conn.query<Row[]>(`SELECT owner_user_id FROM clinics WHERE id = ?`, [clinicId]);
  const ownerId = rows[0]?.owner_user_id;
  if (!ownerId) return;
  await conn.query(
    `INSERT INTO notifications (id, user_id, branch_id, type, payload_json) VALUES (?, ?, NULL, ?, ?)`,
    [newId(), ownerId, type, JSON.stringify(payload)],
  );
}

/**
 * Expires trials and paid subscriptions whose windows have ended and notifies owners
 * entering the expiring-warning window. Idempotent — safe to run on every tick.
 */
export async function processExpiredSubscriptions(poolDb: Pool): Promise<SweepResult> {
  const result: SweepResult = { expiredTrials: 0, expiredSubscriptions: 0, expiringNotified: 0 };
  const settings = await getPlatformSettings(poolDb);

  const expireExpired = async (where: string, kind: "trial" | "paid"): Promise<number> => {
    const [rows] = await poolDb.query<Row[]>(
      `SELECT cs.*, c.owner_user_id FROM clinic_subscriptions cs JOIN clinics c ON c.id = cs.clinic_id
        WHERE ${where} LIMIT 500`,
    );
    for (const sub of rows) {
      try {
        await runInPoolTransaction(poolDb, async (conn) => {
          const [locked] = await conn.query<Row[]>(
            `SELECT * FROM clinic_subscriptions WHERE id = ? AND status = ? FOR UPDATE`,
            [sub.id, sub.status],
          );
          if (!locked[0]) return;
          await conn.query(
            `UPDATE clinic_subscriptions SET status = 'EXPIRED' WHERE id = ?`,
            [sub.id],
          );
          await conn.query(
            `INSERT INTO subscription_history
               (id, clinic_id, subscription_id, from_status, to_status, reason, changed_by, source)
             VALUES (?, ?, ?, ?, 'EXPIRED', ?, NULL, 'system')`,
            [
              newId(),
              sub.clinic_id,
              sub.id,
              sub.status,
              kind === "trial" ? "Free trial period ended without payment." : "Paid subscription period ended without renewal.",
            ],
          );
          await notifyClinicOwner(conn, sub.clinic_id, "subscription_expired", {
            clinic_id: sub.clinic_id,
            message:
              kind === "trial"
                ? "Your free trial has ended. Pay the monthly subscription to keep your clinic active."
                : "Your subscription has expired. Renew to keep your clinic active.",
          });
          if (kind === "trial") result.expiredTrials += 1;
          else result.expiredSubscriptions += 1;
        });
      } catch {
        // One failing clinic must not block the sweep of the rest.
      }
    }
    return kind === "trial" ? result.expiredTrials : result.expiredSubscriptions;
  };

  await expireExpired(`cs.status = 'TRIAL' AND cs.trial_ends_at IS NOT NULL AND cs.trial_ends_at <= UTC_TIMESTAMP(3)`, "trial");
  await expireExpired(`cs.status = 'ACTIVE' AND cs.period_end <= UTC_TIMESTAMP(3)`, "paid");

  // Warn once per entry into the warning window (window entered within the last day).
  const warnDays = settings.expiring_warning_days;
  if (warnDays > 0) {
    const [soon] = await poolDb.query<Row[]>(
      `SELECT cs.*, c.owner_user_id FROM clinic_subscriptions cs JOIN clinics c ON c.id = cs.clinic_id
        WHERE cs.status IN ('TRIAL','ACTIVE')
          AND LEAST(COALESCE(cs.trial_ends_at, cs.period_end), cs.period_end) > UTC_TIMESTAMP(3)
          AND LEAST(COALESCE(cs.trial_ends_at, cs.period_end), cs.period_end)
              <= DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? DAY)
          AND LEAST(COALESCE(cs.trial_ends_at, cs.period_end), cs.period_end)
              > DATE_SUB(DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? DAY), INTERVAL 1 DAY)`,
      [warnDays, warnDays],
    );
    for (const sub of soon) {
      try {
        await runInPoolTransaction(poolDb, async (conn) => {
          await notifyClinicOwner(conn, sub.clinic_id, "subscription_expiring", {
            clinic_id: sub.clinic_id,
            message: "Your clinic subscription is about to expire. Renew to avoid interruption.",
          });
          result.expiringNotified += 1;
        });
      } catch {
        /* ignore */
      }
    }
  }

  return result;
}

let cronStarted = false;

/** Hourly in-process scheduler (started from instrumentation.ts). */
export function startSubscriptionCron(): void {
  if (cronStarted) return;
  cronStarted = true;
  const tick = async (): Promise<void> => {
    try {
      const { pool } = await import("@/lib/db");
      await processExpiredSubscriptions(pool);
    } catch {
      // Swallow — next tick retries. Never crash the server from the cron path.
    }
  };
  setTimeout(() => void tick(), 30_000).unref?.();
  setInterval(() => void tick(), 60 * 60 * 1000).unref?.();
}

async function runInPoolTransaction<T>(poolDb: Pool, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await poolDb.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
