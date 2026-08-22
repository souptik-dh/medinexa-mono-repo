import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody, passwordSchema } from "@/lib/validators";
import { requireRoles, hashPassword, verifyPassword, invalidateUserCache } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/errors";

const schema = z.object({
  current_password: z.string().min(1),
  new_password: passwordSchema,
  confirm_password: z.string().min(1),
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(schema, await readJson(ctx.request));

  if (body.new_password !== body.confirm_password) {
    throw badRequest(
      "VALIDATION_ERROR",
      "New password and confirm password must match.",
      "confirm_password",
    );
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT password_hash FROM users WHERE id = ?`,
    [auth.userId],
  );
  const ok = await verifyPassword(body.current_password, rows[0]?.password_hash ?? null);
  if (!ok) {
    throw unauthorized("INVALID_CREDENTIALS", "Current password is incorrect.");
  }

  const passwordHash = await hashPassword(body.new_password);
  await pool.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, auth.userId]);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL`,
    [auth.userId],
  );
  invalidateUserCache(auth.userId);

  return json({ message: "Password changed. Please log in again on your other devices." });
});
