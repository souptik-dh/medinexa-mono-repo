import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { newId } from "@/lib/ids";
import { parseBody } from "@/lib/validators";
import { serializeLabTest, getLabTestInScope, auditLabAction } from "@/lib/lab-tests";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  code: z.string().min(1).max(50).optional(),
  description: z.string().max(2000).optional(),
  category: z.enum(["blood_test", "cardiology", "diabetes", "urine_test", "imaging", "general_diagnostics", "health_check", "other"]).optional(),
  instructions: z.string().max(2000).optional(),
  default_precautions: z.array(z.string().max(500)).optional(),
});

export const PUT = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "sys_admin"]);
  const { id } = ctx.params;
  const body = parseBody(updateSchema, await ctx.request.json());

  const existing = await getLabTestInScope(pool, id, auth);

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.name !== undefined) { updates.push("name = ?"); params.push(body.name); }
  if (body.code !== undefined) { updates.push("code = ?"); params.push(body.code); }
  if (body.description !== undefined) { updates.push("description = ?"); params.push(body.description); }
  if (body.category !== undefined) { updates.push("category = ?"); params.push(body.category); }
  if (body.instructions !== undefined) { updates.push("instructions = ?"); params.push(body.instructions); }
  if (body.default_precautions !== undefined) {
    updates.push("default_precautions = ?");
    params.push(JSON.stringify(body.default_precautions));
  }

  if (updates.length === 0) {
    return json(serializeLabTest(existing));
  }

  params.push(id);
  await pool.query(`UPDATE lab_tests SET ${updates.join(", ")} WHERE id = ?`, params);

  await auditLabAction(pool, auth.userId, "lab_test_updated", id, body);

  const [row] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lab_tests WHERE id = ?`, [id],
  );

  return json(serializeLabTest(row[0]));
});
