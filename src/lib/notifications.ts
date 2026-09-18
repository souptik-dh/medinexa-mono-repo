import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { newId } from "@/lib/ids";
import { sendFcmToUser } from "@/lib/fcm";

export type NotificationType =
  | "new_booking"
  | "booking_confirmed"
  | "payment_received"
  | "consultation_completed"
  | "prescription_ready"
  | "doctor_invited"
  | "doctor_invite_accepted"
  | "appointment_cancelled"
  | "lab_test_booked"
  | "lab_test_approved"
  | "lab_test_rejected"
  | "lab_test_cancelled"
  | "lab_test_completed"
  | "lab_test_payment_success"
  | "subscription_expiring"
  | "subscription_expired"
  | "subscription_activated"
  | "subscription_deactivated"
  | "subscription_offer"
  | "patient_document_uploaded";

export async function createNotification(
  db: Pick<PoolConnection, "query">,
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown> = {},
  branchId: string | null = null,
): Promise<string> {
  const id = newId();
  await db.query(
    `INSERT INTO notifications (id, user_id, branch_id, type, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
    [id, userId, branchId, type, JSON.stringify(payload)],
  );
  return id;
}

export async function notifyBranchStaff(
  db: Pick<PoolConnection, "query">,
  branchId: string,
  type: NotificationType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT user_id FROM branch_staff WHERE branch_id = ?`,
    [branchId],
  );
  if (rows.length === 0) return;
  const payloadJson = JSON.stringify(payload);
  const values = rows.map((row) => [newId(), row.user_id, branchId, type, payloadJson]);
  await db.query(
    `INSERT INTO notifications (id, user_id, branch_id, type, payload_json) VALUES ?`,
    [values],
  );

  const content = pushContentForClinic(type, payload);
  await Promise.all(
    rows.map((row) =>
      sendFcmToUser(row.user_id as string, { title: content.title, body: content.body, data: { type } }, "clinic"),
    ),
  );
}

export interface PushMessage {
  title: string;
  body: string;
}

