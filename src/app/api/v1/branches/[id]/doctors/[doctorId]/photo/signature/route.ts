import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { createImageUploadSignature } from "@/lib/cloudinary";
import { requireBranchAccess } from "@/lib/permissions";

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  await requireBranchAccess(pool, auth, ctx.params.id, "doctors:manage");

  const [rows] = await pool.query<Row[]>(
    `SELECT d.id
       FROM doctor_branch_assignments dba
       JOIN doctors d ON d.id = dba.doctor_id AND d.deleted_at IS NULL
      WHERE dba.branch_id = ? AND dba.doctor_id = ? AND dba.is_active = 1`,
    [ctx.params.id, ctx.params.doctorId],
  );
  if (!rows[0]) throw notFound("DOCTOR_NOT_FOUND", "Doctor is not assigned to this branch.");

  return json(createImageUploadSignature("doctors"));
});
