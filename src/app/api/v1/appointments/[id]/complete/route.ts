import { api, json } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { hasSlotPassedInTz } from "@/lib/availability";
import { createPatientNotification } from "@/lib/notifications";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { assertClinicOperational } from "@/lib/subscriptions";
import { conflict, notFound } from "@/lib/errors";
import { issueReceipt } from "@/lib/receipts";

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["branch_staff", "clinic_owner"]);

  await withTransaction(async (conn) => {
    const appt = await getAppointmentInScope(conn, ctx.params.id, auth);
    await assertClinicOperational(conn, appt.clinic_id);
    await assertBranchStaffPermission(conn, auth, appt.branch_id, "appointments:complete");
    if (!hasSlotPassedInTz(appt.scheduled_date, appt.scheduled_time, appt.branch_timezone)) {
      throw conflict(
        "APPOINTMENT_NOT_YET_DUE",
        "Cannot mark as completed before the scheduled date and time have passed.",
      );
    }
    await transition(conn, appt, "completed", auth.userId, ["paid"]);
    await createPatientNotification(conn, appt.patient_id, "consultation_completed", {
      appointment_id: appt.id,
    });
  });

  const [rows] = await pool.query<Row[]>(`SELECT * FROM appointments WHERE id = ?`, [ctx.params.id]);
  const appointment = rows[0];
  if (!appointment) throw notFound("APPOINTMENT_NOT_FOUND", "Appointment not found.");

  const [details] = await pool.query<Row[]>(
    `SELECT u.name AS patient_name, d.name AS doctor_name,
            b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone, c.name AS clinic_name
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       JOIN doctors d ON d.id = a.doctor_id
       JOIN branches b ON b.id = a.branch_id
       JOIN clinics c ON c.id = a.clinic_id
      WHERE a.id = ?`,
    [ctx.params.id],
  );
  const info = details[0];

  await issueReceipt(pool, {
    sourceType: "appointment",
    sourceId: appointment.id,
    eventType: "completed",
    patientId: appointment.patient_id,
    clinicId: appointment.clinic_id,
    branchId: appointment.branch_id,
    amount: Number(appointment.fee_amount),
    currency: appointment.currency,
    paymentMethod: appointment.payment_method ?? null,
    generatedBy: auth.userId,
    details: {
      patient_name: info?.patient_name ?? null,
      doctor_name: info?.doctor_name ?? null,
      clinic_name: info?.clinic_name ?? null,
      branch_name: info?.branch_name ?? null,
      branch_address: info?.branch_address ?? null,
      branch_phone: info?.branch_phone ?? null,
      scheduled_date: appointment.scheduled_date,
      scheduled_time: appointment.scheduled_time,
      fee_amount: Number(appointment.fee_amount),
      currency: appointment.currency,
      paid: true,
    },
  });

  return json(serializeAppointment(appointment));
});
