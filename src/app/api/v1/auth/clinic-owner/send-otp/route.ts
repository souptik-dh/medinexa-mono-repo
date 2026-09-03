import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, optionalEmailSchema } from "@/lib/validators";
import { sendPhoneOtp } from "@/lib/auth-flows";
import { pool, type Row } from "@/lib/db";

const schema = z.object({
  phone: phoneSchema,
  email: optionalEmailSchema,
  name: z.string().trim().min(1).max(255),
  clinicName: z.string().trim().min(1, "Clinic name is required.").max(255),
});

/**
 * Clinic owner registration, step 1: validate the details and send a one-time
 * code to the phone. Step 2 (POST /auth/clinic-owner/register with the otp)
 * verifies and creates the account + clinic.
 *
 * To keep the two-step flow consistent with patients, this endpoint delivers
 * the OTP with purpose 'phone_verification'.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  let existingEmail: string | null = body.email ?? null;
  if (!existingEmail) {
    const [rows] = await pool.query<Row[]>(
      `SELECT email FROM users WHERE phone = ? AND role = 'clinic_owner' LIMIT 1`,
      [body.phone],
    );
    existingEmail = rows[0]?.email ?? null;
  }

  const result = await sendPhoneOtp({
    phone: body.phone,
    email: existingEmail,
    purpose: "phone_verification",
  });
  return json(result);
});
