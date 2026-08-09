import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { conflict } from "@/lib/errors";
import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { createNotification, notifyBranchStaff } from "@/lib/notifications";

const schema = z.object({
  reason: z.string().trim().max(500).optional().nullable(),
});

export const PATCH = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "clinic_owner"]);
  const body = parseBody(schema, await readJson(ctx.request));

  await withTransaction(async (conn) => {
    const appt = await getAppointmentInScope(conn, ctx.params.id, auth);

    if (auth.role === "patient") {
      if (appt.status === "paid") {
        throw conflict(
          "CANNOT_CANCEL_PAID_APPOINTMENT",
          "A paid appointment cannot be cancelled by the patient. Contact the clinic for a refund.",
        );
      }
      if (!["pending", "confirmed"].includes(appt.status)) {
        throw conflict(
          "INVALID_STATUS_TRANSITION",
          `Cannot cancel appointment in status '${appt.status}'.`,
        );
      }
    } else if (!["pending", "confirmed", "paid"].includes(appt.status)) {
      throw conflict(
        "INVALID_STATUS_TRANSITION",
        `Cannot cancel appointment in status '${appt.status}'.`,
      );
    }

    await transition(conn, appt, "cancelled", auth.userId, ["pending", "confirmed", "paid"], body.reason ?? null);

    if (auth.role === "patient") {
      await notifyBranchStaff(conn, appt.branch_id, "appointment_cancelled", {
        appointment_id: appt.id,
        patient_id: appt.patient_id,
        reason: body.reason ?? null,
      });
    } else {
      await createNotification(conn, appt.patient_id, "appointment_cancelled", {
        appointment_id: appt.id,
        reason: body.reason ?? null,
      });
    }
    return appt;
  });

  const [rows] = await pool.query<Row[]>(`SELECT * FROM appointments WHERE id = ?`, [ctx.params.id]);
  return json(serializeAppointment(rows[0]));
});
