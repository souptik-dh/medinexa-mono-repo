import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool, withTransaction } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import {
  getLabTestAppointmentInScope,
  transitionLabAppointment,
  auditLabAction,
  serializeLabTestAppointment,
} from "@/lib/lab-tests";
import { createPatientNotification, sendEmail, detailsEmailHtml, sendSms, sendWhatsapp } from "@/lib/notifications";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { assertClinicOperational } from "@/lib/subscriptions";
import { badRequest } from "@/lib/errors";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

const rejectSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const { id } = ctx.params;
  const body = parseBody(rejectSchema, await ctx.request.json());

  const appointment = await getLabTestAppointmentInScope(pool, id, auth);

  if (auth.role !== "sys_admin") {
    await assertClinicOperational(pool, appointment.clinic_id);
  }

  if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, appointment.branch_id, "lab_appointments:reject");
  }

  await withTransaction(async (conn) => {
    await transitionLabAppointment(conn, appointment, "REJECTED", auth.userId, body.reason);
    await conn.query(
      `UPDATE lab_test_appointments SET rejected_by = ?, rejected_at = NOW(3), rejection_reason = ? WHERE id = ?`,
      [auth.userId, body.reason, id],
    );
    await auditLabAction(conn, auth.userId, "appointment_rejected", id, { reason: body.reason });
  });

  await createPatientNotification(pool, appointment.patient_id, "lab_test_rejected", {
    appointment_id: id,
    appointment_number: appointment.appointment_number,
    test_name: appointment.test_name,
    date: appointment.appointment_date,
    time: appointment.start_time,
    reason: body.reason,
  });

  const [patientRows] = await pool.query<RowDataPacket[]>(
    `SELECT name, email, phone FROM users WHERE id = ?`,
    [appointment.patient_id],
  );
  const patient = patientRows[0];

  if (patient?.phone) {
    const rejectText = `Jido Healthcare: Your lab test booking ${appointment.appointment_number} (${appointment.test_name}) has been rejected. Reason: ${body.reason}`;
    await Promise.allSettled([sendSms(patient.phone, rejectText), sendWhatsapp(patient.phone, rejectText)]);
  }
  if (patient?.email) {
    await sendEmail(
      patient.email,
      `Lab Test Booking Rejected — ${appointment.appointment_number}`,
      `Your lab test booking has been rejected.\nReason: ${body.reason}`,
      detailsEmailHtml({
        heading: "Lab Test Booking Rejected",
        intro: "Your lab test booking has been reviewed and rejected by the clinic.",
        patientFacing: true,
        rows: [
          { label: "Appointment Number", value: appointment.appointment_number },
          { label: "Test", value: appointment.test_name },
          { label: "Branch", value: appointment.branch_name },
          { label: "Date & Time", value: `${appointment.appointment_date} at ${appointment.start_time}` },
          { label: "Reason", value: body.reason },
        ],
      }),
    );
  }

  const updated = await getLabTestAppointmentInScope(pool, id, auth);
  return json(serializeLabTestAppointment(updated));
});
