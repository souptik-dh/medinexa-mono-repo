import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getBranchLabTestInScope } from "@/lib/lab-tests";
import { generateLabTestSlots } from "@/lib/lab-test-availability";
import { badRequest } from "@/lib/errors";

export const GET = api({ rateLimit: 120 }, async (ctx) => {
  requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "sys_admin"]);
  const { id: branchId, branchTestId } = ctx.params;
  const sp = ctx.request.nextUrl.searchParams;
  const date = sp.get("date");

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw badRequest("VALIDATION_ERROR", "Query parameter 'date' is required (YYYY-MM-DD).");
  }

  const blt = await getBranchLabTestInScope(pool, branchTestId, ctx.auth!);
  const slots = await generateLabTestSlots(
    pool,
    branchId,
    branchTestId,
    date,
    Number(blt.duration_minutes),
  );

  return json({ date, slots });
});
