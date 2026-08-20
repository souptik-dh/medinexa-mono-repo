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
import { createPatientNotification } from "@/lib/notifications";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { forbidden } from "@/lib/errors";
import { z } from "zod";

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const POST = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "sys_admin"]);
  const { id } = ctx.params;
  const body = parseBody(cancelSchema, await ctx.request.json());

  const appointment = await getLabTestAppointmentInScope(pool, id, auth);

  if (auth.role === "patient") {
    if (appointment.patient_id !== auth.userId) {
      throw forbidden("NOT_AUTHORIZED", "Not authorized to cancel this appointment.");
    }
  } else if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, appointment.branch_id, "lab_appointments:cancel");
  }

  const note = body.reason ?? (auth.role === "patient" ? "Cancelled by patient" : "Cancelled by clinic");

  await withTransaction(async (conn) => {
    await transitionLabAppointment(conn, appointment, "CANCELLED", auth.userId, note);
    await conn.query(
      `UPDATE lab_test_appointments SET cancelled_at = NOW(3) WHERE id = ?`,
      [id],
    );
    await auditLabAction(conn, auth.userId, "appointment_cancelled", id, { reason: body.reason });
  });

  await createPatientNotification(pool, appointment.patient_id, "lab_test_cancelled", {
    appointment_id: id,
    appointment_number: appointment.appointment_number,
    test_name: appointment.test_name,
    date: appointment.appointment_date,
    time: appointment.start_time,
  });

  const updated = await getLabTestAppointmentInScope(pool, id, auth);
  return json(serializeLabTestAppointment(updated));
});