function withDoctor(name: unknown): string | null {
  return typeof name === "string" && name.trim().length > 0 ? `Dr. ${name}` : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function money(amount: unknown, currency: unknown): string | null {
  return typeof amount === "number" ? `${amount}${typeof currency === "string" ? ` ${currency}` : ""}` : null;
}

/** Maps an in-app notification type to a user-facing push title/body. */
export function pushContentFor(
  type: NotificationType,
  payload: Record<string, unknown> = {},
): PushMessage {
  const when = [payload.date, payload.time].filter(Boolean).join(" at ");
  const doctor = withDoctor(payload.doctor_name);
  const branch = asString(payload.branch_name);
  const doctorAt = [doctor, branch ? `at ${branch}` : null].filter(Boolean).join(" ");
  const testName = asString(payload.test_name);
  const apptNo = asString(payload.appointment_number);
  const apptNoSuffix = apptNo ? ` ${apptNo}` : "";
  const reasonSuffix = asString(payload.reason) ? ` Reason: ${payload.reason}` : "";
  switch (type) {
    case "booking_confirmed":
      return {
        title: "Appointment confirmed",
        body: doctor
          ? `Your appointment with ${doctorAt}${when ? ` on ${when}` : ""} has been confirmed.`
          : when
            ? `Your appointment for ${when} has been confirmed.`
            : "Your appointment has been confirmed.",
      };
    case "payment_received": {
      const amount = money(payload.amount, payload.currency);
      const method = asString(payload.method) ? ` via ${payload.method}` : "";
      return {
        title: "Payment received",
        body: amount
          ? `Payment of ${amount}${method} received for your appointment${doctor ? ` with ${doctorAt}` : ""}${when ? ` on ${when}` : ""}.`
          : `Payment for your appointment${when ? ` on ${when}` : ""} has been received.`,
      };
    }
    case "consultation_completed":
      return {
        title: "Consultation completed",
        body: doctor
          ? `Your consultation with ${doctorAt}${when ? ` on ${when}` : ""} is complete.`
          : `Your consultation${when ? ` on ${when}` : ""} is complete.`,
      };
    case "prescription_ready": {
      const excerpt = asString(payload.prescription_text);
      const snippet = excerpt ? truncate(excerpt.trim(), 200) : null;
      return {
        title: "Prescription ready",
        body: doctor
          ? `${doctor} has issued your prescription${snippet ? `: ${snippet}` : ""}.`
          : snippet
            ? `Your prescription is ready: ${snippet}`
            : "Your prescription is ready to view.",
      };
    }
    case "patient_document_uploaded": {
      const title = asString(payload.title);
      const description = asString(payload.description);
      const snippet = description ? truncate(description.trim(), 150) : null;
      return {
        title: "New document available",
        body: title
          ? `${title}${snippet ? ` — ${snippet}` : ""} is now available in Reports & Prescriptions.`
          : "A new document is now available in Reports & Prescriptions.",
      };
    }
    case "appointment_cancelled":
      return {
        title: "Appointment cancelled",
        body: doctor
          ? `Your appointment with ${doctorAt}${when ? ` on ${when}` : ""} has been cancelled.${reasonSuffix}`
          : `Your appointment${when ? ` on ${when}` : ""} has been cancelled.${reasonSuffix}`,
      };
    case "lab_test_booked":
      return {
        title: "Lab test booked",
        body: testName
          ? `Your lab test booking${apptNoSuffix} (${testName})${branch ? ` at ${branch}` : ""}${when ? ` for ${when}` : ""} has been submitted.`
          : when
            ? `Your lab test booking for ${when} has been submitted.`
            : "Your lab test booking has been submitted.",
      };
    case "lab_test_approved": {
      const precautions = Array.isArray(payload.precautions)
        ? payload.precautions.filter((p): p is string => typeof p === "string")
        : [];
      return {
        title: "Lab test confirmed",
        body: testName
          ? `Your lab test${apptNoSuffix} (${testName})${branch ? ` at ${branch}` : ""}${when ? ` on ${when}` : ""} has been confirmed.${precautions.length > 0 ? ` Precautions: ${precautions.join(", ")}` : ""}`
          : when
            ? `Your lab test appointment for ${when} has been confirmed.`
            : "Your lab test appointment has been confirmed.",
      };
    }
    case "lab_test_rejected":
      return {
        title: "Lab test booking rejected",
        body: testName
          ? `Your lab test booking${apptNoSuffix} (${testName}) has been rejected.${reasonSuffix}`
          : `Your lab test booking${when ? ` for ${when}` : ""} has been rejected.${reasonSuffix}`,
      };
    case "lab_test_cancelled":
      return {
        title: "Lab test cancelled",
        body: testName
          ? `Your lab test${apptNoSuffix} (${testName})${when ? ` on ${when}` : ""} has been cancelled.${reasonSuffix}`
          : `Your lab test appointment${when ? ` on ${when}` : ""} has been cancelled.${reasonSuffix}`,
      };
    case "lab_test_completed":
      return {
        title: "Lab test completed",
        body: testName
          ? `Your lab test${apptNoSuffix} (${testName}) has been completed. Your report is now available.`
          : `Your lab test${when ? ` on ${when}` : ""} has been completed.`,
      };
    case "lab_test_payment_success": {
      const amount = money(payload.amount, payload.currency);
      return {
        title: "Payment received",
        body: amount
          ? `Payment of ${amount} received for your lab test${testName ? ` (${testName})` : ""}${apptNoSuffix}.`
          : `Payment for your lab test${when ? ` on ${when}` : ""} has been received.`,
      };
    }
    case "subscription_expiring":
      return {
        title: "Subscription expiring soon",
        body:
          typeof payload.days_left === "number"
            ? `Your MediBook subscription expires in ${payload.days_left} day${payload.days_left === 1 ? "" : "s"}. Renew now to keep your clinic online.`
            : "Your MediBook subscription is expiring soon. Renew now to keep your clinic online.",
      };
    case "subscription_expired":
      return {
        title: "Subscription expired",
        body: "Your MediBook subscription has expired. Clinic operations are paused until you renew.",
      };
    case "subscription_activated":
      return {
        title: "Subscription active",
        body: typeof payload.period_end === "string"
          ? `Your MediBook subscription is active through ${String(payload.period_end).slice(0, 10)}.`
          : "Your MediBook subscription is active. Welcome aboard!",
      };
    case "subscription_deactivated":
      return {
        title: "Clinic deactivated",
        body: typeof payload.reason === "string" && payload.reason.length > 0
          ? `Your clinic has been deactivated by the platform: ${payload.reason}`
          : "Your clinic has been deactivated by the platform. Contact support for details.",
      };
    case "subscription_offer":
      return {
        title: "Special offer for your clinic",
        body:
          typeof payload.offer_price === "number" && typeof payload.currency === "string"
            ? `You've been offered ${payload.currency} ${payload.offer_price}/month${
                typeof payload.duration_months === "number" ? ` for ${payload.duration_months} month(s)` : ""
              }. Renew your subscription to use it.`
            : "You have a new subscription offer. Check your notifications for details.",
      };
    default:
      return {
        title: type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        body: typeof payload.message === "string" ? payload.message : "You have a new notification.",
      };
  }
}

/**
 * Creates the in-app notification AND delivers an FCM push to every device the
 * patient is registered on. Push failures never fail the underlying request.
 */
export async function createPatientNotification(
  db: Pick<PoolConnection, "query">,
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await createNotification(db, userId, type, payload);
  const content = pushContentFor(type, payload);
  await sendFcmToUser(userId, {
    title: content.title,
    body: content.body,
    data: { type, ...(typeof payload.appointment_id === "string" ? { appointment_id: payload.appointment_id } : {}) },
  });
}

/**
 * Maps an in-app notification type to a push title/body worded for the xclinic
 * (clinic-side) audience — staff, doctors, and clinic owners — as opposed to
 * `pushContentFor`, which is worded for the patient app.
 */
export function pushContentForClinic(
  type: NotificationType,
  payload: Record<string, unknown> = {},
): PushMessage {
  const when = [payload.date, payload.time].filter(Boolean).join(" at ");
  const visitor = asString(payload.visitor_name);
  const doctor = withDoctor(payload.doctor_name);
  const branch = asString(payload.branch_name);
  const testName = asString(payload.test_name);
  const apptNo = asString(payload.appointment_number);
  const apptNoSuffix = apptNo ? ` ${apptNo}` : "";
  const reasonSuffix = asString(payload.reason) ? ` Reason: ${payload.reason}` : "";
  switch (type) {
    case "new_booking":
      return {
        title: "New booking",
        body: visitor
          ? `${visitor} booked an appointment${doctor ? ` with ${doctor}` : ""}${branch ? ` at ${branch}` : ""}${when ? ` for ${when}` : ""}.`
          : `A new appointment was booked${when ? ` for ${when}` : ""}.`,
      };
    case "appointment_cancelled":
      return {
        title: "Appointment cancelled",
        body: visitor
          ? `${visitor}'s appointment${doctor ? ` with ${doctor}` : ""}${when ? ` on ${when}` : ""} has been cancelled.${reasonSuffix}`
          : `An appointment${when ? ` on ${when}` : ""} has been cancelled.${reasonSuffix}`,
      };
    case "lab_test_booked":
      return {
        title: "New lab test booking",
        body: visitor
          ? `${visitor} booked a lab test${testName ? ` (${testName})` : ""}${branch ? ` at ${branch}` : ""}${when ? ` for ${when}` : ""}.`
          : `A new lab test was booked${when ? ` for ${when}` : ""}.`,
      };
    case "lab_test_cancelled":
      return {
        title: "Lab test cancelled",
        body: visitor
          ? `${visitor}'s lab test${testName ? ` (${testName})` : ""}${when ? ` on ${when}` : ""} has been cancelled.${reasonSuffix}`
          : `A lab test${when ? ` on ${when}` : ""} has been cancelled.${reasonSuffix}`,
      };
    case "doctor_invite_accepted":
      return {
        title: "Invitation accepted",
        body: doctor ? `${doctor} has accepted your invitation.` : "A doctor has accepted your invitation.",
      };
    case "payment_received": {
      const amount = money(payload.amount, payload.currency);
      const method = asString(payload.method) ? ` via ${payload.method}` : "";
      return {
        title: "Payment received",
        body: amount
          ? `A payment of ${amount}${method} has been received${visitor ? ` from ${visitor}` : ""}${branch ? ` at ${branch}` : ""}.`
          : "A payment has been received.",
      };
    }
    case "lab_test_payment_success": {
      const amount = money(payload.amount, payload.currency);
      return {
        title: "Lab test payment received",
        body: amount
          ? `A payment of ${amount} has been received${visitor ? ` from ${visitor}` : ""} for lab test${testName ? ` (${testName})` : ""}${apptNoSuffix}.`
          : "A lab test payment has been received.",
      };
    }
    case "subscription_expiring":
    case "subscription_expired":
    case "subscription_activated":
    case "subscription_deactivated":
    case "subscription_offer":
      return pushContentFor(type, payload);
    default:
      return {
        title: type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        body: typeof payload.message === "string" ? payload.message : "You have a new notification.",
      };
  }
}

/**
 * Creates the in-app notification AND delivers an FCM push (xclinic app) to every
 * device the given clinic-side user (staff, doctor, or owner) is registered on.
 * Push failures never fail the underlying request.
 */
export async function createClinicUserNotification(
  db: Pick<PoolConnection, "query">,
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown> = {},
  branchId: string | null = null,
): Promise<string> {
  const id = await createNotification(db, userId, type, payload, branchId);
  const content = pushContentForClinic(type, payload);
  await sendFcmToUser(userId, { title: content.title, body: content.body, data: { type } }, "clinic");
  return id;
}

/**
 * Creates the in-app notification AND delivers an FCM push (xclinic app) to both
 * audiences on the clinic side of an event: every branch_staff member at the
 * branch, and the clinic owner. Use this (instead of calling `notifyBranchStaff`
 * alone) for anything a patient triggers that the clinic needs to act on or track
 * (cancellations, payments, etc.) — without it, the owner silently never learns
 * about the event unless they also happen to be registered as branch staff.
 */
export async function notifyClinicSide(
  db: Pick<PoolConnection, "query">,
  branchId: string,
  clinicId: string,
  type: NotificationType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const owner = await clinicOwnerContact(db, clinicId);
  await Promise.all([
    notifyBranchStaff(db, branchId, type, payload),
    owner ? createClinicUserNotification(db, owner.userId, type, payload, branchId) : Promise.resolve(),
  ]);
}

/**
 * Emails for everyone tied to a branch: its staff and the owning clinic's
 * owner. The UNION dedupes in case the same address appears in both roles.
 */
export async function branchContactEmails(
  db: Pick<PoolConnection, "query">,
  branchId: string,
): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT u.email FROM branch_staff bs JOIN users u ON u.id = bs.user_id WHERE bs.branch_id = ?
     UNION
     SELECT co.email FROM branches b JOIN clinics c ON c.id = b.clinic_id JOIN users co ON co.id = c.owner_user_id WHERE b.id = ?`,
    [branchId, branchId],
  );
  // Staff/owner accounts without an email on file come back as a null row from the
  // UNION — drop them here rather than handing callers a `null` to pass to sendEmail.
  return rows.map((r) => r.email as string | null).filter((email): email is string => Boolean(email));
}

export async function branchContactPhones(
  db: Pick<PoolConnection, "query">,
  branchId: string,
): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT u.phone FROM branch_staff bs JOIN users u ON u.id = bs.user_id WHERE bs.branch_id = ? AND u.phone IS NOT NULL
     UNION
     SELECT co.phone FROM branches b JOIN clinics c ON c.id = b.clinic_id JOIN users co ON co.id = c.owner_user_id WHERE b.id = ? AND co.phone IS NOT NULL`,
    [branchId, branchId],
  );
  return rows.map((r) => r.phone as string);
}

