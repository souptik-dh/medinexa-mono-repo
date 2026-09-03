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
  | "subscription_deactivated";

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
  if (rows.length === 0) return;
  const payloadJson = JSON.stringify(payload);
  const values = rows.map((row) => [newId(), row.user_id, branchId, type, payloadJson]);
  await db.query(
    `INSERT INTO notifications (id, user_id, branch_id, type, payload_json) VALUES ?`,
    [values],
  );
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
    case "lab_test_booked":
      return {
        title: "Lab test booked",
        body: when
          ? `Your lab test booking for ${when} has been submitted.`
          : "Your lab test booking has been submitted.",
      };
    case "lab_test_approved":
      return {
        title: "Lab test confirmed",
        body: when
          ? `Your lab test appointment for ${when} has been confirmed.`
          : "Your lab test appointment has been confirmed.",
      };
    case "lab_test_rejected":
      return {
        title: "Lab test booking rejected",
        body: when
          ? `Your lab test booking for ${when} has been rejected.`
          : "Your lab test booking has been rejected.",
      };
    case "lab_test_cancelled":
      return {
        title: "Lab test cancelled",
        body: when
          ? `Your lab test appointment for ${when} has been cancelled.`
          : "Your lab test appointment has been cancelled.",
      };
    case "lab_test_completed":
      return {
        title: "Lab test completed",
        body: when
          ? `Your lab test on ${when} has been completed.`
          : "Your lab test has been completed.",
      };
    case "lab_test_payment_success":
      return {
        title: "Payment received",
        body: `Payment for your lab test${when ? ` on ${when}` : ""} has been received.`,
      };
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
const LOGO_URL =
  process.env.EMAIL_LOGO_URL ??
  "https://res.cloudinary.com/p274ocjz/image/upload/v1787036452/medinexa/email-logo.png";
const APP_ICON_URL =
  process.env.EMAIL_APP_ICON_URL ??
  "https://res.cloudinary.com/p274ocjz/image/upload/v1787035848/medinexa/email-app-icon.png";

function logoImg(): string {
  return `<img src="${LOGO_URL}" alt="Jido Healthcare" style="display:block;margin:0 auto;border:0;max-height:56px;width:auto;filter:drop-shadow(0 4px 10px rgba(0,0,0,0.15));"/>`;
}

function appIconImg(): string {
  return `<img src="${APP_ICON_URL}" alt="Jido Healthcare" width="64" height="64" style="display:block;margin:0 auto;border:0;border-radius:14px;box-shadow:0 4px 10px rgba(0,0,0,0.15);"/>`;
}

/** Branded HTML email with the centered logo (non-patient recipients). */
export function emailHtml(body: string): string {
  return emailShell(logoImg(), textToHtml(body));
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
  return emailShell(logoImg(), body);
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
  return emailShell(logoImg(), body);
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
  return emailShell(opts.patientFacing ? appIconImg() : logoImg(), body);
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
  return emailShell(logoImg(), body);
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
 * SMS delivery through the Jido SMS Gateway (credentials in .env via
 * SMS_API_KEY, an optional SMS_API_URL override). Falls back to a console log
 * in local dev when SMS_API_KEY is not configured. Never throws.
 */
export async function sendSms(to: string, body: string): Promise<void> {
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

/** Sends a one-time login/password code via SMS. */
export async function sendOtpSms(
  phone: string,
  otp: string,
  expiryMinutes: number,
): Promise<void> {
  await sendSms(
    phone,
    `Your Jido Healthcare verification code is ${otp}. It expires in ${expiryMinutes} minutes. Do not share this code with anyone.`,
  );
}

/**
 * Sends a one-time code via BOTH SMS and email (if an email is on file).
 * Failures never reject the caller.
 */
export async function sendOtpDual(opts: {
  phone: string;
  email?: string | null;
  otp: string;
  expiryMinutes: number;
}): Promise<void> {
  const smsPromise = sendOtpSms(opts.phone, opts.otp, opts.expiryMinutes);
  const emailPromise = opts.email
    ? sendEmail(
        opts.email,
        "Your Jido Healthcare login code",
        `Your one-time login code is ${opts.otp}. It expires in ${opts.expiryMinutes} minutes. Do not share this code with anyone.`,
        otpEmailHtml(opts.otp, opts.expiryMinutes),
      )
    : Promise.resolve();
  await Promise.allSettled([smsPromise, emailPromise]);
}

/** Sends a doctor invitation link via SMS. */
export async function sendInviteSms(opts: {
  phone: string;
  doctorName: string;
  clinicName: string;
  inviteUrl: string;
}): Promise<void> {
  await sendSms(
    opts.phone,
    `Dr. ${opts.doctorName}, you have been invited to join ${opts.clinicName} on MediBook. Accept your invitation here: ${opts.inviteUrl}`,
  );
}

/**
 * Sends an SMS to a user's registered phone number, if one is on file.
 * Used to mirror email notifications over SMS (per the dual-channel policy).
 * Never throws; silently no-ops when the user has no phone.
 */
export async function sendSmsIfPhone(
  db: Pick<PoolConnection, "query">,
  userId: string,
  message: string,
): Promise<void> {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT phone FROM users WHERE id = ? AND phone IS NOT NULL`,
      [userId],
    );
    const phone = rows[0]?.phone as string | undefined;
    if (phone) await sendSms(phone, message);
  } catch (err) {
    console.error(`[sms] failed to send to user ${userId}:`, err);
  }
}
