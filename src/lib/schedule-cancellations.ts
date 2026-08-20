import { pool, type Row } from "@/lib/db";
import { createPatientNotification, sendEmail, detailsEmailHtml } from "@/lib/notifications";

// Shared by the branch-closure and doctor-leave routes: once a closure/leave has cascaded
// into cancelling pre-existing appointments (see autoCancelAppointmentsInRange /
// autoCancelLabTestAppointmentsInRange), these notify each affected patient in-app and by
// email — unlike a manual cancel, an auto-cancel is a surprise to the patient, so it always
// gets an email, not just an in-app notification.

export async function notifyAutoCancelledDoctorAppointments(
  cancelled: Row[],
  branchName: string,
  reason: string,
): Promise<void> {
  if (cancelled.length === 0) return;
  const [rows] = await pool.query<Row[]>(
    `SELECT a.id, a.patient_id, a.scheduled_date, a.scheduled_time,
            u.name AS patient_name, u.email AS patient_email, d.name AS doctor_name
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       JOIN doctors d ON d.id = a.doctor_id
      WHERE a.id IN (?)`,
    [cancelled.map((a) => a.id)],
  );

  for (const r of rows) {
    await createPatientNotification(pool, r.patient_id, "appointment_cancelled", {
      appointment_id: r.id,
      date: r.scheduled_date,
      time: r.scheduled_time,
      reason,
    });
    if (r.patient_email) {
      await sendEmail(
        r.patient_email,
        `Appointment Cancelled — ${branchName}`,
        `Your appointment with Dr. ${r.doctor_name} on ${r.scheduled_date} at ${r.scheduled_time} has been cancelled.\nReason: ${reason}`,
        detailsEmailHtml({
          heading: "Appointment Cancelled",
          intro: `Your appointment has been cancelled by the clinic.`,
          patientFacing: true,
          rows: [
            { label: "Doctor", value: `Dr. ${r.doctor_name}` },
            { label: "Branch", value: branchName },
            { label: "Date & Time", value: `${r.scheduled_date} at ${r.scheduled_time}` },
            { label: "Reason", value: reason },
          ],
        }),
      );
    }
  }
}

export async function notifyAutoCancelledLabTestAppointments(
  cancelled: Row[],
  branchName: string,
  reason: string,
): Promise<void> {
  if (cancelled.length === 0) return;
  const [rows] = await pool.query<Row[]>(
    `SELECT a.id, a.patient_id, a.appointment_number, a.appointment_date, a.start_time,
            u.name AS patient_name, u.email AS patient_email, lt.name AS test_name
       FROM lab_test_appointments a
       JOIN users u ON u.id = a.patient_id
       JOIN lab_tests lt ON lt.id = a.test_id
      WHERE a.id IN (?)`,
    [cancelled.map((a) => a.id)],
  );

  for (const r of rows) {
    await createPatientNotification(pool, r.patient_id, "lab_test_cancelled", {
      appointment_id: r.id,
      appointment_number: r.appointment_number,
      test_name: r.test_name,
      date: r.appointment_date,
      time: r.start_time,
      reason,
    });
    if (r.patient_email) {
      await sendEmail(
        r.patient_email,
        `Lab Test Appointment Cancelled — ${r.appointment_number}`,
        `Your ${r.test_name} appointment on ${r.appointment_date} at ${r.start_time} has been cancelled.\nReason: ${reason}`,
        detailsEmailHtml({
          heading: "Lab Test Appointment Cancelled",
          intro: `Your lab test appointment has been cancelled by the clinic.`,
          patientFacing: true,
          rows: [
            { label: "Appointment Number", value: r.appointment_number },
            { label: "Test", value: r.test_name },
            { label: "Branch", value: branchName },
            { label: "Date & Time", value: `${r.appointment_date} at ${r.start_time}` },
            { label: "Reason", value: reason },
          ],
        }),
      );
    }
  }
}
