import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles, type AuthContext } from "@/lib/auth";
import { notFound, isUniqueViolation, conflict } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { assertBranchStaffPermission } from "@/lib/permissions";

const createSchema = z.object({
  excluded_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().max(255).optional().nullable(),
});

async function loadAssignment(assignmentId: string) {
  const [rows] = await pool.query<Row[]>(
    `SELECT dba.*, c.owner_user_id
       FROM doctor_branch_assignments dba
       JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
       JOIN clinics c ON c.id = b.clinic_id AND c.deleted_at IS NULL
      WHERE dba.id = ?`,
    [assignmentId],
  );
  const row = rows[0];
  if (!row) throw notFound("ASSIGNMENT_NOT_FOUND", "Doctor assignment not found.");
  return row;
}

async function authorize(auth: AuthContext, assignment: Row) {
  if (auth.role === "clinic_owner") {
    if (assignment.owner_user_id !== auth.userId) {
      throw notFound("ASSIGNMENT_NOT_FOUND", "Doctor assignment not found.");
    }
  } else if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, assignment.branch_id, "doctors:manage");
  } else if (auth.role === "doctor") {
    if (assignment.doctor_id !== auth.doctorId) {
      throw notFound("ASSIGNMENT_NOT_FOUND", "Doctor assignment not found.");
    }
  }
}

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "doctor", "branch_staff"]);
  const assignment = await loadAssignment(ctx.params.id);
  await authorize(auth, assignment);

  const [rows] = await pool.query<Row[]>(
    `SELECT id, excluded_date, reason, created_at
       FROM doctor_slot_exceptions
      WHERE doctor_branch_assignment_id = ?
      ORDER BY excluded_date`,
    [assignment.id],
  );
  return json({
    items: rows.map((r) => ({
      id: r.id,
      excluded_date: r.excluded_date,
      reason: r.reason,
      created_at: r.created_at,
    })),
  });
});

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "doctor", "branch_staff"]);
  const assignment = await loadAssignment(ctx.params.id);
  await authorize(auth, assignment);
  const body = parseBody(createSchema, await readJson(ctx.request));

  const id = newId();
  try {
    await pool.query(
      `INSERT INTO doctor_slot_exceptions (id, doctor_branch_assignment_id, excluded_date, reason)
       VALUES (?, ?, ?, ?)`,
      [id, assignment.id, body.excluded_date, body.reason ?? null],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("EXCEPTION_ALREADY_EXISTS", "This date is already marked unavailable.");
    }
    throw err;
  }

  return json(
    { id, doctor_branch_assignment_id: assignment.id, excluded_date: body.excluded_date, reason: body.reason ?? null },
    201,
  );
});
