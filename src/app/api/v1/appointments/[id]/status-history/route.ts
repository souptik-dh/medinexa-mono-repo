import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope } from "@/lib/appointments";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  const appointment = await getAppointmentInScope(pool, ctx.params.id, auth);

  const [rows] = await pool.query<Row[]>(
    `SELECT from_status, to_status, changed_by, changed_at, note
       FROM appointment_status_log
      WHERE appointment_id = ? ORDER BY changed_at ASC`,
    [appointment.id],
  );

  return json({
    items: rows.map((r) => ({
      from_status: r.from_status,
      to_status: r.to_status,
      changed_by: r.changed_by,
      changed_at: r.changed_at,
      note: r.note,
    })),
  });
});
