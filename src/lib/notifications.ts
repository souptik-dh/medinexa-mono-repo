import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { newId } from "@/lib/ids";

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

/**
 * Sends email through the Brevo SMTP API (credentials in .env). Falls back to
 * a console log in local dev when BREVO_API_KEY is not configured. Never logs
 * the API key.
 */
export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log(`[email:stub] to=${to} subject=${subject}\n${body}`);
    return;
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL ?? "noreply@medibook.app";
  const senderName = process.env.BREVO_SENDER_NAME ?? "MediBook";
  const htmlContent = textToHtml(body);

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
