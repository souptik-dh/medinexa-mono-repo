import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);

  const [counts] = await pool.query<Row[]>(
    `SELECT
       SUM(CASE WHEN status IN ('pending','confirmed','paid') AND scheduled_date >= CURDATE() THEN 1 ELSE 0 END) AS upcoming_count,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
       SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_show_count,
       COUNT(*) AS total_count
     FROM appointments WHERE patient_id = ?`,
    [auth.userId],
  );

  const [nextRows] = await pool.query<Row[]>(
    `SELECT a.id, a.scheduled_date, a.scheduled_time, a.status,
            d.id AS doctor_id, d.name AS doctor_name,
            b.id AS branch_id, b.name AS branch_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN branches b ON b.id = a.branch_id
      WHERE a.patient_id = ? AND a.status IN ('pending','confirmed','paid') AND a.scheduled_date >= CURDATE()
      ORDER BY a.scheduled_date ASC, a.scheduled_time ASC
      LIMIT 1`,
    [auth.userId],
  );
  const next = nextRows[0];

  const c = counts[0];
  return json({
    upcoming_count: Number(c.upcoming_count),
    completed_count: Number(c.completed_count),
    cancelled_count: Number(c.cancelled_count),
    no_show_count: Number(c.no_show_count),
    total_count: Number(c.total_count),
    next_appointment: next
      ? {
          id: next.id,
          scheduled_date: next.scheduled_date,
          scheduled_time: next.scheduled_time,
          status: next.status,
          doctor_id: next.doctor_id,
          doctor_name: next.doctor_name,
          branch_id: next.branch_id,
          branch_name: next.branch_name,
        }
      : null,
  });
});
