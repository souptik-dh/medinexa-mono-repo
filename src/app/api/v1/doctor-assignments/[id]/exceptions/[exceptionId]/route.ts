import { api, noContent } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles, type AuthContext } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { assertBranchStaffPermission } from "@/lib/permissions";

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

export const DELETE = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "doctor", "branch_staff"]);
  const { id: assignmentId, exceptionId } = ctx.params;
  const assignment = await loadAssignment(assignmentId);
  await authorize(auth, assignment);

  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM doctor_slot_exceptions WHERE id = ? AND doctor_branch_assignment_id = ?`,
    [exceptionId, assignment.id],
  );
  if (!rows[0]) throw notFound("EXCEPTION_NOT_FOUND", "Availability exception not found.");

  // Soft-cancel rather than hard-delete: preserves the leave as an audit record while
  // immediately restoring availability for its date range (status='active' is the only
  // thing every availability/booking query checks).
  await pool.query(`UPDATE doctor_slot_exceptions SET status = 'cancelled' WHERE id = ?`, [exceptionId]);
  return noContent();
});
