import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, emailSchema, passwordSchema } from "@/lib/validators";
import { registerUser } from "@/lib/auth-flows";

const schema = z.object({
  name: z.string().trim().min(1).max(255),
  email: emailSchema,
  phone: z.string().trim().max(32).optional().nullable(),
  password: passwordSchema,
});

export const POST = api({ rateLimit: 10, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));
  const result = await registerUser({
    name: body.name,
    email: body.email,
    phone: body.phone,
    password: body.password,
    role: "clinic_owner",
  });
  return json(
    {
      user: result.user,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      clinic: result.clinic,
      message: result.message,
    },
    201,
  );
});
