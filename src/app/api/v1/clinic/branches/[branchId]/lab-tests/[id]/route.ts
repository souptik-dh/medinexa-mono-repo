import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { serializeBranchLabTest, getBranchLabTestInScope, auditLabAction } from "@/lib/lab-tests";
import { requireBranchAccess } from "@/lib/permissions";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

const updateSchema = z.object({
  price: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  duration_minutes: z.number().int().min(5).max(480).optional(),
  clinic_available: z.boolean().optional(),
  home_collection_available: z.boolean().optional(),
  prescription_required: z.boolean().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const PUT = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "sys_admin"]);
  const { branchId, id } = ctx.params;
  const body = parseBody(updateSchema, await ctx.request.json());

  await requireBranchAccess(pool, auth, branchId, "lab_tests:manage");

  const existing = await getBranchLabTestInScope(pool, id, auth);

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.price !== undefined) { updates.push("price = ?"); params.push(body.price); }
  if (body.currency !== undefined) { updates.push("currency = ?"); params.push(body.currency); }
  if (body.duration_minutes !== undefined) { updates.push("duration_minutes = ?"); params.push(body.duration_minutes); }
  if (body.clinic_available !== undefined) { updates.push("clinic_available = ?"); params.push(body.clinic_available ? 1 : 0); }
  if (body.home_collection_available !== undefined) { updates.push("home_collection_available = ?"); params.push(body.home_collection_available ? 1 : 0); }
  if (body.prescription_required !== undefined) { updates.push("prescription_required = ?"); params.push(body.prescription_required ? 1 : 0); }
  if (body.status !== undefined) { updates.push("status = ?"); params.push(body.status); }

  if (updates.length === 0) {
    return json(serializeBranchLabTest(existing));
  }

  params.push(id);
  await pool.query(`UPDATE branch_lab_tests SET ${updates.join(", ")} WHERE id = ?`, params);

  await auditLabAction(pool, auth.userId, "branch_test_updated", id, body);

  const [row] = await pool.query<RowDataPacket[]>(
    `SELECT blt.*, lt.name AS test_name, lt.code AS test_code, lt.category AS test_category,
            lt.description AS test_description, lt.default_precautions
       FROM branch_lab_tests blt
       JOIN lab_tests lt ON lt.id = blt.test_id
     WHERE blt.id = ?`,
    [id],
  );

  return json(serializeBranchLabTest(row[0]));
});
