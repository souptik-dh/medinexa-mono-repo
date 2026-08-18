import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool, withTransaction } from "@/lib/db";
import { getLabTestAppointmentInScope, transitionLabAppointment, auditLabAction } from "@/lib/lab-tests";
import { createPatientNotification, notifyBranchStaff } from "@/lib/notifications";
import type { RowDataPacket } from "mysql2/promise";

export const POST = api({ rateLimit: 10 }, async (ctx) => {
  requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "sys_admin"]);
  const { id } = ctx.params;

  const appointment = await getLabTestAppointmentInScope(pool, id, ctx.auth!);

  if (appointment.patient_id !== ctx.auth!.userId && ctx.auth!.role === "patient") {
    throw new Error("Not authorized to cancel this appointment.");
  }

  await withTransaction(async (conn) => {
    await transitionLabAppointment(conn, appointment, "CANCELLED", ctx.auth!.userId, "Cancelled by patient");
    await conn.query(
      `UPDATE lab_test_appointments SET cancelled_at = NOW(3) WHERE id = ?`,
      [id],
    );
    await auditLabAction(conn, ctx.auth!.userId, "appointment_cancelled", id);
  });

  await createPatientNotification(pool, appointment.patient_id, "lab_test_booking_cancelled", {
    appointment_id: id,
    appointment_number: appointment.appointment_number,
    test_name: appointment.test_name,
    date: appointment.appointment_date,
    time: appointment.start_time,
  });

  return json({ success: true });
});
