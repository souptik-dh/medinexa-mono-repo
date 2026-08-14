import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles, type AuthContext } from "@/lib/auth";
import { requireBranchAccess } from "@/lib/permissions";
import { notFound, forbidden } from "@/lib/errors";
import { parseBody } from "@/lib/validators";
import { getBranchOperatingDays } from "@/lib/availability";
import { newId } from "@/lib/ids";

async function loadBranch(branchId: string) {
  const [rows] = await pool.query<Row[]>(
    `SELECT b.id, c.owner_user_id
       FROM branches b
       JOIN clinics c ON c.id = b.clinic_id AND c.deleted_at IS NULL
      WHERE b.id = ? AND b.deleted_at IS NULL`,
    [branchId],
  );
  const row = rows[0];
  if (!row) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
  return row;
}

// Read access is broader than write access: any clinic_owner/branch_staff/doctor tied
// to the branch can see its operating calendar, but only branch:settings holders can
// change it (enforced separately via requireBranchAccess in PATCH below).
async function assertReadAccess(auth: AuthContext, branch: Row) {
  if (auth.role === "clinic_owner") {
    if (branch.owner_user_id !== auth.userId) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
    return;
  }
  if (auth.role === "branch_staff") {
    if (auth.branchId !== branch.id) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
    return;
  }
  if (auth.role === "doctor") {
    const [rows] = await pool.query<Row[]>(
      `SELECT 1 FROM doctor_branch_assignments WHERE doctor_id = ? AND branch_id = ? AND is_active = 1`,
      [auth.doctorId, branch.id],
    );
    if (!rows[0]) throw forbidden("PERMISSION_DENIED", "You are not assigned to this branch.");
    return;
  }
  throw forbidden("PERMISSION_DENIED", "You do not have permission to view this branch's schedule.");
}

function fullWeek(overrides: Map<number, boolean>) {
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    is_open: overrides.get(weekday) ?? true,
  }));
}

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "doctor"]);
  const branchId = ctx.params.id;
  const branch = await loadBranch(branchId);
  await assertReadAccess(auth, branch);

  const overrides = await getBranchOperatingDays(pool, branchId);
  return json({ branch_id: branchId, operating_days: fullWeek(overrides) });
});

const updateSchema = z.object({
  operating_days: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        is_open: z.boolean(),
      }),
    )
    .min(1)
    .max(7),
});

export const PATCH = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const branchId = ctx.params.id;
  await requireBranchAccess(pool, auth, branchId, "branch:settings");

  const body = parseBody(updateSchema, await readJson(ctx.request));
  for (const day of body.operating_days) {
    await pool.query(
      `INSERT INTO branch_operating_days (id, branch_id, weekday, is_open)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_open = VALUES(is_open)`,
      [newId(), branchId, day.weekday, day.is_open ? 1 : 0],
    );
  }

  const overrides = await getBranchOperatingDays(pool, branchId);
  return json({ branch_id: branchId, operating_days: fullWeek(overrides) });
});
