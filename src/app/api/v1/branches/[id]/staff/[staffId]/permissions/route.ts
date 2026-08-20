import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { forbidden, notFound } from "@/lib/errors";
import { BRANCH_STAFF_PERMISSIONS, parsePermissions, assertBranchStaffPermission } from "@/lib/permissions";
import { getOwnedBranch } from "@/lib/scope";

async function loadStaffRow(branchId: string, staffId: string) {
  const [rows] = await pool.query<Row[]>(
    `SELECT bs.id, bs.branch_id, bs.user_id, u.name, u.email, bs.added_by,
            bs.created_at, bs.permissions_json
       FROM branch_staff bs
       JOIN users u ON u.id = bs.user_id
      WHERE bs.id = ? AND bs.branch_id = ?`,
    [staffId, branchId],
  );
  return rows[0];
}

const patchSchema = z.object({
  permissions: z.array(z.enum(BRANCH_STAFF_PERMISSIONS)),
});

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const { id: branchId, staffId } = ctx.params;

  if (auth.role === "clinic_owner") {
    await getOwnedBranch(pool, branchId, auth.userId);
  } else if (auth.role === "branch_staff") {
    if (auth.branchId !== branchId) {
      throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
    }
    const [self] = await pool.query<Row[]>(
      `SELECT id FROM branch_staff WHERE branch_id = ? AND user_id = ?`,
      [branchId, auth.userId],
    );
    if (!self[0] || self[0].id !== staffId) {
      throw forbidden(
        "PERMISSION_DENIED",
        "You can only view your own permissions.",
      );
    }
  }

  const row = await loadStaffRow(branchId, staffId);
  if (!row) throw notFound("STAFF_NOT_FOUND", "Staff member not found.");

  return json({
    staff_id: row.id,
    branch_id: row.branch_id,
    permissions: parsePermissions(row.permissions_json),
  });
});

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const { id: branchId, staffId } = ctx.params;
  const body = parseBody(patchSchema, await readJson(ctx.request));

  if (auth.role === "clinic_owner") {
    await getOwnedBranch(pool, branchId, auth.userId);
  } else {
    await assertBranchStaffPermission(pool, auth, branchId, "staff:manage");
  }

  const row = await loadStaffRow(branchId, staffId);
  if (!row) throw notFound("STAFF_NOT_FOUND", "Staff member not found.");

  await pool.query(`UPDATE branch_staff SET permissions_json = ? WHERE id = ?`, [
    JSON.stringify(body.permissions),
    staffId,
  ]);

  return json({
    staff_id: row.id,
    branch_id: row.branch_id,
    permissions: body.permissions,
  });
});
