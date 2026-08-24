import { api, json } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { createPatientNotification, sendEmail, detailsEmailHtml } from "@/lib/notifications";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { assertClinicOperational } from "@/lib/subscriptions";
import { notFound } from "@/lib/errors";

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["branch_staff", "clinic_owner"]);

  await withTransaction(async (conn) => {
    const appt = await getAppointmentInScope(conn, ctx.params.id, auth);
    await assertClinicOperational(conn, appt.clinic_id);
    await assertBranchStaffPermission(conn, auth, appt.branch_id, "appointments:confirm");
    await transition(conn, appt, "confirmed", auth.userId, ["pending"]);
    await createPatientNotification(conn, appt.patient_id, "booking_confirmed", {
      appointment_id: appt.id,
      date: appt.scheduled_date,
      time: appt.scheduled_time,
    });
  });

  const [rows] = await pool.query<Row[]>(`SELECT * FROM appointments WHERE id = ?`, [ctx.params.id]);
  const appointment = rows[0];
  if (!appointment) throw notFound("APPOINTMENT_NOT_FOUND", "Appointment not found.");

  const [details] = await pool.query<Row[]>(
    `SELECT u.name AS patient_name, u.email AS patient_email, d.name AS doctor_name, b.name AS branch_name
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       JOIN doctors d ON d.id = a.doctor_id
       JOIN branches b ON b.id = a.branch_id
      WHERE a.id = ?`,
    [ctx.params.id],
  );
  const info = details[0];
  if (info?.patient_email) {
    const confirmBody = `Hi ${info.patient_name ?? "there"},\n\nYour appointment with Dr. ${info.doctor_name} at ${info.branch_name} on ${appointment.scheduled_date} at ${appointment.scheduled_time} has been confirmed.`;
    const confirmHtml = detailsEmailHtml({
      heading: "Appointment Confirmed",
      intro: `Hi ${info.patient_name ?? "there"}, your appointment has been confirmed.`,
      rows: [
        { label: "Doctor", value: `Dr. ${info.doctor_name}` },
        { label: "Branch", value: info.branch_name },
        { label: "Date & Time", value: `${appointment.scheduled_date} at ${appointment.scheduled_time}` },
      ],
      patientFacing: true,
    });
    await sendEmail(
      info.patient_email,
      "Your appointment is confirmed",
      confirmBody,
      confirmHtml,
    );
  }

  return json(serializeAppointment(appointment));
});
