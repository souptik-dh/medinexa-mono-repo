import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody } from "@/lib/validators";
import { pool, withTransaction, type Row } from "@/lib/db";
import { hashToken } from "@/lib/auth";
import { ApiError, badRequest } from "@/lib/errors";
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
    await conn.query(`UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'`, [
      token.user_id,
    ]);
  });

  return json({ message: "Your email has been verified. You can now log in." });
});
