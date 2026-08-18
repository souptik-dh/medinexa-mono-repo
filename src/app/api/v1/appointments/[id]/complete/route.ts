import { api, json } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { createPatientNotification } from "@/lib/notifications";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { notFound } from "@/lib/errors";

export const PATCH = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["branch_staff", "clinic_owner"]);

  await withTransaction(async (conn) => {
    const appt = await getAppointmentInScope(conn, ctx.params.id, auth);
    await assertBranchStaffPermission(conn, auth, appt.branch_id, "appointments:complete");
    await transition(conn, appt, "completed", auth.userId, ["paid"]);
    await createPatientNotification(conn, appt.patient_id, "consultation_completed", {
      appointment_id: appt.id,
    });
  });

  const [rows] = await pool.query<Row[]>(`SELECT * FROM appointments WHERE id = ?`, [ctx.params.id]);
  const appointment = rows[0];
  if (!appointment) throw notFound("APPOINTMENT_NOT_FOUND", "Appointment not found.");
  return json(serializeAppointment(appointment));
});
