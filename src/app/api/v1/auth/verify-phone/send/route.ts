import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, optionalEmailSchema } from "@/lib/validators";
import { sendPhoneOtp } from "@/lib/auth-flows";

const schema = z.object({
  phone: phoneSchema,
  email: optionalEmailSchema,
});

/**
 * Sends a phone-verification OTP to a phone number (purpose phone_verification).
 * Used when adding/changing a phone number on an existing account, and by the
 * doctor invite-acceptance flow to verify the doctor's phone. Unauthenticated;
 * the OTP is keyed by phone, so anyone in possession of the phone can verify.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));
  const result = await sendPhoneOtp({
    phone: body.phone,
    email: body.email ?? null,
    purpose: "phone_verification",
  });
  return json(result);
});
