import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, passwordSchema } from "@/lib/validators";
import { pool } from "@/lib/db";
import { hashPassword, invalidateUserCache } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/errors";

const schema = z.object({
  new_password: passwordSchema,
  confirm_password: z.string().min(1).max(128),
});

/**
 * Lets an authenticated user set (or reset) their password after logging in
 * via OTP without one. Revokes nothing; the current session stays valid.
 */
export const POST = api({ rateLimit: 20 }, async (ctx) => {
  if (!ctx.auth) throw unauthorized();
  const body = parseBody(schema, await readJson(ctx.request));

  if (body.new_password !== body.confirm_password) {
    throw badRequest(
      "VALIDATION_ERROR",
      "New password and confirm password must match.",
      "confirm_password",
    );
  }

  const passwordHash = await hashPassword(body.new_password);
  await pool.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, ctx.auth.userId]);
  invalidateUserCache(ctx.auth.userId);

  return json({ message: "Your password has been set. You can now log in with your password." });
});
