import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema } from "@/lib/validators";
import { pool, type Row } from "@/lib/db";
import { sendPhoneOtp } from "@/lib/auth-flows";

const schema = z.object({ phone: phoneSchema });

/**
 * Password reset, step 1: the user supplies their registered phone number. If
 * an active account with a password exists for it, we send a one-time code via
 * SMS + email (purpose 'phone_verification' keyed by phone). Step 2
 * (POST /auth/reset-password) verifies the OTP and sets a new password.
 *
 * Always returns the same generic message to avoid user enumeration.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  const [users] = await pool.query<Row[]>(
    `SELECT id, email FROM users
      WHERE phone = ? AND password_hash IS NOT NULL AND status = 'active'`,
    [body.phone],
  );
  const user = users[0];

  if (user) {
    const result = await sendPhoneOtp({
      phone: body.phone,
      email: user.email ?? null,
      purpose: "phone_verification",
    });
    return json(result);
  }

  return json({
    message: "If an account exists for this phone number, an OTP has been sent.",
  });
});
