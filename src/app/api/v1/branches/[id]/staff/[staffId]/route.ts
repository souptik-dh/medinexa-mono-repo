import { api, noContent } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";

export const DELETE = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const { id: branchId, staffId } = ctx.params;
  await getOwnedBranch(pool, branchId, auth.userId);

  await pool.query(`DELETE FROM branch_staff WHERE id = ? AND branch_id = ?`, [staffId, branchId]);
  return noContent();
});
