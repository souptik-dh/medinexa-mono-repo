import { api, noContent } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles, invalidateUserCache } from "@/lib/auth";

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL`,
    [auth.userId],
  );
  invalidateUserCache(auth.userId);
  return noContent();
});
