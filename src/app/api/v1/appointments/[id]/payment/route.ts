import { z } from "zod";
import { api, json } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { badRequest } from "@/lib/errors";
import { getAppointmentInScope, transition, serializeAppointment } from "@/lib/appointments";
import { createNotification } from "@/lib/notifications";
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
      await createNotification(conn, appt.patient_id, "payment_received", {
        appointment_id: appt.id,
        amount: body.fee_amount,
        method: body.method,
      });
    });
    const [rows] = await pool.query<Row[]>(`SELECT * FROM appointments WHERE id = ?`, [ctx.params.id]);
    return { status: 200, body: serializeAppointment(rows[0]) };
  });

  return json(result.body, result.status);
});
