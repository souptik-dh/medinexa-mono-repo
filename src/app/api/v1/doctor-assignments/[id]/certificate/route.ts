import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { uploadDocumentToCloudinary } from "@/lib/cloudinary";

const CERTIFICATE_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_BYTES = 10 * 1024 * 1024;

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

// The certificate lives on `doctors.certificate_url`, not on the assignment row
// itself (doctor_branch_assignments has no certificate column) — same target
// column the PATCH handler on /doctor-assignments/[id] already writes to.
export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "doctor", "branch_staff"]);
  const assignment = await loadAssignment(ctx.params.id);

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

  const form = await ctx.request.formData();
  const uploaded = await uploadDocumentToCloudinary(
    form.get("file"),
    "doctors/certificates",
    MAX_BYTES,
    CERTIFICATE_MIMES,
  );

  await pool.query(`UPDATE doctors SET certificate_url = ? WHERE id = ?`, [
    uploaded.url,
    assignment.doctor_id,
  ]);

  return json({ certificate_url: uploaded.url });
});
