import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, otpSchema } from "@/lib/validators";
import { pool, parseDbTimestamp, type Row } from "@/lib/db";
import { hashToken, invalidateUserCache } from "@/lib/auth";
import { ApiError, badRequest, unauthorized, conflict, isUniqueViolation } from "@/lib/errors";

const schema = z.object({
  phone: phoneSchema,
  otp: otpSchema,
});

/**
 * Lets an authenticated user add or change their registered phone number.
 * The new phone must be verified with an OTP (purpose 'phone_verification')
 * that the user first triggers via POST /auth/verify-phone/send (or any
 * OTP-send endpoint). On success, sets the phone + phone_verified flags.
 */
export const POST = api({ rateLimit: 20 }, async (ctx) => {
  if (!ctx.auth) throw unauthorized();
  const body = parseBody(schema, await readJson(ctx.request));

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
    throw badRequest("INVALID_OTP", "Incorrect OTP. Please try again.");
  }

  try {
    await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);
    await pool.query(
      `UPDATE users SET phone = ?, phone_verified = 1 WHERE id = ?`,
      [body.phone, ctx.auth.userId],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("PHONE_ALREADY_REGISTERED", "An account with this phone number already exists.");
    }
    throw err;
  }
  invalidateUserCache(ctx.auth.userId);

  return json({ message: "Your phone number has been verified and updated." });
});
