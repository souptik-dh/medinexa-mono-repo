import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody, emailSchema } from "@/lib/validators";
import { requireRoles, verifyPassword, generateVerificationToken } from "@/lib/auth";
import { conflict, unauthorized } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { sendEmail } from "@/lib/notifications";

const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

const schema = z.object({
  new_email: emailSchema,
  current_password: z.string().min(1),
});

export const POST = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(schema, await readJson(ctx.request));

  const [rows] = await pool.query<Row[]>(
    `SELECT password_hash, email, name FROM users WHERE id = ?`,
    [auth.userId],
  );
  const user = rows[0];
  const ok = await verifyPassword(body.current_password, user?.password_hash ?? null);
  if (!ok) throw unauthorized("INVALID_CREDENTIALS", "Current password is incorrect.");

  if (body.new_email === user.email) {
    return json({ message: "This is already your current email address." });
  }

  const [existing] = await pool.query<Row[]>(`SELECT id FROM users WHERE email = ?`, [
    body.new_email,
  ]);
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
    [newId(), auth.userId, hash, body.new_email, expiresAt],
  );

  const verifyUrl = process.env.VERIFY_EMAIL_URL ?? "https://healthcare.jido.co.in";
  const link = `${verifyUrl}/verify_email?token=${raw}`;
  await sendEmail(
    body.new_email,
    "Confirm your new email address",
    `Hi ${user.name ?? "there"},\n\nClick the link below to confirm this as your new Jido Healthcare account email:\n\n${link}\n\nThis link expires in 24 hours. If you didn't request this change, you can safely ignore this email.`,
  );
  await sendEmail(
    user.email,
    "Email change requested",
    `Hi ${user.name ?? "there"},\n\nWe received a request to change your account email to ${body.new_email}. If this wasn't you, please change your password immediately.`,
  );

  return json({
    message: "Check your new email address for a confirmation link to complete the change.",
  });
});
