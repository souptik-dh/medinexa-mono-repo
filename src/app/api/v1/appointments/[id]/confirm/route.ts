import { api, json } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { createPatientNotification, sendEmail, detailsEmailHtml, sendSms, sendWhatsapp } from "@/lib/notifications";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { assertClinicOperational } from "@/lib/subscriptions";
import { notFound } from "@/lib/errors";
import { issueReceipt } from "@/lib/receipts";

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
    `SELECT u.name AS patient_name, u.email AS patient_email, u.phone AS patient_phone,
            d.name AS doctor_name, b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone, c.name AS clinic_name
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       JOIN doctors d ON d.id = a.doctor_id
       JOIN branches b ON b.id = a.branch_id
       JOIN clinics c ON c.id = a.clinic_id
      WHERE a.id = ?`,
    [ctx.params.id],
  );
  const info = details[0];

  const receipt = await issueReceipt(pool, {
    sourceType: "appointment",
    sourceId: appointment.id,
    eventType: "booking_confirmed",
    patientId: appointment.patient_id,
    clinicId: appointment.clinic_id,
    branchId: appointment.branch_id,
    amount: Number(appointment.fee_amount),
    currency: appointment.currency,
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
      paid: false,
    },
  });
  const confirmText = `Jido Healthcare: Your appointment with Dr. ${info.doctor_name} at ${info.branch_name} on ${appointment.scheduled_date} at ${appointment.scheduled_time} has been confirmed.`;
  const whatsappConfirmText = `${confirmText}${receipt ? ` Receipt No: ${receipt.receiptNumber}.` : ""}`;
  const smsConfirm = () => sendSms(info.patient_phone, confirmText);
  const whatsappConfirm = () => sendWhatsapp(info.patient_phone, whatsappConfirmText);
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
  if (info?.patient_phone) await Promise.allSettled([smsConfirm(), whatsappConfirm()]);

  return json(serializeAppointment(appointment));
});
