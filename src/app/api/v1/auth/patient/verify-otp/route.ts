import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, otpSchema } from "@/lib/validators";
import { verifyPhoneOtpAndLogin } from "@/lib/auth-flows";

const schema = z.object({
  phone: phoneSchema,
  otp: otpSchema,
});

/**
 * Verifies the OTP sent by POST /auth/patient/login (purpose patient_login).
 * If the phone already has an active patient account, issues tokens. Returns
 * requires_password_setup=true when the account has no password yet.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));
  const result = await verifyPhoneOtpAndLogin({
    phone: body.phone,
    otp: body.otp,
    role: "patient",
    purpose: "patient_login",
  });
  return json({
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    user: result.user,
    requires_password_setup: result.requires_password_setup,
  });
});
