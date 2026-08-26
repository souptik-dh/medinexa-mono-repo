import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { loadStaffPermissions, hasPermission } from "@/lib/permissions";
import { getDoctorSpecializations, specializationDisplayName } from "@/lib/specializations";
import { getDoctorClinics } from "@/lib/clinics";

// Lists doctors already actively assigned somewhere in this clinic - used by
// the "add existing doctor to another branch" fast-track picker, so clinic
// staff can pick a doctor instead of retyping their email from memory.
export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const clinicId = ctx.params.clinicId;

  const [clinics] = await pool.query<Row[]>(
    `SELECT id, owner_user_id FROM clinics WHERE id = ? AND deleted_at IS NULL`,
    [clinicId],
  );
  const clinic = clinics[0];
  if (!clinic) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");

  if (auth.role === "clinic_owner" && clinic.owner_user_id !== auth.userId) {
    throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");
  }
  if (auth.role === "branch_staff") {
    if (!auth.branchId) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");
    const [staffBranch] = await pool.query<Row[]>(
      `SELECT clinic_id FROM branches WHERE id = ? AND deleted_at IS NULL`,
      [auth.branchId],
    );
    if (!staffBranch[0] || String(staffBranch[0].clinic_id) !== String(clinicId)) {
      throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");
    }
    const perms = await loadStaffPermissions(pool, auth.branchId, auth.userId);
    if (!hasPermission(perms, "doctors:manage")) {
      throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");
    }
  }

  const excludeBranchId = ctx.request.nextUrl.searchParams.get("exclude_branch_id");

  const [clinicDoctorRows] = await pool.query<Row[]>(
    `SELECT DISTINCT dba.doctor_id
       FROM doctor_branch_assignments dba
       JOIN branches b ON b.id = dba.branch_id
      WHERE b.clinic_id = ? AND dba.is_active = 1`,
    [clinicId],
  );
  let doctorIds = clinicDoctorRows.map((r) => String(r.doctor_id));

  if (excludeBranchId && doctorIds.length > 0) {
    const [excludeRows] = await pool.query<Row[]>(
      `SELECT doctor_id FROM doctor_branch_assignments
        WHERE branch_id = ? AND is_active = 1 AND doctor_id IN (?)`,
      [excludeBranchId, doctorIds],
    );
    const excludeSet = new Set(excludeRows.map((r) => String(r.doctor_id)));
    doctorIds = doctorIds.filter((id) => !excludeSet.has(id));
  }

  if (doctorIds.length === 0) {
    return json({ items: [] });
  }

  const [doctorRows] = await pool.query<Row[]>(
    `SELECT id, name, phone, photo_url, doctor_degree, smc_name
       FROM doctors WHERE id IN (?) AND deleted_at IS NULL ORDER BY name ASC`,
    [doctorIds],
  );

  const specializationsByDoctor = await getDoctorSpecializations(
    pool,
    doctorRows.map((r) => String(r.id)),
  );
  const clinicsByDoctor = await getDoctorClinics(pool, doctorRows.map((r) => String(r.id)));

  return json({
    items: doctorRows.map((r) => {
      const specializations = specializationsByDoctor.get(String(r.id)) ?? [];
      const branches = (clinicsByDoctor.get(String(r.id)) ?? [])
        .filter((c) => String(c.clinic_id) === String(clinicId))
        .map((c) => ({ branch_id: c.branch_id, branch_name: c.branch_name }));
      return {
        id: r.id,
        name: r.name,
        specialization: specializationDisplayName(specializations),
        specializations,
        phone: r.phone,
        photo_url: r.photo_url,
        doctor_degree: r.doctor_degree,
        smc_name: r.smc_name,
        branches,
      };
    }),
  });
});
