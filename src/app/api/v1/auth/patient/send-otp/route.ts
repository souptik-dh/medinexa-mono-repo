import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, optionalEmailSchema } from "@/lib/validators";
import { sendPhoneOtp } from "@/lib/auth-flows";
import { pool, type Row } from "@/lib/db";

const schema = z.object({
  phone: phoneSchema,
  email: optionalEmailSchema,
  name: z.string().trim().min(1).max(255).optional().nullable(),
});

/**
 * Step 1 of patient registration (and OTP-only authentication when the phone
 * already has an account). Sends a one-time code to the phone (and email if
 * provided). When the phone already belongs to an active patient account the
 * code is issued with purpose 'patient_login' so POST /auth/patient/verify-otp
 * (which only looks up 'patient_login' codes) can complete the login; a phone
 * with no account yet gets 'phone_verification', consumed by
 * POST /auth/patient/register.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  const [rows] = await pool.query<Row[]>(
    `SELECT email FROM users WHERE phone = ? AND role = 'patient' AND status = 'active' LIMIT 1`,
    [body.phone],
  );
  const existingAccount = rows[0];

  const result = await sendPhoneOtp({
    phone: body.phone,
    email: existingAccount ? existingAccount.email : (body.email ?? null),
    purpose: existingAccount ? "patient_login" : "phone_verification",
  });
  return json(result);
});
