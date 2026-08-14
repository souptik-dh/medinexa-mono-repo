import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles, type AuthContext } from "@/lib/auth";
import { requireBranchAccess } from "@/lib/permissions";
import { notFound, forbidden, badRequest } from "@/lib/errors";
import { parseBody } from "@/lib/validators";
import { newId } from "@/lib/ids";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "doctor"]);
  const branchId = ctx.params.id;
  const branch = await loadBranch(branchId);
  await assertReadAccess(auth, branch);

  const [rows] = await pool.query<Row[]>(
    `SELECT id, start_date, end_date, reason, status, created_at
       FROM branch_closures
      WHERE branch_id = ?
      ORDER BY start_date`,
    [branchId],
  );
  return json({
    items: rows.map((r) => ({
      id: r.id,
      start_date: r.start_date,
      end_date: r.end_date,
      reason: r.reason,
      status: r.status,
      created_at: r.created_at,
    })),
  });
});

const createSchema = z
  .object({
    start_date: z.string().regex(DATE_RE),
    end_date: z.string().regex(DATE_RE).optional().nullable(),
    reason: z.string().trim().max(255).optional().nullable(),
  })
  .refine((b) => !b.end_date || b.end_date >= b.start_date, {
    message: "end_date must not be before start_date.",
    path: ["end_date"],
  });

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const branchId = ctx.params.id;
  await requireBranchAccess(pool, auth, branchId, "branch:settings");

  const body = parseBody(createSchema, await readJson(ctx.request));
  const endDate = body.end_date ?? body.start_date;
  if (endDate < body.start_date) {
    throw badRequest("VALIDATION_ERROR", "end_date must not be before start_date.", "end_date");
  }

  const id = newId();
  await pool.query(
    `INSERT INTO branch_closures (id, branch_id, start_date, end_date, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, branchId, body.start_date, endDate, body.reason ?? null, auth.userId],
  );

  return json(
    {
      id,
      branch_id: branchId,
      start_date: body.start_date,
      end_date: endDate,
      reason: body.reason ?? null,
      status: "active",
    },
    201,
  );
});
