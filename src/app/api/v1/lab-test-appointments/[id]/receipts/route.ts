import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getLabTestAppointmentInScope } from "@/lib/lab-tests";
import { getReceiptsForSource, serializeReceipt } from "@/lib/receipts";

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "clinic_owner"]);
  await getLabTestAppointmentInScope(pool, ctx.params.id, auth);

  const receipts = await getReceiptsForSource(pool, "lab_test_appointment", ctx.params.id);
  return json({ data: receipts.map(serializeReceipt) });
});
