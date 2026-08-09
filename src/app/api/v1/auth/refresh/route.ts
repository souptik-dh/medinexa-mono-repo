import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody } from "@/lib/validators";
import { rotateRefreshToken } from "@/lib/auth";

const schema = z.object({
  refresh_token: z.string().min(1),
});

export const POST = api({ rateLimit: 10, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));
  const tokens = await rotateRefreshToken(body.refresh_token);
  return json(tokens);
});
