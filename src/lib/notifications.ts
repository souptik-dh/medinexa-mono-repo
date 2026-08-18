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
  | "appointment_cancelled";

export async function createNotification(
  db: Pick<PoolConnection, "query">,
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown> = {},
  branchId: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO notifications (id, user_id, branch_id, type, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
    [newId(), userId, branchId, type, JSON.stringify(payload)],
  );
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
  for (const row of rows) {
    await createNotification(db, row.user_id, type, payload, branchId);
  }
}

export interface PushMessage {
  title: string;
  body: string;
}

/** Maps an in-app notification type to a user-facing push title/body. */
export function pushContentFor(
  type: NotificationType,
  payload: Record<string, unknown> = {},
): PushMessage {
  const when = [payload.date, payload.time].filter(Boolean).join(" at ");
  switch (type) {
    case "booking_confirmed":
      return {
        title: "Appointment confirmed",
        body: when
          ? `Your appointment for ${when} has been confirmed.`
          : "Your appointment has been confirmed.",
      };
    case "payment_received":
      return {
        title: "Payment received",
        body: `Payment for your appointment${when ? ` on ${when}` : ""} has been received.`,
      };
    case "consultation_completed":
      return {
        title: "Consultation completed",
        body: `Your consultation${when ? ` on ${when}` : ""} is complete.`,
      };
    case "prescription_ready":
      return {
        title: "Prescription ready",
        body: "Your prescription is ready to view.",
      };
    case "appointment_cancelled":
      return {
        title: "Appointment cancelled",
        body: `Your appointment${when ? ` on ${when}` : ""} has been cancelled.`,
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
  return rows.map((r) => r.email as string);
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

function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br/>");
}

const BASE_URL = process.env.APP_URL ?? "https://medinexa-clinic.onrender.com";

function emailShell(imgTag: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background-color:#f4f6f9;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="padding:32px 32px 0;text-align:center;">${imgTag}</td></tr>
<tr><td style="padding:24px 32px 32px;color:#333333;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
<tr><td style="padding:16px 32px;background-color:#f9fafb;border-top:1px solid #eee;text-align:center;font-size:12px;color:#999999;">
&copy; ${new Date().getFullYear()} Jido Healthcare. All rights reserved.
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function logoImg(): string {
  return `<img src="${BASE_URL}/logo.png" alt="Jido Healthcare" width="180" style="display:block;margin:0 auto;"/>`;
}

function appIconImg(): string {
  return `<img src="${BASE_URL}/app_icon.png" alt="Jido Healthcare" width="80" style="display:block;margin:0 auto;"/>`;
}

/** Branded HTML email with the centered logo (non-patient recipients). */
export function emailHtml(body: string): string {
  return emailShell(logoImg(), textToHtml(body));
}

/** Branded HTML email with the centered app icon (patient recipients). */
export function patientEmailHtml(body: string): string {
  return emailShell(appIconImg(), textToHtml(body));
}

/**
 * Sends email through the Brevo SMTP API (credentials in .env). Falls back to
 * a console log in local dev when BREVO_API_KEY is not configured. Never logs
 * the API key.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  html?: string,
): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log(`[email:stub] to=${to} subject=${subject}\n${body}`);
    return;
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
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[email] Brevo rejected send to ${to} (${res.status}): ${detail}`);
    }
  } catch (err) {
    console.error(`[email] send to ${to} failed:`, err);
  }
}

/**
 * SMS delivery is not configured in .env (Brevo SMS needs a sender number).
 * Falls back to logging so flows remain traceable. Wire to the Brevo SMS API
 * (or any provider) here when a sender is provisioned.
 */
export async function sendSms(to: string, body: string): Promise<void> {
  console.log(`[sms:stub] to=${to} body=${body}`);
}
