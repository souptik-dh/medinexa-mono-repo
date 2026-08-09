import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope, serializeAppointment } from "@/lib/appointments";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  const appointment = await getAppointmentInScope(pool, ctx.params.id, auth);
  return json(serializeAppointment(appointment));
});
