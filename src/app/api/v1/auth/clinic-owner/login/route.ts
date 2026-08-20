import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, emailSchema } from "@/lib/validators";
import { loginWithPassword } from "@/lib/auth-flows";

const schema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));
  const result = await loginWithPassword(body.email, body.password, "clinic_owner");
  return json({ access_token: result.access_token, refresh_token: result.refresh_token, user: result.user });
});
