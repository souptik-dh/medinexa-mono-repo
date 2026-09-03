import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, optionalEmailSchema, otpSchema } from "@/lib/validators";
import { registerUser, verifyRegistrationOtp } from "@/lib/auth-flows";
import { badRequest } from "@/lib/errors";

const registerSchema = z.object({
  name: z.string().trim().min(1).max(255),
  clinicName: z.string().trim().min(1, "Clinic name is required.").max(255),
  email: optionalEmailSchema,
  phone: phoneSchema,
  otp: otpSchema,
});

/**
 * Clinic owner registration, step 2: verifies the OTP and creates the owner
 * user account plus the clinic (with a trial subscription). Unlike patients,
 * clinic owners cannot self-activate via OTP alone (status stays 'pending' and
 * the account becomes active only after account verification), but the phone
 * is verified so they may proceed to email verification if desired. For a
 * phone-first system, we activate the account immediately once the phone is
 * verified; email remains optional.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(registerSchema, await readJson(ctx.request));

  const result = await verifyRegistrationOtp({
    phone: body.phone,
    otp: body.otp,
    purposes: ["phone_verification", "clinic_owner_login"],
  });
  if (!result.ok) throw badRequest("INVALID_OTP", result.message);

  const reg = await registerUser(
    {
      name: body.name,
      clinicName: body.clinicName,
      email: body.email ?? null,
      phone: body.phone,
      password: null,
      role: "clinic_owner",
    },
    true,
  );
  return json(
    {
      user: reg.user,
      access_token: reg.access_token,
      refresh_token: reg.refresh_token,
      clinic: reg.clinic,
      message: reg.message,
    },
    201,
  );
});
