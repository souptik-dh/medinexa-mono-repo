import { z } from "zod";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "@/lib/db";
import { idSchema, currencySchema } from "@/lib/validators";
import { sendSms, sendWhatsapp, sendEmail, detailsEmailHtml, createNotification } from "@/lib/notifications";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Input schema — shared by the preview and create routes so their request
// bodies (and therefore the rendered preview) stay identical.
// ---------------------------------------------------------------------------

export const offerChannelsSchema = z
  .object({
    sms: z.boolean().default(true),
    whatsapp: z.boolean().default(true),
    email: z.boolean().default(true),
    portal: z.boolean().default(true),
  })
  .default({ sms: true, whatsapp: true, email: true, portal: true });

export const offerInputSchema = z.object({
  clinic_ids: z.array(idSchema).min(1, "Select at least one clinic.").max(500),
  title: z.string().trim().min(1).max(150),
  message: z.string().trim().min(1).max(1000),
  discounted_amount: z.coerce.number().positive("Amount must be greater than zero.").max(1_000_000),
  currency: currencySchema.default("INR"),
  duration_months: z.coerce.number().int().min(1).max(24),
  valid_until: z.coerce.date().refine((d) => d.getTime() > Date.now(), "valid_until must be in the future."),
  channels: offerChannelsSchema,
});

export type OfferInput = z.infer<typeof offerInputSchema>;
export type OfferChannels = z.infer<typeof offerChannelsSchema>;
export type ChannelPlan = "will_send" | "skipped_no_phone" | "skipped_no_email" | "disabled";

// ---------------------------------------------------------------------------
// Message rendering — identical in preview and actual send.
// ---------------------------------------------------------------------------

export interface OfferMessageContext {
  clinicName: string;
  regularAmount: number;
  offerAmount: number;
  currency: string;
  durationMonths: number;
  validUntil: Date;
}

