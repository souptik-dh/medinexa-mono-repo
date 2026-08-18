import { z } from "zod";
import { api, json } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { createNotification, createPatientNotification, clinicOwnerContact, sendEmail } from "@/lib/notifications";
import { newId } from "@/lib/ids";
import { runIdempotent } from "@/lib/idempotency";
import { assertBranchStaffPermission } from "@/lib/permissions";

const schema = z.object({
  fee_amount: z.coerce.number().positive().max(1_000_000),
  method: z.enum(["cash", "upi"]),
  reference_no: z.string().trim().max(255).optional().nullable(),
});

export const PATCH = api({ rateLimit: 20 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["branch_staff", "clinic_owner"]);
  const idemKey = ctx.request.headers.get("idempotency-key");
  if (!idemKey) {
    throw badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key header is required for this endpoint.",
    );
  }

  const rawBody = await ctx.request.text();
  let parsedJson: Record<string, unknown>;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    throw badRequest("INVALID_JSON", "Request body must be a valid JSON object.");
  }
  const body = parseBody(schema, parsedJson);

  const result = await runIdempotent(`appointments:${ctx.params.id}:payment`, idemKey, rawBody, async () => {
    const paymentId = newId();
    await withTransaction(async (conn) => {
      const appt = await getAppointmentInScope(conn, ctx.params.id, auth);
      await assertBranchStaffPermission(conn, auth, appt.branch_id, "appointments:payment");
      await transition(conn, appt, "paid", auth.userId, ["confirmed"]);
      await conn.query(
        `INSERT INTO payments (id, appointment_id, amount, currency, method, collected_by, reference_no)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          paymentId,
          appt.id,
          body.fee_amount,
          appt.currency,
          body.method,
          auth.userId,
          body.reference_no ?? null,
        ],
      );
      await conn.query(
        `UPDATE appointments SET payment_method = ? WHERE id = ?`,
        [body.method, appt.id],
      );
      await conn.query(
        `INSERT INTO clinic_payment_ledger (id, clinic_id, branch_id, period_month, currency, total_amount, payment_count)
         VALUES (?, ?, ?, DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m'), ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           total_amount = total_amount + VALUES(total_amount),
           payment_count = payment_count + 1`,
        [newId(), appt.clinic_id, appt.branch_id, appt.currency, body.fee_amount],
      );
      await createPatientNotification(conn, appt.patient_id, "payment_received", {
        appointment_id: appt.id,
        amount: body.fee_amount,
        method: body.method,
      });
      const owner = await clinicOwnerContact(conn, appt.clinic_id);
      if (owner) {
        await createNotification(
          conn,
          owner.userId,
          "payment_received",
          {
            appointment_id: appt.id,
            patient_id: appt.patient_id,
            amount: body.fee_amount,
            method: body.method,
          },
          appt.branch_id,
        );
      }
    });

    const [rows] = await pool.query<Row[]>(`SELECT * FROM appointments WHERE id = ?`, [ctx.params.id]);
    const appointment = rows[0];
    if (!appointment) throw notFound("APPOINTMENT_NOT_FOUND", "Appointment not found.");

    const [details] = await pool.query<Row[]>(
      `SELECT u.name AS patient_name, co.email AS owner_email, b.name AS branch_name
         FROM appointments a
         JOIN users u ON u.id = a.patient_id
         JOIN clinics c ON c.id = a.clinic_id
         JOIN users co ON co.id = c.owner_user_id
         JOIN branches b ON b.id = a.branch_id
        WHERE a.id = ?`,
      [ctx.params.id],
    );
    const info = details[0];
    if (info?.owner_email) {
      await sendEmail(
        info.owner_email,
        `Payment received — ${info.patient_name ?? "Patient"}`,
        `A payment of ${body.fee_amount} ${appointment.currency} was collected via ${body.method} from ${info.patient_name ?? "a patient"} at ${info.branch_name}.${body.reference_no ? `\nReference: ${body.reference_no}` : ""}`,
      );
    }

    return { status: 200, body: serializeAppointment(appointment) };
  });

  return json(result.body, result.status);
});
