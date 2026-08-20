import { api, noContent } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import type { ResultSetHeader } from "mysql2/promise";

export const DELETE = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [ctx.params.id, auth.userId],
  );
  if (result.affectedRows === 0) {
    throw notFound("SESSION_NOT_FOUND", "Session not found.");
  }
  return noContent();
});
