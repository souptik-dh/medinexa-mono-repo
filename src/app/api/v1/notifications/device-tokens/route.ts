import { z } from "zod";
import { api, json, noContent, readJson } from "@/lib/http";
import { pool } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { badRequest } from "@/lib/errors";
import { newId } from "@/lib/ids";

const registerSchema = z.object({
  token: z.string().trim().min(1).max(255),
  platform: z.enum(["android", "ios"]),
});

// A device token identifies one app install, not one user — the same phone can be
// registered to a different account after logout/login. The upsert reassigns it to
// whoever is currently authenticated rather than erroring, so a shared/reused device
// always ends up pointing at the right account.
export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  const body = parseBody(registerSchema, await readJson(ctx.request));

  await pool.query(
    `INSERT INTO device_tokens (id, user_id, token, platform)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform)`,
    [newId(), auth.userId, body.token, body.platform],
  );

  return json({ registered: true }, 201);
});

export const DELETE = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  const token = ctx.request.nextUrl.searchParams.get("token");
  if (!token) throw badRequest("VALIDATION_ERROR", "token is required.", "token");

  await pool.query(`DELETE FROM device_tokens WHERE token = ? AND user_id = ?`, [token, auth.userId]);
  return noContent();
});
