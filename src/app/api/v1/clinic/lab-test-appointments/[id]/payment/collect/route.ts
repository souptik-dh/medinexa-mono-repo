import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool, withTransaction } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { getLabTestAppointmentInScope, auditLabAction, serializeLabTestPayment } from "@/lib/lab-tests";
import { createPatientNotification } from "@/lib/notifications";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

const collectSchema = z.object({
  reference_no: z.string().max(255).optional(),
});

export const POST = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const { id } = ctx.params;
  const body = parseBody(collectSchema, await ctx.request.json());

  const appointment = await getLabTestAppointmentInScope(pool, id, auth);

  if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, appointment.branch_id, "lab_payments:collect");
  }

  if (appointment.payment_status === "PAID") {
    throw conflict("PAYMENT_ALREADY_COLLECTED", "Payment has already been collected.");
  }

  if (appointment.payment_method !== "PAY_AT_CLINIC") {
    throw badRequest("INVALID_PAYMENT_METHOD", "Can only collect payment for pay-at-clinic appointments.");
  }

  if (!["APPROVED", "COMPLETED"].includes(appointment.status)) {
    throw conflict(
      "INVALID_STATUS_TRANSITION",
      "Payment can only be collected for approved or completed appointments.",
    );
  }

  await withTransaction(async (conn) => {
    await conn.query(
      `UPDATE lab_test_payments SET
        payment_status = 'PAID',
        collected_by = ?,
        collected_at = NOW(3),
        paid_at = NOW(3),
        reference_no = ?
       WHERE appointment_id = ? AND payment_status != 'PAID'`,
      [auth.userId, body.reference_no ?? null, id],
    );

    await conn.query(
      `UPDATE lab_test_appointments SET payment_status = 'PAID' WHERE id = ?`,
      [id],
    );

    await auditLabAction(conn, auth.userId, "payment_collected", id, {
      reference_no: body.reference_no,
    });
  });

  await createPatientNotification(pool, appointment.patient_id, "lab_test_payment_success", {
    appointment_id: id,
    appointment_number: appointment.appointment_number,
    test_name: appointment.test_name,
    date: appointment.appointment_date,
    amount: appointment.price,
    currency: appointment.currency,
  });

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lab_test_payments WHERE appointment_id = ? ORDER BY updated_at DESC LIMIT 1`,
    [id],
  );
  return json(serializeLabTestPayment(rows[0]));
});
