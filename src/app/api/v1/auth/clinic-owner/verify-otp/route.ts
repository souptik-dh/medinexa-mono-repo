import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, otpSchema } from "@/lib/validators";
import { verifyPhoneOtpAndLogin } from "@/lib/auth-flows";
import { pool, type Row } from "@/lib/db";

const schema = z.object({
  phone: phoneSchema,
  otp: otpSchema,
});

/**
 * Clinic owner login, step 2: verifies the OTP and issues tokens. Also
 * returns the owned clinic summary.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));
  const result = await verifyPhoneOtpAndLogin({
    phone: body.phone,
    otp: body.otp,
    role: "clinic_owner",
    purpose: "clinic_owner_login",
  });

  // Attach the clinic owned by this user
  const [clinics] = await pool.query<Row[]>(
    `SELECT c.id, c.name, c.description
       FROM clinics c WHERE c.owner_user_id = ? AND c.deleted_at IS NULL LIMIT 1`,
    [result.user.id],
  );
  const clinic = clinics[0] ?? null;

  return json({
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    user: result.user,
    requires_password_setup: result.requires_password_setup,
    clinic: clinic
      ? { id: clinic.id, name: clinic.name, description: clinic.description }
      : null,
  });
});
