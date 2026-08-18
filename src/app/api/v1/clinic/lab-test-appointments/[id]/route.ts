import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getLabTestAppointmentInScope, serializeLabTestAppointment } from "@/lib/lab-tests";
import type { RowDataPacket } from "mysql2/promise";

export const GET = api({ rateLimit: 60 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const { id } = ctx.params;

  const row = await getLabTestAppointmentInScope(pool, id, ctx.auth!);

  const [prescriptionRows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lab_test_prescriptions WHERE appointment_id = ?`,
    [id],
  );

  const [paymentRows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lab_test_payments WHERE appointment_id = ?`,
    [id],
  );

  return json({
    ...serializeLabTestAppointment(row),
    prescriptions: prescriptionRows.map((r) => ({
      id: r.id,
      file_name: r.file_name,
      file_url: r.file_url,
      mime_type: r.mime_type,
      file_size: Number(r.file_size),
      uploaded_at: r.uploaded_at,
    })),
    payments: paymentRows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      currency: r.currency,
      payment_method: r.payment_method,
      payment_status: r.payment_status,
      transaction_id: r.transaction_id ?? null,
      provider: r.provider ?? null,
      paid_at: r.paid_at ?? null,
      collected_by: r.collected_by ?? null,
      collected_at: r.collected_at ?? null,
      reference_no: r.reference_no ?? null,
    })),
  });
});
