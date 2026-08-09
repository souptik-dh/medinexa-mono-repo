import { api, json } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { createNotification } from "@/lib/notifications";

export const PATCH = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["branch_staff", "clinic_owner"]);

  await withTransaction(async (conn) => {
    const appt = await getAppointmentInScope(conn, ctx.params.id, auth);
    await transition(conn, appt, "confirmed", auth.userId, ["pending"]);
    await createNotification(conn, appt.patient_id, "booking_confirmed", {
      appointment_id: appt.id,
      date: appt.scheduled_date,
      time: appt.scheduled_time,
    });
  });

  const [rows] = await pool.query<Row[]>(`SELECT * FROM appointments WHERE id = ?`, [ctx.params.id]);
  return json(serializeAppointment(rows[0]));
});
