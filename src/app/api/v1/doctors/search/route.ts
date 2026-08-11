import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { badRequest } from "@/lib/errors";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export const GET = api({ rateLimit: 60 }, async (ctx) => {
  requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "doctor"]);

  const sp = ctx.request.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  if (!q) throw badRequest("VALIDATION_ERROR", "q is required.");

  const rawLimit = Number(sp.get("limit") ?? 20);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;

  const like = `%${escapeLike(q)}%`;
  const prefix = `${escapeLike(q)}%`;

  const [rows] = await pool.query<Row[]>(
    `SELECT d.id, d.name, d.specialization, d.reg_no, d.smc_name, d.doctor_degree, d.phone, d.photo_url,
            (SELECT COUNT(DISTINCT b.clinic_id)
               FROM doctor_branch_assignments dba
               JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
              WHERE dba.doctor_id = d.id AND dba.is_active = 1) AS clinic_count
       FROM doctors d
      WHERE d.deleted_at IS NULL
        AND (d.reg_no LIKE ? OR d.name LIKE ? OR d.specialization LIKE ?)
      ORDER BY (d.reg_no = ?) DESC, (d.reg_no LIKE ?) DESC, d.name ASC
      LIMIT ?`,
    [prefix, like, like, q, prefix, limit],
  );

  return json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      specialization: r.specialization,
      reg_no: r.reg_no,
      smc_name: r.smc_name,
      doctor_degree: r.doctor_degree,
      phone: r.phone,
      photo_url: r.photo_url,
      clinic_count: Number(r.clinic_count),
    })),
  });
});
