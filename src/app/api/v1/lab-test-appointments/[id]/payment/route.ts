import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool, withTransaction } from "@/lib/db";
import { newId } from "@/lib/ids";
import { parseBody } from "@/lib/validators";
import { getLabTestAppointmentInScope, auditLabAction } from "@/lib/lab-tests";
import { createPatientNotification } from "@/lib/notifications";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

const paymentSchema = z.object({
  payment_method: z.enum(["PAY_AT_CLINIC", "ONLINE"]),
  transaction_id: z.string().max(255).optional(),
  provider: z.string().max(50).optional(),
});

export const POST = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const { id } = ctx.params;
  const body = parseBody(paymentSchema, await ctx.request.json());

  const appointment = await getLabTestAppointmentInScope(pool, id, auth);

  if (appointment.patient_id !== auth.userId) {
    throw notFound("APPOINTMENT_NOT_FOUND", "Appointment not found.");
  }

  if (!["PENDING", "APPROVED"].includes(appointment.status)) {
    throw badRequest("INVALID_APPOINTMENT_STATUS", "Cannot make payment for this appointment.");
  }

  const [existingPayment] = await pool.query<RowDataPacket[]>(
    `SELECT id, payment_status FROM lab_test_payments WHERE appointment_id = ? AND payment_status = 'PAID'`,
    [id],
  );
  if (existingPayment.length > 0) {
    throw conflict("PAYMENT_ALREADY_COMPLETED", "Payment has already been completed.");
  }

  if (body.payment_method === "ONLINE") {
    await withTransaction(async (conn) => {
      const paymentId = newId();
      await conn.query(
        `INSERT INTO lab_test_payments (id, appointment_id, patient_id, amount, currency, payment_method, payment_status, transaction_id, provider)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        [
          paymentId,
          id,
          auth.userId,
          appointment.price,
          appointment.currency,
          body.payment_method,
          body.transaction_id ?? null,
          body.provider ?? null,
        ],
      );

      await conn.query(
        `UPDATE lab_test_appointments SET payment_method = ?, payment_status = 'PENDING' WHERE id = ?`,
        [body.payment_method, id],
      );

      await auditLabAction(conn, auth.userId, "payment_initiated", id, {
        payment_method: body.payment_method,
      });
    });

    return json({
      success: true,
      message: "Payment initiated. Confirmation pending.",
    });
  }

  await withTransaction(async (conn) => {
    const paymentId = newId();
    await conn.query(
      `INSERT INTO lab_test_payments (id, appointment_id, patient_id, amount, currency, payment_method, payment_status)
       VALUES (?, ?, ?, ?, ?, ?, 'UNPAID')`,
      [paymentId, id, auth.userId, appointment.price, appointment.currency, body.payment_method],
    );

    await conn.query(
      `UPDATE lab_test_appointments SET payment_method = ?, payment_status = 'UNPAID' WHERE id = ?`,
      [body.payment_method, id],
    );

    await auditLabAction(conn, auth.userId, "payment_recorded", id, {
      payment_method: body.payment_method,
    });
  });

  return json({ success: true, message: "Payment recorded. Pay at clinic on your visit." });
});