export async function clinicOwnerContact(
  db: Pick<PoolConnection, "query">,
  clinicId: string,
): Promise<{ userId: string; email: string } | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT co.id AS user_id, co.email
       FROM clinics c JOIN users co ON co.id = c.owner_user_id
      WHERE c.id = ?`,
    [clinicId],
  );
  const row = rows[0];
  return row ? { userId: row.user_id as string, email: row.email as string } : null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BRAND_GRADIENT = "linear-gradient(135deg, #7C3AED 0%, #00C6FF 100%)";
const BUTTON_GRADIENT = "linear-gradient(135deg, #7C3AED 0%, #2563EB 100%)";
const BRAND_PURPLE = "#6D28D9";

/**
 * Turns plain text into email-safe HTML. A line that is nothing but a URL is
 * rendered as a prominent CTA button (with the raw link kept underneath as a
 * fallback); URLs embedded inline stay as plain anchors.
 */
function textToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (/^https?:\/\/\S+$/.test(trimmed)) {
        const url = escapeHtml(trimmed);
        return `<div style="margin:8px 0 16px;">
<a href="${url}" target="_blank" style="background:${BUTTON_GRADIENT};color:#ffffff;padding:14px 28px;text-decoration:none;font-size:15px;font-weight:600;border-radius:8px;display:inline-block;box-shadow:0 4px 12px rgba(124,58,237,0.3);">Continue</a>
</div>
<p style="color:#94a3b8;font-size:12px;word-break:break-all;margin:0 0 16px;">${url}</p>`;
      }
      if (trimmed === "") return "";
      return line
        .split(/(https?:\/\/\S+)/g)
        .map((part) =>
          /^https?:\/\//.test(part)
            ? `<a href="${escapeHtml(part)}" style="color:${BRAND_PURPLE};">${escapeHtml(part)}</a>`
            : escapeHtml(part),
        )
        .join("");
    })
    .join("<br/>\n");
}

function emailShell(imgTag: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Jido Healthcare</title></head>
<body style="margin:0;padding:0;background-color:#f4f6f9;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout:fixed;">
<tr><td align="center" style="padding:40px 10px;">
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:540px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.08);">
<tr>
<td align="center" style="background:${BRAND_GRADIENT};padding:36px 20px;">
${imgTag}
<h1 style="color:#ffffff;font-size:22px;margin:12px 0 0;font-weight:700;letter-spacing:-0.5px;">Jido Healthcare</h1>
</td>
</tr>
<tr><td style="padding:40px 30px;text-align:center;color:#333333;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
<tr>
<td style="background-color:#f8fafc;padding:20px;text-align:center;border-top:1px solid #f1f5f9;">
<p style="color:#94a3b8;font-size:12px;margin:0;">&copy; ${new Date().getFullYear()} Jido Healthcare. All rights reserved.</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// Hosted on Cloudinary (not APP_URL) so the logo renders in emails even if
// the app deployment is down or hasn't served /public assets yet.
const APP_ICON_URL =
  process.env.EMAIL_APP_ICON_URL ??
  "https://res.cloudinary.com/p274ocjz/image/upload/v1787035848/medinexa/email-app-icon.png";

function appIconImg(): string {
  return `<img src="${APP_ICON_URL}" alt="Jido Healthcare" width="64" height="64" style="display:block;margin:0 auto;border:0;border-radius:14px;box-shadow:0 4px 10px rgba(0,0,0,0.15);"/>`;
}

/** Branded HTML email with the centered app icon as the logo. */
export function emailHtml(body: string): string {
  return emailShell(appIconImg(), textToHtml(body));
}

/** Branded HTML email for a login OTP, with the code rendered large and bold in a dashed box. */
export function otpEmailHtml(otp: string, expiryMinutes: number): string {
  const body = `
