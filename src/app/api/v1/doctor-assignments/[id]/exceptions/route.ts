import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles, type AuthContext } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { autoCancelAppointmentsInRange } from "@/lib/appointments";
import { notifyAutoCancelledDoctorAppointments } from "@/lib/schedule-cancellations";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const createSchema = z
  .object({
    excluded_date: z.string().regex(DATE_RE),
    end_date: z.string().regex(DATE_RE).optional().nullable(),
    reason: z.string().trim().max(255).optional().nullable(),
  })
  .refine((b) => !b.end_date || b.end_date >= b.excluded_date, {
    message: "end_date must not be before excluded_date.",
    path: ["end_date"],
  });

async function loadAssignment(assignmentId: string) {
  const [rows] = await pool.query<Row[]>(
    `SELECT dba.*, b.name AS branch_name, c.owner_user_id
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
    `SELECT id, excluded_date, end_date, reason, status, created_at
       FROM doctor_slot_exceptions
      WHERE doctor_branch_assignment_id = ?
      ORDER BY excluded_date`,
    [assignment.id],
  );
  return json({
    items: rows.map((r) => ({
      id: r.id,
      excluded_date: r.excluded_date,
      end_date: r.end_date ?? r.excluded_date,
      reason: r.reason,
      status: r.status,
      created_at: r.created_at,
    })),
  });
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "doctor", "branch_staff"]);
  const assignment = await loadAssignment(ctx.params.id);
  await authorize(auth, assignment);
  const body = parseBody(createSchema, await readJson(ctx.request));

  const id = newId();
  const endDate = body.end_date ?? body.excluded_date;
  const cancelReason = body.reason ? `Doctor unavailable: ${body.reason}` : "The doctor is unavailable on this date.";

  const cancelledAppts = await withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO doctor_slot_exceptions (id, doctor_branch_assignment_id, excluded_date, end_date, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [id, assignment.id, body.excluded_date, endDate, body.reason ?? null],
    );

    return autoCancelAppointmentsInRange(conn, {
      branchId: assignment.branch_id,
      doctorId: assignment.doctor_id,
      startDate: body.excluded_date,
      endDate,
      reason: cancelReason,
      changedBy: auth.userId,
    });
  });

  await notifyAutoCancelledDoctorAppointments(cancelledAppts, assignment.branch_name, cancelReason);

  return json(
    {
      id,
      doctor_branch_assignment_id: assignment.id,
      excluded_date: body.excluded_date,
      end_date: endDate,
      reason: body.reason ?? null,
      status: "active",
    },
    201,
  );
});
