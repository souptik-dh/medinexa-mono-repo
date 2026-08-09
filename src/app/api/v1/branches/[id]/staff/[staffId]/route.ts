import { api, noContent } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { assertBranchStaffPermission } from "@/lib/permissions";

export const DELETE = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const { id: branchId, staffId } = ctx.params;

  if (auth.role === "clinic_owner") {
    await getOwnedBranch(pool, branchId, auth.userId);
  } else {
    await assertBranchStaffPermission(pool, auth, branchId, "staff:manage");
  }

  await pool.query(`DELETE FROM branch_staff WHERE id = ? AND branch_id = ?`, [staffId, branchId]);
  return noContent();
});