<h2 style="color:#1e293b;font-size:20px;margin:0 0 12px;font-weight:600;">Verification Code</h2>
<p style="color:#64748b;font-size:15px;margin:0 0 28px;line-height:1.5;">Use the one-time code below to complete your login to Jido Healthcare.</p>
<div style="background-color:#f8fafc;border:2px dashed #cbd5e1;border-radius:12px;padding:20px;display:inline-block;margin:0 0 25px;">
<span style="font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:800;letter-spacing:8px;color:${BRAND_PURPLE};">${escapeHtml(otp)}</span>
</div>
<p style="color:#94a3b8;font-size:13px;margin:0;">This code expires in ${expiryMinutes} minutes. Do not share this code with anyone.</p>`;
  return emailShell(appIconImg(), body);
}

/** Branded HTML email with the centered app icon (patient recipients). */
export function patientEmailHtml(body: string): string {
  return emailShell(appIconImg(), textToHtml(body));
}

/**
 * Branded HTML email for an invitation that carries both a one-time code and
 * an accept link (e.g. doctor invites): code shown in a dashed box, followed
 * by a CTA button, with the raw link kept as a fallback underneath.
 */
export function inviteEmailHtml(opts: {
  heading: string;
  intro: string;
  code: string;
  codeLabel: string;
  ctaLabel: string;
  ctaUrl: string;
  note?: string;
}): string {
  const body = `
