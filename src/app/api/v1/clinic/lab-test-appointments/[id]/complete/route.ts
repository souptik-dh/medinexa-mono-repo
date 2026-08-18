import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool, withTransaction } from "@/lib/db";
import { getLabTestAppointmentInScope, transitionLabAppointment, auditLabAction } from "@/lib/lab-tests";
import { createPatientNotification, sendEmail, detailsEmailHtml } from "@/lib/notifications";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { badRequest } from "@/lib/errors";
import type { RowDataPacket } from "mysql2/promise";

export const POST = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const { id } = ctx.params;

  const appointment = await getLabTestAppointmentInScope(pool, id, auth);

  if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, appointment.branch_id, "lab_appointments:complete");
  }

  await withTransaction(async (conn) => {
    await transitionLabAppointment(conn, appointment, "COMPLETED", auth.userId, "Test completed");
    await conn.query(
      `UPDATE lab_test_appointments SET completed_at = NOW(3) WHERE id = ?`,
      [id],
    );
    await auditLabAction(conn, auth.userId, "appointment_completed", id);
  });

  await createPatientNotification(pool, appointment.patient_id, "consultation_completed", {
    appointment_id: id,
    appointment_number: appointment.appointment_number,
    test_name: appointment.test_name,
    date: appointment.appointment_date,
    time: appointment.start_time,
  });

  const [patientRows] = await pool.query<RowDataPacket[]>(
    `SELECT name, email FROM users WHERE id = ?`,
    [appointment.patient_id],
  );
  const patient = patientRows[0];

  if (patient?.email) {
    await sendEmail(
      patient.email,
      `Lab Test Completed — ${appointment.appointment_number}`,
      `Your lab test has been completed.`,
      detailsEmailHtml({
        heading: "Lab Test Completed",
        intro: "Your lab test has been completed successfully.",
        patientFacing: true,
        rows: [
          { label: "Appointment Number", value: appointment.appointment_number },
          { label: "Test", value: appointment.test_name },
          { label: "Branch", value: appointment.branch_name },
          { label: "Date & Time", value: `${appointment.appointment_date} at ${appointment.start_time}` },
        ],
      }),
    );
  }

  return json({ success: true, status: "COMPLETED" });
});
