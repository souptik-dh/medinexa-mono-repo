import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";

import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { createPatientNotification, notifyBranchStaff, sendWhatsapp } from "@/lib/notifications";
import { assertBranchStaffPermission } from "@/lib/permissions";

const schema = z.object({
  reason: z.string().trim().max(500).optional().nullable(),
});

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "clinic_owner"]);
  const body = parseBody(schema, await readJson(ctx.request));

  await withTransaction(async (conn) => {
    const appt = await getAppointmentInScope(conn, ctx.params.id, auth);

    if (auth.role === "branch_staff") {
      await assertBranchStaffPermission(conn, auth, appt.branch_id, "appointments:cancel");
    }

    const allowedFrom =
      auth.role === "patient"
        ? ["pending", "confirmed"]
        : ["pending", "confirmed", "paid"];

    await transition(conn, appt, "cancelled", auth.userId, allowedFrom, body.reason ?? null);

    if (auth.role === "patient") {
      await notifyBranchStaff(conn, appt.branch_id, "appointment_cancelled", {
        appointment_id: appt.id,
        patient_id: appt.patient_id,
        reason: body.reason ?? null,
      });
    } else {
      await createPatientNotification(conn, appt.patient_id, "appointment_cancelled", {
        appointment_id: appt.id,
        date: appt.scheduled_date,
        time: appt.scheduled_time,
        reason: body.reason ?? null,
      });
    }
    return appt;
  });

  const [rows] = await pool.query<Row[]>(`SELECT * FROM appointments WHERE id = ?`, [ctx.params.id]);
  const appointment = rows[0];
  if (!appointment) throw notFound("APPOINTMENT_NOT_FOUND", "Appointment not found.");

  if (auth.role !== "patient") {
    const [details] = await pool.query<Row[]>(
      `SELECT u.phone AS patient_phone, d.name AS doctor_name, b.name AS branch_name
         FROM appointments a
         JOIN users u ON u.id = a.patient_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN branches b ON b.id = a.branch_id
        WHERE a.id = ?`,
      [ctx.params.id],
    );
    const info = details[0];
    if (info?.patient_phone) {
      void sendWhatsapp(
        info.patient_phone,
        `Jido Healthcare: Your appointment with Dr. ${info.doctor_name} at ${info.branch_name} on ${appointment.scheduled_date} at ${appointment.scheduled_time} has been cancelled.${body.reason ? ` Reason: ${body.reason}` : ""}`,
      );
    }
  }

  return json(serializeAppointment(appointment));
});
