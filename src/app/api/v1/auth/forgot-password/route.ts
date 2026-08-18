import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, emailSchema } from "@/lib/validators";
import { pool, type Row } from "@/lib/db";
import { generateResetToken } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { sendEmail, patientEmailHtml } from "@/lib/notifications";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const schema = z.object({ email: emailSchema });

export const POST = api({ rateLimit: 10, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  const [users] = await pool.query<Row[]>(
    `SELECT id FROM users
      WHERE email = ? AND password_hash IS NOT NULL AND status = 'active'`,
    [body.email],
  );

  if (users[0]) {
    const { raw, hash } = generateResetToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    await pool.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
       VALUES (?, ?, ?, ?)`,
      [newId(), users[0].id, hash, expiresAt],
    );

    const resetUrl = process.env.RESET_PASSWORD_URL ?? "https://medinexa-clinic.onrender.com";
    const link = `${resetUrl}/new_password?token=${raw}`;

    const resetBody = `We received a request to reset your password. Click the link below to choose a new one:\n\n${link}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email.`;
    await sendEmail(
      body.email,
      "Reset your password",
      resetBody,
      patientEmailHtml(resetBody),
    );
  }

  return json({
    message: "If an account exists for this email, a password reset link has been sent.",
  });
});
