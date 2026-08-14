import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";

// Public — drives category chips on a patient-facing browse/home screen.
// `specialization` is free text (doctors.specialization VARCHAR(255), no lookup table),
// so this is just the distinct non-null values in use, most common first.
export const GET = api({ rateLimit: 60 }, async () => {
  const [rows] = await pool.query<Row[]>(
    `SELECT d.specialization, COUNT(DISTINCT dba.id) AS doctor_count
       FROM doctors d
       JOIN doctor_branch_assignments dba ON dba.doctor_id = d.id AND dba.is_active = 1
       JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
      WHERE d.deleted_at IS NULL AND d.specialization IS NOT NULL AND d.specialization != ''
      GROUP BY d.specialization
      ORDER BY doctor_count DESC, d.specialization ASC`,
  );

  return json({
    items: rows.map((r) => ({
      specialization: r.specialization,
      doctor_count: Number(r.doctor_count),
    })),
  });
});
