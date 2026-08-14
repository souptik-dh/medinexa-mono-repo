import { api, noContent } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { requireBranchAccess } from "@/lib/permissions";
import { notFound } from "@/lib/errors";

export const DELETE = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const { id: branchId, closureId } = ctx.params;
  await requireBranchAccess(pool, auth, branchId, "branch:settings");

  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM branch_closures WHERE id = ? AND branch_id = ?`,
    [closureId, branchId],
  );
  if (!rows[0]) throw notFound("CLOSURE_NOT_FOUND", "Branch closure not found.");

  // Soft-cancel, same audit-trail reasoning as doctor leaves: the row stays, only
  // status flips, so the closure's date range is immediately open again.
  await pool.query(`UPDATE branch_closures SET status = 'cancelled' WHERE id = ?`, [closureId]);
  return noContent();
});