export function renderOfferMessage(template: string, ctx: OfferMessageContext): string {
  return template
    .replaceAll("{{clinic_name}}", ctx.clinicName)
    .replaceAll("{{regular_price}}", ctx.regularAmount.toFixed(2))
    .replaceAll("{{offer_price}}", ctx.offerAmount.toFixed(2))
    .replaceAll("{{currency}}", ctx.currency)
    .replaceAll("{{duration_months}}", String(ctx.durationMonths))
    .replaceAll("{{valid_until}}", ctx.validUntil.toISOString().slice(0, 10));
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

export interface ResolvedRecipient {
  clinicId: string;
  clinicName: string;
  ownerUserId: string;
  ownerEmail: string | null;
  ownerPhone: string | null;
}

/** Loads clinic name + owner contact for a batch of clinic ids, keyed by clinic id. */
export async function loadClinicContacts(
  db: Db,
  clinicIds: string[],
): Promise<Map<string, ResolvedRecipient>> {
  const map = new Map<string, ResolvedRecipient>();
  if (clinicIds.length === 0) return map;
  const [rows] = await db.query<Row[]>(
    `SELECT c.id AS clinic_id, c.name AS clinic_name,
            u.id AS owner_user_id, u.email AS owner_email, u.phone AS owner_phone
       FROM clinics c JOIN users u ON u.id = c.owner_user_id
      WHERE c.id IN (?) AND c.deleted_at IS NULL`,
    [clinicIds],
  );
  for (const r of rows) {
    map.set(String(r.clinic_id), {
      clinicId: String(r.clinic_id),
      clinicName: String(r.clinic_name),
      ownerUserId: String(r.owner_user_id),
      ownerEmail: r.owner_email ? String(r.owner_email) : null,
      ownerPhone: r.owner_phone ? String(r.owner_phone) : null,
    });
  }
  return map;
}

/** Per-channel dry-run plan for the preview step: what will actually be sent vs. skipped. */
export function planChannelDelivery(
  channels: OfferChannels,
  contact: Pick<ResolvedRecipient, "ownerEmail" | "ownerPhone">,
): { sms: ChannelPlan; whatsapp: ChannelPlan; email: ChannelPlan; portal: ChannelPlan } {
  return {
    sms: !channels.sms ? "disabled" : contact.ownerPhone ? "will_send" : "skipped_no_phone",
    whatsapp: !channels.whatsapp ? "disabled" : contact.ownerPhone ? "will_send" : "skipped_no_phone",
    email: !channels.email ? "disabled" : contact.ownerEmail ? "will_send" : "skipped_no_email",
    portal: channels.portal ? "will_send" : "disabled",
  };
}

// ---------------------------------------------------------------------------
// Auto-apply lookup, used by initiateSubscriptionPayment
// ---------------------------------------------------------------------------

export interface ActiveClinicOffer {
  offerId: string;
  recipientId: string;
  title: string;
  messageTemplate: string;
  discountedAmount: number;
  currency: string;
  durationMonths: number;
  validUntil: Date;
  monthsRemaining: number;
}

/**
 * The earliest still-usable offer for a clinic (oldest first, so an older
 * campaign is consumed before a newer one). "Usable" is computed live —
 * offer.status = 'ACTIVE', not past valid_until, and months still unredeemed
 * — nothing is mutated by a background sweep.
 */
export async function getActiveOfferForClinic(db: Db, clinicId: string): Promise<ActiveClinicOffer | null> {
  const [rows] = await db.query<Row[]>(
    `SELECT o.id AS offer_id, r.id AS recipient_id, o.title, o.message,
            o.discounted_amount, o.currency, o.duration_months, o.valid_until, r.months_remaining
       FROM subscription_offer_recipients r
       JOIN subscription_offers o ON o.id = r.offer_id
      WHERE r.clinic_id = ? AND o.status = 'ACTIVE'
        AND o.valid_until >= UTC_TIMESTAMP(3) AND r.months_remaining > 0
      ORDER BY r.created_at ASC LIMIT 1`,
    [clinicId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    offerId: String(row.offer_id),
    recipientId: String(row.recipient_id),
    title: String(row.title),
    messageTemplate: String(row.message),
    discountedAmount: Number(row.discounted_amount),
    currency: String(row.currency),
    durationMonths: Number(row.duration_months),
    validUntil: new Date(row.valid_until),
    monthsRemaining: Number(row.months_remaining),
  };
}

/**
 * Blends the offered price for as many months as remain on the offer with the
 * regular plan price for any months beyond that, e.g. paying for 5 months
 * with only 3 discounted months left charges 3 at the offer rate + 2 at plan rate.
 */
export function computeDiscountedAmount(
  planAmount: number,
  offer: ActiveClinicOffer,
  months: number,
): { amount: number; discountedMonths: number } {
  const discountedMonths = Math.min(offer.monthsRemaining, months);
  const regularMonths = months - discountedMonths;
  const amount = round2(offer.discountedAmount * discountedMonths + planAmount * regularMonths);
  return { amount, discountedMonths };
}

/** Consumes `discountedMonths` off the recipient's remaining balance. Called from applyPaidPayment. */
export async function redeemOfferOnPayment(
  conn: PoolConnection,
  offerRecipientId: string,
  discountedMonths: number,
): Promise<void> {
  const [rows] = await conn.query<Row[]>(
    `SELECT months_remaining FROM subscription_offer_recipients WHERE id = ? FOR UPDATE`,
    [offerRecipientId],
  );
  const recipient = rows[0];
  if (!recipient) return;
  const remaining = Math.max(0, Number(recipient.months_remaining) - discountedMonths);
  await conn.query(
    `UPDATE subscription_offer_recipients
        SET months_remaining = ?, status = 'REDEEMED', redeemed_at = COALESCE(redeemed_at, UTC_TIMESTAMP(3))
      WHERE id = ?`,
    [remaining, offerRecipientId],
  );
}

// ---------------------------------------------------------------------------
// Dispatch — SMS / WhatsApp / Email (if on file) / portal popup
// ---------------------------------------------------------------------------

export type ChannelDeliveryStatus = "SENT" | "SKIPPED" | "FAILED";

export interface OfferDeliveryResult {
  sms: ChannelDeliveryStatus;
  whatsapp: ChannelDeliveryStatus;
  email: ChannelDeliveryStatus;
  portalNotificationId: string | null;
}

/**
 * Sends one offer to one clinic across every requested channel. Every channel
 * is best-effort (Promise.allSettled-style — one channel failing never blocks
 * the others), mirroring sendOtpDual in notifications.ts. Never throws.
 */
export async function sendOfferToClinic(opts: {
  channels: OfferChannels;
  contact: ResolvedRecipient;
  renderedMessage: string;
  offer: {
    title: string;
    discountedAmount: number;
    currency: string;
    durationMonths: number;
    validUntil: Date;
  };
  regularAmount: number;
}): Promise<OfferDeliveryResult> {
  const { channels, contact, renderedMessage, offer, regularAmount } = opts;

  const smsPromise: Promise<ChannelDeliveryStatus> =
    channels.sms && contact.ownerPhone
      ? sendSms(contact.ownerPhone, renderedMessage)
          .then(() => "SENT" as const)
          .catch(() => "FAILED" as const)
      : Promise.resolve("SKIPPED" as const);

  const whatsappPromise: Promise<ChannelDeliveryStatus> =
    channels.whatsapp && contact.ownerPhone
      ? sendWhatsapp(contact.ownerPhone, renderedMessage)
          .then(() => "SENT" as const)
          .catch(() => "FAILED" as const)
      : Promise.resolve("SKIPPED" as const);

  const emailPromise: Promise<ChannelDeliveryStatus> =
    channels.email && contact.ownerEmail
      ? sendEmail(
          contact.ownerEmail,
          offer.title,
          renderedMessage,
          detailsEmailHtml({
            heading: offer.title,
            intro: renderedMessage,
            rows: [
              {
                label: "Your price",
                value: `${offer.currency} ${offer.discountedAmount.toFixed(2)}/month`,
                sub: `Regular price ${offer.currency} ${regularAmount.toFixed(2)}/month`,
              },
              { label: "Duration", value: `${offer.durationMonths} month(s)` },
              { label: "Valid until", value: offer.validUntil.toISOString().slice(0, 10) },
            ],
          }),
        )
          .then(() => "SENT" as const)
          .catch(() => "FAILED" as const)
      : Promise.resolve("SKIPPED" as const);

  const [sms, whatsapp, email] = await Promise.all([smsPromise, whatsappPromise, emailPromise]);

  let portalNotificationId: string | null = null;
  if (channels.portal) {
    try {
      portalNotificationId = await createNotification(pool, contact.ownerUserId, "subscription_offer", {
        clinic_id: contact.clinicId,
        message: renderedMessage,
        offer_price: offer.discountedAmount,
        regular_price: regularAmount,
        currency: offer.currency,
        duration_months: offer.durationMonths,
        valid_until: offer.validUntil.toISOString(),
      });
    } catch (err) {
      console.error(`[offers] portal notification failed for clinic ${contact.clinicId}:`, err);
    }
  }

  return { sms, whatsapp, email, portalNotificationId };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeOffer(o: Row): Record<string, unknown> {
  const iso = (v: unknown): string | null =>
    typeof v === "string" ? `${v.includes("T") ? v : v.replace(" ", "T")}Z`.replace(/(\.\d+)?Z$/, "Z") : null;
  return {
    id: o.id,
    title: o.title,
    message: o.message,
    discounted_amount: Number(o.discounted_amount),
    currency: o.currency,
    duration_months: Number(o.duration_months),
    valid_until: iso(o.valid_until),
    channels: typeof o.channels_json === "string" ? JSON.parse(o.channels_json) : o.channels_json,
    status: o.status,
    created_by: o.created_by,
    created_at: iso(o.created_at),
    cancelled_at: iso(o.cancelled_at),
    recipient_count: o.recipient_count != null ? Number(o.recipient_count) : undefined,
    redeemed_count: o.redeemed_count != null ? Number(o.redeemed_count) : undefined,
  };
}

export function serializeOfferRecipient(r: Row): Record<string, unknown> {
  const iso = (v: unknown): string | null =>
    typeof v === "string" ? `${v.includes("T") ? v : v.replace(" ", "T")}Z`.replace(/(\.\d+)?Z$/, "Z") : null;
  return {
    id: r.id,
    clinic_id: r.clinic_id,
    clinic_name: r.clinic_name ?? null,
    status: r.status,
    months_remaining: Number(r.months_remaining),
    notify_sms_status: r.notify_sms_status ?? null,
    notify_whatsapp_status: r.notify_whatsapp_status ?? null,
    notify_email_status: r.notify_email_status ?? null,
    notified_at: iso(r.notified_at),
    redeemed_at: iso(r.redeemed_at),
    created_at: iso(r.created_at),
  };
}
