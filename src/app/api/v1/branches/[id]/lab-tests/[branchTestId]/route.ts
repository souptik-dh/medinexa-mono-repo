import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getBranchLabTestInScope, serializeBranchLabTest } from "@/lib/lab-tests";

export const GET = api({ rateLimit: 120 }, async (ctx) => {
  requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "sys_admin"]);
  const { branchTestId } = ctx.params;

  const row = await getBranchLabTestInScope(pool, branchTestId, ctx.auth!);
  return json(serializeBranchLabTest(row));
});