<h2 style="color:#1e293b;font-size:20px;margin:0 0 16px;font-weight:600;">${escapeHtml(opts.heading)}</h2>
<p style="color:#475569;font-size:15px;margin:0 0 24px;line-height:1.6;">${escapeHtml(opts.intro)}</p>
<div style="background-color:#f8fafc;border:2px dashed #cbd5e1;border-radius:12px;padding:18px;display:inline-block;margin:0 0 28px;">
<p style="color:#64748b;font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">${escapeHtml(opts.codeLabel)}</p>
<span style="font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:800;letter-spacing:6px;color:${BRAND_PURPLE};">${escapeHtml(opts.code)}</span>
</div>
<div style="margin:0 0 30px;">
<a href="${escapeHtml(opts.ctaUrl)}" target="_blank" style="background:${BUTTON_GRADIENT};color:#ffffff;padding:14px 28px;text-decoration:none;font-size:15px;font-weight:600;border-radius:8px;display:inline-block;box-shadow:0 4px 12px rgba(124,58,237,0.3);">${escapeHtml(opts.ctaLabel)}</a>
</div>
${opts.note ? `<p style="color:#94a3b8;font-size:13px;margin:0 0 20px;">${escapeHtml(opts.note)}</p>` : ""}
<hr style="border:0;border-top:1px solid #e2e8f0;margin:25px 0;"/>
<p style="color:#94a3b8;font-size:12px;margin:0 0 8px;line-height:1.4;">If the button doesn't work, copy and paste this link into your browser:</p>
<p style="color:${BRAND_PURPLE};font-size:12px;word-break:break-all;margin:0;">${escapeHtml(opts.ctaUrl)}</p>`;
  return emailShell(appIconImg(), body);
}

/**
 * Branded HTML email for structured details (a new booking, a payment, a
 * confirmed appointment): each row gets a label, a bold value, and an
 * optional sub-line, laid out in a bordered card.
 */
export function detailsEmailHtml(opts: {
  heading: string;
  intro?: string;
  rows: Array<{ label: string; value: string; sub?: string }>;
  note?: string;
  patientFacing?: boolean;
}): string {
  const rowsHtml = opts.rows
    .map(
      (row, i) => `<tr>
<td style="padding:${i === 0 ? "0" : "12px"} 0 12px 0;${i < opts.rows.length - 1 ? "border-bottom:1px solid #e2e8f0;" : ""}">
<span style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${escapeHtml(row.label)}</span>
<p style="font-size:15px;color:#1e293b;font-weight:700;margin:4px 0 0;">${escapeHtml(row.value)}</p>
${row.sub ? `<p style="font-size:13px;color:#64748b;margin:2px 0 0;">${escapeHtml(row.sub)}</p>` : ""}
</td>
</tr>`,
    )
    .join("");
  const body = `
<h2 style="color:#1e293b;font-size:20px;margin:0 0 8px;font-weight:600;">${escapeHtml(opts.heading)}</h2>
${opts.intro ? `<p style="color:#64748b;font-size:14px;margin:0 0 24px;">${escapeHtml(opts.intro)}</p>` : ""}
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:24px;">
<tr><td style="padding:20px;text-align:left;">
<table border="0" cellpadding="0" cellspacing="0" width="100%">${rowsHtml}</table>
</td></tr>
</table>
${opts.note ? `<p style="color:#94a3b8;font-size:12px;margin:0;line-height:1.5;">${escapeHtml(opts.note)}</p>` : ""}`;
  return emailShell(appIconImg(), body);
}

/**
 * Branded HTML email acknowledging that a doctor has been added to a new branch
 * within the same clinic (no invitation flow needed).
 */
export function branchAccessEmailHtml(opts: {
  doctorName: string;
  branchName: string;
  clinicName: string;
}): string {
  const body = `
