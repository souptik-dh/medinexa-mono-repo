import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { requireAssignedDoctor, serializePrescription } from "@/lib/prescriptions";
import { getAppointmentInScope } from "@/lib/appointments";
import { createPatientNotification } from "@/lib/notifications";
import { newId } from "@/lib/ids";

const schema = z.object({
  text: z.string().trim().min(1).max(50_000),
  scan_url: z.string().trim().max(500).optional().nullable(),
});

export const PUT = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["doctor"]);
  const appointment = await requireAssignedDoctor(pool, ctx.params.id, auth);
  const body = parseBody(schema, await readJson(ctx.request));

  const id = newId();
  const finalizedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
  await withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO prescriptions (id, appointment_id, doctor_id, scan_url, digitized_text, finalized_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE scan_url = ?, digitized_text = ?, finalized_at = ?`,
      [
        id,
        appointment.id,
        auth.doctorId,
        body.scan_url ?? null,
        body.text,
        finalizedAt,
        body.scan_url ?? null,
        body.text,
        finalizedAt,
      ],
    );
    await createPatientNotification(conn, appointment.patient_id, "prescription_ready", {
      appointment_id: appointment.id,
      doctor_id: appointment.doctor_id,
    });
  });

  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM prescriptions WHERE appointment_id = ?`,
    [appointment.id],
  );
  return json(serializePrescription(rows[0], false));
});

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  await getAppointmentInScope(pool, ctx.params.id, auth);

  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM prescriptions WHERE appointment_id = ?`,
    [ctx.params.id],
  );
  const prescription = rows[0];
  if (!prescription) {
    throw notFound("PRESCRIPTION_NOT_FOUND", "No prescription has been issued for this appointment.");
  }

  const redactText = auth.role === "branch_staff" || auth.role === "clinic_owner";
  return json(serializePrescription(prescription, redactText));
});
