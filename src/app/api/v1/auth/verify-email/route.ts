import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody } from "@/lib/validators";
import { pool, withTransaction, type Row } from "@/lib/db";
import { hashToken } from "@/lib/auth";
import { ApiError, badRequest, conflict, isUniqueViolation } from "@/lib/errors";
import type { ResultSetHeader } from "mysql2/promise";

const schema = z.object({ token: z.string().min(1).max(512) });

export const POST = api({ rateLimit: 10, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  const [tokens] = await pool.query<Row[]>(
    `SELECT * FROM email_verification_tokens WHERE token_hash = ? AND used_at IS NULL`,
    [hashToken(body.token)],
  );
  const token = tokens[0];
  if (!token) {
    throw badRequest(
      "VERIFICATION_TOKEN_INVALID",
      "This verification link is invalid or has already been used.",
    );
  }
  if (Date.parse(`${token.expires_at}Z`) < Date.now()) {
    throw new ApiError(
      410,
      "VERIFICATION_TOKEN_EXPIRED",
      "This verification link has expired. Please request a new one.",
    );
  }

  try {
    await withTransaction(async (conn) => {
      const [claim] = await conn.query<ResultSetHeader>(
        `UPDATE email_verification_tokens SET used_at = UTC_TIMESTAMP(3)
          WHERE id = ? AND used_at IS NULL`,
        [token.id],
      );
      if (claim.affectedRows !== 1) {
        throw badRequest(
          "VERIFICATION_TOKEN_INVALID",
          "This verification link has already been used.",
        );
      }
      if (token.new_email) {
        await conn.query(`UPDATE users SET email = ? WHERE id = ?`, [
          token.new_email,
          token.user_id,
        ]);
      } else {
        await conn.query(`UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'`, [
          token.user_id,
        ]);
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("EMAIL_ALREADY_REGISTERED", "An account with this email already exists.");
    }
    throw err;
  }

  return json({
    message: token.new_email
      ? "Your email address has been updated."
      : "Your email has been verified. You can now log in.",
  });
});
