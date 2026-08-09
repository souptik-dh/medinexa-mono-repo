import { z } from "zod";
import { api, noContent, readJson } from "@/lib/http";
import { parseBody } from "@/lib/validators";
import { requireRoles, revokeRefreshToken } from "@/lib/auth";

const schema = z.object({
  refresh_token: z.string().min(1),
});

export const POST = api({ rateLimit: 100 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "doctor"]);
  void auth;
  const body = parseBody(schema, await readJson(ctx.request));
  await revokeRefreshToken(body.refresh_token);
  return noContent();
});
