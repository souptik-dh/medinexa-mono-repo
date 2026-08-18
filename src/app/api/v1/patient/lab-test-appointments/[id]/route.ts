import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getLabTestAppointmentInScope, serializeLabTestAppointment } from "@/lib/lab-tests";

export const GET = api({ rateLimit: 60 }, async (ctx) => {
  requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "sys_admin"]);
  const { id } = ctx.params;

  const row = await getLabTestAppointmentInScope(pool, id, ctx.auth!);
  return json(serializeLabTestAppointment(row));
});
