import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { randomBytes } from "node:crypto";
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
 * ntfy (https://ntfy.sh) push delivery. Each patient gets a private, unique
 * topic stored in users.push_topic; their app subscribes to
 * `${NTFY_BASE_URL}/${topic}` and the server publishes to it via HTTP.
 */
const NTFY_BASE_URL = (process.env.NTFY_BASE_URL ?? "https://ntfy.sh").replace(/\/+$/, "");
const NTFY_TOKEN = process.env.NTFY_TOKEN ?? null;

/** Fresh per-patient ntfy topic. Kept opaque so it doubles as the subscribe key. */
export function newPushTopic(): string {
  return `medinexa_${randomBytes(24).toString("base64url")}`;
}

/**
 * Returns the patient's ntfy topic, generating and persisting one on first use
 * (covers patients registered before push topics existed). Non-patients and
 * unknown users return null.
 */
export async function getOrCreatePushTopic(
  db: Pick<PoolConnection, "query">,
  userId: string,
): Promise<string | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT role, push_topic FROM users WHERE id = ?`,
    [userId],
  );
  const user = rows[0];
  if (!user || user.role !== "patient") return null;
  if (user.push_topic) return user.push_topic as string;

  const topic = newPushTopic();
  await db.query(`UPDATE users SET push_topic = ? WHERE id = ?`, [topic, userId]);
  return topic;
}

export interface PushMessage {
  title: string;
  message: string;
  tags?: string[];
  priority?: number;
}

/** Publishes a message to a ntfy topic. Never throws — failures are logged. */
export async function publishPush(topic: string, msg: PushMessage): Promise<void> {
  const headers: Record<string, string> = {
    Title: msg.title,
    Tags: (msg.tags ?? []).join(","),
    Priority: String(msg.priority ?? 3),
  };
  if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;
  try {
    const res = await fetch(`${NTFY_BASE_URL}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body: msg.message,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[push] ntfy rejected publish (${res.status}): ${detail}`);
    }
  } catch (err) {
    console.error("[push] ntfy publish failed:", err);
  }
}

/** Maps an in-app notification type to a user-facing push title/message. */
export function pushContentFor(
  type: NotificationType,
  payload: Record<string, unknown> = {},
): PushMessage {
  const when = [payload.date, payload.time].filter(Boolean).join(" at ");
  switch (type) {
    case "booking_confirmed":
      return {
        title: "Appointment confirmed",
        message: when
          ? `Your appointment for ${when} has been confirmed.`
          : "Your appointment has been confirmed.",
        tags: ["white_check_mark"],
        priority: 4,
      };
    case "payment_received":
      return {
        title: "Payment received",
        message: `Payment for your appointment${when ? ` on ${when}` : ""} has been received.`,
        tags: ["moneybag"],
        priority: 3,
      };
    case "consultation_completed":
      return {
        title: "Consultation completed",
        message: `Your consultation${when ? ` on ${when}` : ""} is complete.`,
        tags: ["stethoscope"],
        priority: 3,
      };
    case "prescription_ready":
      return {
        title: "Prescription ready",
        message: "Your prescription is ready to view.",
        tags: ["pill"],
        priority: 4,
      };
    case "appointment_cancelled":
      return {
        title: "Appointment cancelled",
        message: `Your appointment${when ? ` on ${when}` : ""} has been cancelled.`,
        tags: ["warning"],
        priority: 4,
      };
    default:
      return {
        title: type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        message: typeof payload.message === "string" ? payload.message : "You have a new notification.",
        priority: 3,
      };
  }
}

/**
 * Creates the in-app notification AND delivers a ntfy push to the patient's
 * device. Push failures never fail the underlying request.
 */
export async function createPatientNotification(
  db: Pick<PoolConnection, "query">,
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await createNotification(db, userId, type, payload);
  const topic = await getOrCreatePushTopic(db, userId);
  if (topic) await publishPush(topic, pushContentFor(type, payload));
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

  const senderEmail = process.env.BREVO_SENDER_EMAIL ?? "noreply@medibook.app";
  const senderName = process.env.BREVO_SENDER_NAME ?? "MediBook";
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
