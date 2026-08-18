import { api, json, readJson } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { getLabTestInScope, auditLabAction } from "@/lib/lab-tests";
import { z } from "zod";

const statusSchema = z.object({
  status: z.enum(["active", "inactive"]),
});

export const PATCH = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "sys_admin"]);
  const { id } = ctx.params;
  const body = parseBody(statusSchema, await readJson(ctx.request));

  await getLabTestInScope(pool, id, auth);

  await pool.query(`UPDATE lab_tests SET status = ? WHERE id = ?`, [body.status, id]);

  await auditLabAction(pool, auth.userId, "lab_test_status_changed", id, { status: body.status });

  return json({ success: true, status: body.status });
});
