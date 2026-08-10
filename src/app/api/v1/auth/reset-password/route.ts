import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, passwordSchema } from "@/lib/validators";
import { pool, withTransaction, type Row } from "@/lib/db";
import { hashPassword, hashToken } from "@/lib/auth";
import { ApiError, badRequest } from "@/lib/errors";
import type { ResultSetHeader } from "mysql2/promise";

const schema = z.object({
  token: z.string().min(1).max(512),
  new_password: passwordSchema,
  confirm_password: z.string().min(1).max(128),
});

export const POST = api({ rateLimit: 10, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  if (body.new_password !== body.confirm_password) {
    throw badRequest(
      "VALIDATION_ERROR",
      "New password and confirm password must match.",
      "confirm_password",
    );
  }

  const [tokens] = await pool.query<Row[]>(
    `SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL`,
    [hashToken(body.token)],
  );
  const token = tokens[0];
  if (!token) {
    throw badRequest(
      "RESET_TOKEN_INVALID",
      "This password reset link is invalid. Request a new one.",
    );
  }
  if (Date.parse(`${token.expires_at}Z`) < Date.now()) {
    throw new ApiError(
      410,
      "RESET_TOKEN_EXPIRED",
      "This password reset link has expired. Request a new one.",
    );
  }

  const passwordHash = await hashPassword(body.new_password);

  await withTransaction(async (conn) => {
    const [claim] = await conn.query<ResultSetHeader>(
      `UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP(3)
        WHERE id = ? AND used_at IS NULL`,
      [token.id],
    );
    if (claim.affectedRows !== 1) {
      throw badRequest(
        "RESET_TOKEN_INVALID",
        "This password reset link has already been used. Request a new one.",
      );
    }
    await conn.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [
      passwordHash,
      token.user_id,
    ]);
  });

  return json({
    message: "Your password has been updated. You can now log in with your new password.",
  });
});
