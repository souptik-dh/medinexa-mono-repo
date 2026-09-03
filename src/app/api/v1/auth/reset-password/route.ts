import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, otpSchema, passwordSchema } from "@/lib/validators";
import { pool, parseDbTimestamp, type Row } from "@/lib/db";
import { hashPassword, hashToken } from "@/lib/auth";
import { ApiError, badRequest, unauthorized } from "@/lib/errors";

const schema = z.object({
  phone: phoneSchema,
  otp: otpSchema,
  new_password: passwordSchema,
  confirm_password: z.string().min(1).max(128),
});

/**
 * Password reset, step 2: verifies the phone OTP and sets a new password.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  if (body.new_password !== body.confirm_password) {
    throw badRequest(
      "VALIDATION_ERROR",
      "New password and confirm password must match.",
      "confirm_password",
    );
  }

  const [codes] = await pool.query<Row[]>(
    `SELECT * FROM otp_codes
      WHERE phone = ? AND purpose = 'phone_verification' AND verified_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [body.phone],
  );
  const code = codes[0];
  if (!code) throw unauthorized("INVALID_OTP", "No pending OTP found for this phone number.");
  if (parseDbTimestamp(code.expires_at).getTime() < Date.now()) {
    throw new ApiError(410, "OTP_EXPIRED", "This OTP has expired. Request a new one.");
  }
  if (hashToken(`${body.phone}:${body.otp}`) !== code.code_hash) {
    await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [code.id]);
    throw unauthorized("INVALID_OTP", "Incorrect OTP. Please try again.");
  }

  const [users] = await pool.query<Row[]>(
    `SELECT id FROM users WHERE phone = ? AND status = 'active'`,
    [body.phone],
  );
  const user = users[0];
  if (!user) throw unauthorized("ACCOUNT_NOT_FOUND", "No active account found for this phone number.");

  const passwordHash = await hashPassword(body.new_password);

  await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);
  await pool.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, user.id]);

  return json({
    message: "Your password has been updated. You can now log in with your new password.",
  });
});
