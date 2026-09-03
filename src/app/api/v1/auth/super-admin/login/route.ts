import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool } from "@/lib/db";
import type { Row } from "@/lib/db";
import { parseBody, phoneSchema } from "@/lib/validators";
import { loginWithPassword } from "@/lib/auth-flows";
import { forbidden } from "@/lib/errors";

const schema = z.object({
  phone: phoneSchema,
  password: z.string().min(1),
});

/**
 * Dedicated login for platform Super Admins. Same password credentials as any
 * account, but restricted to users with the sys_admin role AND an active row in
 * the super_admins grant table. Uses the phone number as the identifier.
 */
export const POST = api({ rateLimit: 10 }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));
  const result = await loginWithPassword(body.phone, body.password, "sys_admin");

  const [rows] = await pool.query<Row[]>(
    `SELECT user_id FROM super_admins WHERE user_id = ? AND revoked_at IS NULL`,
    [result.user.id],
  );
  if (rows.length === 0) {
    throw forbidden("NOT_SUPER_ADMIN", "This account does not have platform Super Admin privileges.");
  }

  return json(result);
});
