import { z } from "zod";
import { api, json } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { createNotification, createPatientNotification, clinicOwnerContact, sendEmail, detailsEmailHtml, sendSms, sendWhatsapp } from "@/lib/notifications";
import { newId } from "@/lib/ids";
import { runIdempotent } from "@/lib/idempotency";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { assertClinicOperational } from "@/lib/subscriptions";
import { issueReceipt } from "@/lib/receipts";

const schema = z.object({
  fee_amount: z.coerce.number().positive().max(1_000_000),
  method: z.enum(["cash", "upi"]),
  reference_no: z.string().trim().max(255).optional().nullable(),
});

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
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
      await assertClinicOperational(conn, appt.clinic_id);
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
      `SELECT u.name AS patient_name, u.phone AS patient_phone, co.email AS owner_email, co.phone AS owner_phone,
              b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone, c.name AS clinic_name, d.name AS doctor_name
         FROM appointments a
         JOIN users u ON u.id = a.patient_id
         JOIN clinics c ON c.id = a.clinic_id
         JOIN users co ON co.id = c.owner_user_id
         JOIN branches b ON b.id = a.branch_id
         JOIN doctors d ON d.id = a.doctor_id
        WHERE a.id = ?`,
      [ctx.params.id],
    );
    const info = details[0];

    const receipt = await issueReceipt(pool, {
      sourceType: "appointment",
      sourceId: appointment.id,
      eventType: "payment_received",
      patientId: appointment.patient_id,
      clinicId: appointment.clinic_id,
      branchId: appointment.branch_id,
      amount: body.fee_amount,
      currency: appointment.currency,
      paymentMethod: body.method,
      referenceNo: body.reference_no ?? null,
      generatedBy: auth.userId,
      details: {
        patient_name: info?.patient_name ?? null,
        doctor_name: info?.doctor_name ?? null,
        clinic_name: info?.clinic_name ?? null,
        branch_name: info?.branch_name ?? null,
        branch_address: info?.branch_address ?? null,
        branch_phone: info?.branch_phone ?? null,
        scheduled_date: appointment.scheduled_date,
        scheduled_time: appointment.scheduled_time,
        amount: body.fee_amount,
        currency: appointment.currency,
        payment_method: body.method,
        reference_no: body.reference_no ?? null,
        paid: true,
      },
    });
    if (info?.owner_phone) {
      await sendSms(
        info.owner_phone,
        `Jido Healthcare: Payment of ${body.fee_amount} ${appointment.currency} collected via ${body.method} from ${info.patient_name ?? "a patient"} at ${info.branch_name}.`,
      );
    }
    if (info?.patient_phone) {
      void sendWhatsapp(
        info.patient_phone,
        `Jido Healthcare: Payment of ${body.fee_amount} ${appointment.currency} received for your appointment with Dr. ${info.doctor_name} at ${info.branch_name} on ${appointment.scheduled_date} at ${appointment.scheduled_time}.${receipt ? ` Receipt No: ${receipt.receiptNumber}.` : ""}`,
      );
    }
    if (info?.owner_email) {
      const paymentBody = `A payment of ${body.fee_amount} ${appointment.currency} was collected via ${body.method} from ${info.patient_name ?? "a patient"} at ${info.branch_name}.${body.reference_no ? `\nReference: ${body.reference_no}` : ""}`;
      const paymentHtml = detailsEmailHtml({
        heading: "Payment Received",
        intro: `A payment was collected at ${info.branch_name}.`,
        rows: [
          { label: "Amount", value: `${body.fee_amount} ${appointment.currency}` },
          { label: "Method", value: body.method },
          { label: "Patient", value: info.patient_name ?? "a patient" },
          { label: "Branch", value: info.branch_name },
          ...(body.reference_no ? [{ label: "Reference", value: body.reference_no }] : []),
        ],
      });
      await sendEmail(
        info.owner_email,
        `Payment received — ${info.patient_name ?? "Patient"}`,
        paymentBody,
        paymentHtml,
      );
    }

    return { status: 200, body: serializeAppointment(appointment) };
  });

  return json(result.body, result.status);
});
