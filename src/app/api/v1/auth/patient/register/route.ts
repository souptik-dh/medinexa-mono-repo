import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, emailSchema, passwordSchema } from "@/lib/validators";
import { registerUser } from "@/lib/auth-flows";

const schema = z.object({
  name: z.string().trim().min(1).max(255),
  email: emailSchema,
  phone: z.string().trim().max(32).optional().nullable(),
  address: z.string().trim().min(1).max(500),
  nearby_location: z.string().trim().max(500).optional().nullable(),
  city: z.string().trim().max(255).optional().nullable(),
  district: z.string().trim().max(255).optional().nullable(),
  pin_code: z.string().trim().max(20).optional().nullable(),
  state: z.string().trim().max(255).optional().nullable(),
  post_office: z.string().trim().max(255).optional().nullable(),
  password: passwordSchema,
});

export const POST = api({ rateLimit: 10, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));
  const result = await registerUser({
    name: body.name,
    email: body.email,
    phone: body.phone,
    address: body.address,
    nearby_location: body.nearby_location,
    city: body.city,
    district: body.district,
    pin_code: body.pin_code,
    state: body.state,
    post_office: body.post_office,
    password: body.password,
    role: "patient",
  });
  return json(
    {
      user: result.user,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    },
    201,
  );
});
