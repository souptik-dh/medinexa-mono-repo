import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { badRequest } from "@/lib/errors";
import { getDoctorSpecializations, specializationDisplayName } from "@/lib/specializations";
import { getDoctorRatingMap } from "@/lib/reviews";
import { getDoctorClinics } from "@/lib/clinics";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export const GET = api({ rateLimit: 120 }, async (ctx) => {
  requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "doctor"]);

  const sp = ctx.request.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  if (!q) throw badRequest("VALIDATION_ERROR", "q is required.");

  const rawLimit = Number(sp.get("limit") ?? 20);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;

  const like = `%${escapeLike(q)}%`;
  const prefix = `${escapeLike(q)}%`;

  const [rows] = await pool.query<Row[]>(
    `SELECT d.id, d.name, d.reg_no, d.smc_name, d.doctor_degree, d.phone, d.photo_url
       FROM doctors d
      WHERE d.deleted_at IS NULL
        AND (d.reg_no LIKE ? OR d.name LIKE ?
             OR EXISTS (SELECT 1 FROM doctor_specialization_map dsm
                          JOIN doctor_specializations ds ON ds.id = dsm.specialization_id
                         WHERE dsm.doctor_id = d.id AND ds.name LIKE ?))
      ORDER BY (d.reg_no = ?) DESC, (d.reg_no LIKE ?) DESC, d.name ASC
      LIMIT ?`,
    [prefix, like, like, q, prefix, limit],
  );

  const specializationsByDoctor = await getDoctorSpecializations(pool, rows.map((r) => String(r.id)));
  const ratingByDoctor = await getDoctorRatingMap(pool, rows.map((r) => String(r.id)));
  const clinicsByDoctor = await getDoctorClinics(pool, rows.map((r) => String(r.id)));

  return json({
    items: rows.map((r) => {
      const specializations = specializationsByDoctor.get(String(r.id)) ?? [];
      const clinics = clinicsByDoctor.get(String(r.id)) ?? [];
      return {
        id: r.id,
        name: r.name,
        specialization: specializationDisplayName(specializations),
        specializations,
        reg_no: r.reg_no,
        smc_name: r.smc_name,
        doctor_degree: r.doctor_degree,
        phone: r.phone,
        photo_url: r.photo_url,
        clinics,
        clinic_count: clinics.length,
        rating: ratingByDoctor.get(String(r.id)) ?? { average: null, count: 0 },
      };
    }),
  });
});