<h2 style="color:#1e293b;font-size:20px;margin:0 0 16px;font-weight:600;">You've been added to a new branch</h2>
<p style="color:#475569;font-size:15px;margin:0 0 24px;line-height:1.6;">Hi Dr. ${escapeHtml(opts.doctorName)},</p>
<p style="color:#475569;font-size:15px;margin:0 0 24px;line-height:1.6;">
You have been successfully added to <strong>${escapeHtml(opts.branchName)}</strong> under <strong>${escapeHtml(opts.clinicName)}</strong>.
</p>
<p style="color:#475569;font-size:15px;margin:0 0 24px;line-height:1.6;">
You can now manage your schedule and appointments at this branch using your existing MediBook account. No further action is required.
</p>
<p style="color:#94a3b8;font-size:13px;margin:0;">If you have any questions, please contact the clinic administrator.</p>`;
  return emailShell(appIconImg(), body);
}

/**
 * Sends email through the Brevo SMTP API (credentials in .env). Falls back to
 * a console log in local dev when BREVO_API_KEY is not configured. Never logs
 * the API key.
 */
/**
 * Returns whether the send actually succeeded (or was stubbed, in local dev with no
 * BREVO_API_KEY — treated as success since nothing failed). Existing callers that
 * predate this return value simply ignore it, unaffected; callers that need to know
 * whether delivery succeeded (e.g. recording a DELIVERED/NOT_DELIVERED outcome) can
 * now `await` it.
 */
export interface EmailAttachment {
  filename: string;
  data: Buffer;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  html?: string,
  attachments?: EmailAttachment[],
): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log(`[email:stub] to=${to} subject=${subject}\n${body}`);
    return true;
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL ?? "noreply@jidohealthcare.app";
  const senderName = process.env.BREVO_SENDER_NAME ?? "JidoHealthcare";
  const htmlContent = html ?? textToHtml(body);

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: to }],
        subject,
        htmlContent,
        ...(attachments?.length
          ? {
              attachment: attachments.map((a) => ({
                name: a.filename,
                content: a.data.toString("base64"),
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[email] Brevo rejected send to ${to} (${res.status}): ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[email] send to ${to} failed:`, err);
    return false;
  }
}

/**
 * SMS delivery through the Jido SMS Gateway (credentials in .env via
 * SMS_API_KEY, an optional SMS_API_URL override). Falls back to a console log
 * in local dev when SMS_API_KEY is not configured. Never throws.
 *
 * Not exported. Policy: SMS is reserved for OTP/confirmation codes and doctor
 * invitations — every other notification (to patients, clinic owners, doctors,
 * and branch staff alike) goes out over WhatsApp + email + push only, with no
 * SMS fallback if those fail. This is the one place that can reach the SMS
 * gateway, so keeping it unexported is what actually enforces the policy —
 * route handlers can't call it even by accident. The only callers are
 * `sendOtpSms`/`sendOtpDual` (OTP) and `sendInviteDual` (doctor invites) below.
 */
async function sendSms(to: string, body: string): Promise<void> {
  const apiKey = process.env.SMS_API_KEY;
  const apiUrl =
    process.env.SMS_API_URL ??
    "https://jido-sms-gateway.onrender.com/api/3rdparty/v1/messages";
  if (!apiKey) {
    console.log(`[sms:stub] to=${to} body=${body}`);
    return;
  }
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${apiKey}`,
      },
      body: JSON.stringify({
        textMessage: { text: body },
        phoneNumbers: [to],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[sms] Gateway rejected send to ${to} (${res.status}): ${detail}`);
    }
  } catch (err) {
    console.error(`[sms] send to ${to} failed:`, err);
  }
}

/**
 * WhatsApp delivery through a local WAHA instance (see whatsapp.md). Configured via
 * WAHA_BASE_URL (default http://localhost:3000), WAHA_API_KEY, and WAHA_SESSION
 * (default "default"). Falls back to a console log in local dev when WAHA_API_KEY
 * is not configured. Never throws.
 */
