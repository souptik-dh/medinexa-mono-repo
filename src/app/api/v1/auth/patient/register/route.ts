import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, optionalEmailSchema, otpSchema } from "@/lib/validators";
import { registerUser, verifyRegistrationOtp } from "@/lib/auth-flows";
import { badRequest } from "@/lib/errors";

const registerSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: optionalEmailSchema,
  phone: phoneSchema,
  address: z.string().trim().min(1).max(500),
  nearby_location: z.string().trim().max(500).optional().nullable(),
  city: z.string().trim().max(255).optional().nullable(),
  district: z.string().trim().max(255).optional().nullable(),
  pin_code: z.string().trim().max(20).optional().nullable(),
  state: z.string().trim().max(255).optional().nullable(),
  post_office: z.string().trim().max(255).optional().nullable(),
  otp: otpSchema,
});

export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(registerSchema, await readJson(ctx.request));

  // The phone must be verified with an OTP before the account is created.
  // Registration is a 2-step flow: POST /auth/patient/send-otp delivers the
  // code, then this endpoint verifies it and creates the account.
  const result = await verifyRegistrationOtp({
    phone: body.phone,
    otp: body.otp,
    purposes: ["phone_verification", "patient_login"],
  });
  if (!result.ok) throw badRequest("INVALID_OTP", result.message);

  const reg = await registerUser(
    {
      name: body.name,
      email: body.email ?? null,
      phone: body.phone,
      address: body.address,
      nearby_location: body.nearby_location ?? null,
      city: body.city ?? null,
      district: body.district ?? null,
      pin_code: body.pin_code ?? null,
      state: body.state ?? null,
      post_office: body.post_office ?? null,
      password: null,
      role: "patient",
    },
    true,
  );
  return json(
    {
      user: reg.user,
      access_token: reg.access_token,
      refresh_token: reg.refresh_token,
    },
    201,
  );
});
