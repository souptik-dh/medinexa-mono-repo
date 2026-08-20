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
import {
  createPatientNotification,
  branchContactEmails,
  sendEmail,
  detailsEmailHtml,
  patientEmailHtml,
} from "@/lib/notifications";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { badRequest } from "@/lib/errors";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

const approveSchema = z.object({
  precautions: z.array(z.string().max(500)).optional(),
  clinic_notes: z.string().max(1000).optional(),
});

export const POST = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const { id } = ctx.params;
  const body = parseBody(approveSchema, await ctx.request.json());

  const appointment = await getLabTestAppointmentInScope(pool, id, auth);

  if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, appointment.branch_id, "lab_appointments:approve");
  }

  if (appointment.prescription_required && !appointment.prescription_id) {
    throw badRequest("PRESCRIPTION_REQUIRED", "Cannot approve — prescription is required but not uploaded.");
  }

  let finalPrecautions: string[] = [];
  if (appointment.precautions) {
    const existing = typeof appointment.precautions === "string"
      ? JSON.parse(appointment.precautions)
      : appointment.precautions;
    if (Array.isArray(existing)) {
      finalPrecautions = [...existing];
    }
  }
  if (body.precautions && body.precautions.length > 0) {
    finalPrecautions = [...finalPrecautions, ...body.precautions];
  }

  await withTransaction(async (conn) => {
    await transitionLabAppointment(conn, appointment, "APPROVED", auth.userId, "Approved by clinic");
    await conn.query(
      `UPDATE lab_test_appointments SET
        approved_by = ?, approved_at = NOW(3),
        clinic_notes = COALESCE(?, clinic_notes),
        precautions = ?
       WHERE id = ?`,
      [
        auth.userId,
        body.clinic_notes ?? null,
        finalPrecautions.length > 0 ? JSON.stringify(finalPrecautions) : null,
        id,
      ],
    );
    await auditLabAction(conn, auth.userId, "appointment_approved", id, {
      precautions: body.precautions,
      clinic_notes: body.clinic_notes,
    });
  });

  await createPatientNotification(pool, appointment.patient_id, "lab_test_approved", {
    appointment_id: id,
    appointment_number: appointment.appointment_number,
    test_name: appointment.test_name,
    date: appointment.appointment_date,
    time: appointment.start_time,
    branch_name: appointment.branch_name,
    precautions: finalPrecautions,
  });

  const [patientRows] = await pool.query<RowDataPacket[]>(
    `SELECT name, email FROM users WHERE id = ?`,
    [appointment.patient_id],
  );
  const patient = patientRows[0];

  const emailHtml = detailsEmailHtml({
    heading: "Lab Test Appointment Confirmed",
    intro: `Your lab test appointment has been approved by the clinic.`,
    patientFacing: true,
    rows: [
      { label: "Appointment Number", value: appointment.appointment_number },
      { label: "Test", value: appointment.test_name },
      { label: "Branch", value: appointment.branch_name },
      { label: "Date & Time", value: `${appointment.appointment_date} at ${appointment.start_time}`, sub: appointment.service_mode === "HOME" ? "Home Collection" : "Clinic Visit" },
      { label: "Payment", value: appointment.payment_status === "PAID" ? "Paid" : "Pay at Clinic" },
      ...(finalPrecautions.length > 0 ? [{ label: "Precautions", value: finalPrecautions.join("\n") }] : []),
      ...(body.clinic_notes ? [{ label: "Clinic Notes", value: body.clinic_notes }] : []),
    ],
  });

  if (patient?.email) {
    await sendEmail(patient.email, `Lab Test Confirmed — ${appointment.appointment_number}`, "", emailHtml);
  }

  const updated = await getLabTestAppointmentInScope(pool, id, auth);
  return json(serializeLabTestAppointment(updated));
});
