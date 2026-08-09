import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { getAppointmentInScope } from "@/lib/appointments";
import { serializePrescription } from "@/lib/prescriptions";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  await getAppointmentInScope(pool, ctx.params.id, auth);

  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM prescriptions WHERE appointment_id = ?`,
    [ctx.params.id],
  );
  const prescription = rows[0];
  if (!prescription) throw notFound("PRESCRIPTION_NOT_FOUND", "No prescription has been issued for this appointment.");

  const redactText = auth.role === "branch_staff" || auth.role === "clinic_owner";
  return json(serializePrescription(prescription, redactText));
});