async function wahaSessionStatus(baseUrl: string, apiKey: string, session: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/sessions/${session}`, {
      headers: { "X-Api-Key": apiKey },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { status?: string };
    return data.status ?? null;
  } catch {
    return null;
  }
}

async function wahaPost(baseUrl: string, apiKey: string, path: string, payload: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify(payload),
  });
}

const WAHA_RECOVERY_POLL_MS = 30_000;
const WAHA_RECOVERY_MAX_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

const WAHA_AUTH_REQUIRED_STATUSES = new Set([
  "SCAN_QR_CODE",
  "PASSKEY_REQUIRED",
  "PASSKEY_CONFIRMATION_REQUIRED",
]);

const WAHA_ADMIN_ALERT_EMAIL = process.env.WAHA_ADMIN_ALERT_EMAIL ?? "souptikdhar4@gmail.com";

// Guards against every message that fails during an outage spawning its own
// polling loop against WAHA — only one recovery run per session at a time.
const wahaRecoveryInFlight = new Set<string>();

/**
 * A WAHA session can drop out of WORKING (phone unlinked, WAHA process restarted
 * without persisted auth, session logged out by WhatsApp, etc), at which point a
 * send endpoint answers 404 (session doesn't exist) or 422 (session exists but
 * isn't WORKING). Restarts the session once, then watches it for up to 2 hours —
 * long enough for someone to notice and scan a fresh QR code — and retries the
 * original send the moment it reports WORKING again, so a dropped session heals
 * itself instead of silently losing every message until someone notices.
 * `sendPath`/`payload` are the exact endpoint and body to retry (e.g.
 * /api/sendText or /api/sendFile). Runs detached from the triggering request —
 * never blocks or throws.
 */
async function recoverWahaSessionAndRetry(
  baseUrl: string,
  apiKey: string,
  session: string,
  sendPath: string,
  payload: unknown,
): Promise<void> {
  if (wahaRecoveryInFlight.has(session)) return;
  wahaRecoveryInFlight.add(session);
  try {
    await runWahaSessionRecovery(baseUrl, apiKey, session, sendPath, payload);
  } finally {
    wahaRecoveryInFlight.delete(session);
  }
}

async function runWahaSessionRecovery(
  baseUrl: string,
  apiKey: string,
  session: string,
  sendPath: string,
  payload: unknown,
): Promise<void> {
  const status = await wahaSessionStatus(baseUrl, apiKey, session);
  try {
    if (status === null) {
      await wahaPost(baseUrl, apiKey, "/api/sessions", { name: session, start: true });
    } else if (status !== "WORKING") {
      await wahaPost(baseUrl, apiKey, `/api/sessions/${session}/restart`, {});
    }
  } catch (err) {
    console.error(`[whatsapp] session recovery request for "${session}" failed:`, err);
    return;
  }

  let loggedAuthRequired = false;
  const deadline = Date.now() + WAHA_RECOVERY_MAX_DURATION_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WAHA_RECOVERY_POLL_MS));
    const current = await wahaSessionStatus(baseUrl, apiKey, session);
    if (current === "WORKING") {
      const res = await wahaPost(baseUrl, apiKey, sendPath, payload).catch(() => null);
      if (!res || !res.ok) {
        console.error(`[whatsapp] retry after session recovery still failed for session "${session}".`);
      }
      return;
    }
    // These need a human to scan a fresh QR code (or approve a passkey) — restarting
    // again won't help, but keep watching (instead of giving up) so delivery resumes
    // on its own the moment someone re-authenticates.
    if (current !== null && WAHA_AUTH_REQUIRED_STATUSES.has(current) && !loggedAuthRequired) {
      loggedAuthRequired = true;
      console.error(
        `[whatsapp] session "${session}" needs re-authentication (status=${current}) — scan a fresh QR code to restore WhatsApp delivery. Watching for up to 2 hours.`,
      );
      await sendEmail(
        WAHA_ADMIN_ALERT_EMAIL,
        `WhatsApp session "${session}" needs re-authentication`,
        `The WAHA session "${session}" dropped to status ${current} and needs a fresh QR code scan (WhatsApp → Linked Devices) to restore WhatsApp delivery.\n\nMessages are queued to retry automatically once the session is back to WORKING, but only for up to 2 hours from now — please rescan soon.`,
      );
    }
  }
  console.error(`[whatsapp] session "${session}" did not recover to WORKING within 2 hours.`);
}

export async function sendWhatsapp(to: string, body: string): Promise<void> {
  const apiKey = process.env.WAHA_API_KEY;
  const baseUrl = process.env.WAHA_BASE_URL ?? "http://localhost:3000";
  const session = process.env.WAHA_SESSION ?? "default";
  if (!apiKey) {
    console.log(`[whatsapp:stub] to=${to} body=${body}`);
    return;
  }
  const chatId = `${to.replace(/\D/g, "")}@c.us`;
  const payload = { session, chatId, text: body };
  try {
    const res = await wahaPost(baseUrl, apiKey, "/api/sendText", payload);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[whatsapp] WAHA rejected send to ${to} (${res.status}): ${detail}`);
      // Session expired/missing — recreate or restart it and retry in the background
      // rather than losing the message silently.
      if (res.status === 404 || res.status === 422) {
        void recoverWahaSessionAndRetry(baseUrl, apiKey, session, "/api/sendText", payload);
      }
    }
  } catch (err) {
    console.error(`[whatsapp] send to ${to} failed:`, err);
  }
}

