import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema } from "@/lib/validators";
import { sendPhoneOtp } from "@/lib/auth-flows";
import { pool, type Row } from "@/lib/db";

const schema = z.object({ phone: phoneSchema });

/**
 * Patient login, step 1: takes the phone number, verifies an active patient
 * account exists, and sends a one-time code. Step 2 verifies the OTP via
 * POST /auth/patient/verify-otp.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  const [users] = await pool.query<Row[]>(
    `SELECT email FROM users WHERE phone = ? AND role = 'patient' AND status = 'active' LIMIT 1`,
    [body.phone],
  );
  // Always returns the same generic message (plus a TEMP local-testing otp/expires_at
  // from sendPhoneOtp) regardless of whether an account exists, to avoid user enumeration.
  const result = await sendPhoneOtp({
    phone: body.phone,
    email: users[0]?.email ?? null,
    purpose: "patient_login",
  });
  return json(result);
});
