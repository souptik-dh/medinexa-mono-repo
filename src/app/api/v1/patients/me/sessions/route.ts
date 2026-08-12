import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id, created_at, expires_at
       FROM refresh_tokens
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
      ORDER BY created_at DESC`,
    [auth.userId],
  );
  return json({
    items: rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      expires_at: r.expires_at,
    })),
  });
});