/**
 * Sends a document (e.g. a receipt PDF) as a WhatsApp file attachment through WAHA's
 * /api/sendFile. `data` is the raw file bytes — base64-encoded here, not by the caller.
 * Same config/stub/recovery behavior as sendWhatsapp. Never throws.
 */
export async function sendWhatsappFile(
  to: string,
  file: { filename: string; mimetype: string; data: Buffer },
  caption?: string,
): Promise<void> {
  const apiKey = process.env.WAHA_API_KEY;
  const baseUrl = process.env.WAHA_BASE_URL ?? "http://localhost:3000";
  const session = process.env.WAHA_SESSION ?? "default";
  if (!apiKey) {
    console.log(`[whatsapp:stub] to=${to} file=${file.filename}`);
    return;
  }
  const chatId = `${to.replace(/\D/g, "")}@c.us`;
  const payload = {
    session,
    chatId,
    file: { mimetype: file.mimetype, filename: file.filename, data: file.data.toString("base64") },
    caption,
  };
  try {
    const res = await wahaPost(baseUrl, apiKey, "/api/sendFile", payload);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[whatsapp] WAHA rejected file send to ${to} (${res.status}): ${detail}`);
      if (res.status === 404 || res.status === 422) {
        void recoverWahaSessionAndRetry(baseUrl, apiKey, session, "/api/sendFile", payload);
      }
    }
  } catch (err) {
    console.error(`[whatsapp] file send to ${to} failed:`, err);
  }
}

/** Sends the same message to every phone number over WhatsApp. */
export async function notifyPhonesWhatsapp(phones: string[], text: string): Promise<void> {
  await Promise.all(phones.map((phone) => sendWhatsapp(phone, text)));
}

/**
 * Builds a "Jido Healthcare: ..." patient message, addressing the visiting patient by name
 * when a clinic/staff booking was made on someone else's behalf
 * (appointment_patients.relationship !== "self"), e.g. "Dear Priya, your appointment...".
 * Self-bookings (and rows predating appointment_patients) get the plain, unaddressed text.
 * `body` must NOT include the "Jido Healthcare: " prefix — this adds it.
 */
export function personalizeForPatient(
  body: string,
  visitorName: string | null | undefined,
  visitorRelationship: string | null | undefined,
): string {
  const isForSelf = !visitorRelationship || visitorRelationship === "self";
  const greeted =
    isForSelf || !visitorName ? body : `Dear ${visitorName}, ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  return `Jido Healthcare: ${greeted}`;
}

/** Sends a one-time login/password code via SMS. */
export async function sendOtpSms(
  phone: string,
  otp: string,
  expiryMinutes: number,
): Promise<void> {
  await sendSms(
    phone,
    `Your Jido Healthcare confirmation code is ${otp}. It expires in ${expiryMinutes} minutes. Do not share this code with anyone.`,
  );
}

/** Sends a one-time login/password code via WhatsApp. */
export async function sendOtpWhatsapp(
  phone: string,
  otp: string,
  expiryMinutes: number,
): Promise<void> {
  await sendWhatsapp(
    phone,
    `Your Jido Healthcare confirmation code is ${otp}. It expires in ${expiryMinutes} minutes. Do not share this code with anyone.`,
  );
}

/**
 * Sends a one-time code via SMS, email (if an email is on file), and WhatsApp.
 * Failures never reject the caller.
 */
export async function sendOtpDual(opts: {
  phone: string;
  email?: string | null;
  otp: string;
  expiryMinutes: number;
}): Promise<void> {
  const smsPromise = sendOtpSms(opts.phone, opts.otp, opts.expiryMinutes);
  const whatsappPromise = sendOtpWhatsapp(opts.phone, opts.otp, opts.expiryMinutes);
  const emailPromise = opts.email
    ? sendEmail(
        opts.email,
        "Your Jido Healthcare login code",
        `Your one-time login code is ${opts.otp}. It expires in ${opts.expiryMinutes} minutes. Do not share this code with anyone.`,
        otpEmailHtml(opts.otp, opts.expiryMinutes),
      )
    : Promise.resolve();
  await Promise.allSettled([smsPromise, whatsappPromise, emailPromise]);
}

/**
 * Sends a doctor invitation link via SMS + WhatsApp (email is sent separately by the
 * caller, since it also carries the branded invite card). Doctor invitations are the
 * one non-OTP flow allowed to use SMS.
 */
export async function sendInviteDual(opts: {
  phone: string;
  doctorName: string;
  clinicName: string;
  inviteUrl: string;
}): Promise<void> {
  const text = `Dr. ${opts.doctorName}, you have been invited to join ${opts.clinicName} on MediBook. Accept your invitation here: ${opts.inviteUrl}`;
  await Promise.allSettled([sendSms(opts.phone, text), sendWhatsapp(opts.phone, text)]);
}
