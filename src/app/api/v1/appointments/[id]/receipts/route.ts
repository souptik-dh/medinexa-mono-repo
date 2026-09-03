import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope } from "@/lib/appointments";
import { getReceiptsForSource, serializeReceipt } from "@/lib/receipts";

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  await getAppointmentInScope(pool, ctx.params.id, auth);

  const receipts = await getReceiptsForSource(pool, "appointment", ctx.params.id);
  return json({ data: receipts.map(serializeReceipt) });
});
