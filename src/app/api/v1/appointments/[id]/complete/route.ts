import { api, json } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { createNotification } from "@/lib/notifications";

export const PATCH = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["branch_staff", "clinic_owner"]);

  await withTransaction(async (conn) => {
    const appt = await getAppointmentInScope(conn, ctx.params.id, auth);
    await transition(conn, appt, "completed", auth.userId, ["paid"]);
    await createNotification(conn, appt.patient_id, "consultation_completed", {
      appointment_id: appt.id,
    });
  });

  const [rows] = await pool.query<Row[]>(`SELECT * FROM appointments WHERE id = ?`, [ctx.params.id]);
  return json(serializeAppointment(rows[0]));
});
