import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody, phoneSchema, optionalEmailSchema } from "@/lib/validators";
import { generateVerificationToken } from "@/lib/auth";
import { badRequest, conflict, notFound, unauthorized } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { sendEmail, emailHtml } from "@/lib/notifications";

const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

async function loadProfile(userId: string) {
  const [rows] = await pool.query<Row[]>(
    `SELECT id, name, email, phone, phone_verified, role FROM users WHERE id = ?`,
    [userId],
  );
  const u = rows[0];
  if (!u) throw notFound("USER_NOT_FOUND", "User not found.");
  return u;
}

function toProfile(u: Row) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    phone_verified: u.phone_verified === 1 || u.phone_verified === true,
    role: u.role,
  };
}

/** Basic account profile for the signed-in user (any role). */
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  if (!ctx.auth) throw unauthorized();
  const auth = ctx.auth;
  return json(toProfile(await loadProfile(auth.userId)));
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  phone: phoneSchema.optional(),
  email: optionalEmailSchema,
});

/**
 * Updates the signed-in user's account profile. `name` is applied directly.
 * Phone and email are login identities, so they are never overwritten here:
 * - `phone` equal to the current number is a no-op; a different number must go
 *   through POST /auth/verify-phone/send + POST /auth/verify-phone (OTP).
 * - `email` equal to the current address is a no-op; a different address gets a
 *   confirmation link and is applied only once that link is opened
 *   (POST /auth/verify-email). The response reports it as `pending_email`.
 */
export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  if (!ctx.auth) throw unauthorized();
  const auth = ctx.auth;
  const body = parseBody(patchSchema, await readJson(ctx.request));
  const current = await loadProfile(auth.userId);

  if (body.phone !== undefined && body.phone !== current.phone) {
    throw badRequest(
      "PHONE_CHANGE_REQUIRES_VERIFICATION",
      "To change your phone number, verify the new number with an OTP.",
      "phone",
    );
  }

  if (body.name !== undefined && body.name !== current.name) {
    await pool.query(`UPDATE users SET name = ? WHERE id = ?`, [body.name, auth.userId]);
  }

  if (body.email === null && current.email !== null) {
    await pool.query(`UPDATE users SET email = NULL WHERE id = ?`, [auth.userId]);
  }

  let pendingEmail: string | null = null;
  if (body.email !== undefined && body.email !== null && body.email !== current.email) {
    const [existing] = await pool.query<Row[]>(
      `SELECT id FROM users WHERE email = ? AND id <> ?`,
      [body.email, auth.userId],
    );
    if (existing[0]) {
      throw conflict("EMAIL_ALREADY_REGISTERED", "An account with this email already exists.");
    }

    const { raw, hash } = generateVerificationToken();
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    await pool.query(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, new_email, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [newId(), auth.userId, hash, body.email, expiresAt],
    );

    const name = body.name ?? current.name ?? "there";
    const verifyUrl = process.env.VERIFY_EMAIL_URL ?? "https://healthcare.jido.co.in";
    const link = `${verifyUrl}/verify_email?token=${raw}`;
    const confirmBody = `Hi ${name},\n\nClick the link below to confirm this as your new Jido Healthcare account email:\n\n${link}\n\nThis link expires in 24 hours. If you didn't request this change, you can safely ignore this email.`;
    await sendEmail(body.email, "Confirm your new email address", confirmBody, emailHtml(confirmBody));
    if (current.email) {
      const notifyBody = `Hi ${name},\n\nWe received a request to change your account email to ${body.email}. If this wasn't you, please secure your account immediately.`;
      await sendEmail(current.email, "Email change requested", notifyBody, emailHtml(notifyBody));
    }
    pendingEmail = body.email;
  }

  return json({
    ...toProfile(await loadProfile(auth.userId)),
    pending_email: pendingEmail,
    ...(pendingEmail
      ? { message: "Check your new email address for a confirmation link to complete the change." }
      : {}),
  });
});
