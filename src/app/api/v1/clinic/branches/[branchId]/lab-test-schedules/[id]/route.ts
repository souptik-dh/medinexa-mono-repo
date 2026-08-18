import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireBranchAccess } from "@/lib/permissions";
import { auditLabAction } from "@/lib/lab-tests";
import { notFound } from "@/lib/errors";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

const updateSchema = z.object({
  weekday: z.number().int().min(0).max(6).optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  is_active: z.boolean().optional(),
});

export const PUT = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "sys_admin"]);
  const { branchId, id } = ctx.params;
  const body = parseBody(updateSchema, await ctx.request.json());

  await requireBranchAccess(pool, auth, branchId, "lab_tests:manage");

  const [existingRows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lab_test_schedules WHERE id = ? AND branch_id = ?`,
    [id, branchId],
  );
  if (existingRows.length === 0) {
    throw notFound("SCHEDULE_NOT_FOUND", "Schedule not found.");
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.weekday !== undefined) { updates.push("weekday = ?"); params.push(body.weekday); }
  if (body.start_time !== undefined) { updates.push("start_time = ?"); params.push(body.start_time); }
  if (body.end_time !== undefined) { updates.push("end_time = ?"); params.push(body.end_time); }
  if (body.is_active !== undefined) { updates.push("is_active = ?"); params.push(body.is_active ? 1 : 0); }

  if (updates.length === 0) {
    return json({ success: true });
  }

  params.push(id);
  await pool.query(`UPDATE lab_test_schedules SET ${updates.join(", ")} WHERE id = ?`, params);

  await auditLabAction(pool, auth.userId, "lab_schedule_updated", id, body);

  return json({ success: true });
});
