import { api, json, noContent } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parseBody, timeSchema } from "@/lib/validators";
import { requireBranchAccess } from "@/lib/permissions";
import { auditLabAction } from "@/lib/lab-tests";
import { badRequest, notFound } from "@/lib/errors";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

const updateSchema = z.object({
  weekday: z.number().int().min(0).max(6).optional(),
  start_time: timeSchema.optional(),
  end_time: timeSchema.optional(),
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
  const existing = existingRows[0];

  const nextStart = body.start_time ?? String(existing.start_time).slice(0, 5);
  const nextEnd = body.end_time ?? String(existing.end_time).slice(0, 5);
  if (nextStart >= nextEnd) {
    throw badRequest("VALIDATION_ERROR", "start_time must be before end_time.", "end_time");
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.weekday !== undefined) { updates.push("weekday = ?"); params.push(body.weekday); }
  if (body.start_time !== undefined) { updates.push("start_time = ?"); params.push(body.start_time); }
  if (body.end_time !== undefined) { updates.push("end_time = ?"); params.push(body.end_time); }
  if (body.is_active !== undefined) { updates.push("is_active = ?"); params.push(body.is_active ? 1 : 0); }

  if (updates.length > 0) {
    params.push(id);
    await pool.query(`UPDATE lab_test_schedules SET ${updates.join(", ")} WHERE id = ?`, params);
    await auditLabAction(pool, auth.userId, "lab_schedule_updated", id, body);
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lab_test_schedules WHERE id = ?`,
    [id],
  );
  const row = rows[0];

  return json({
    id: row.id,
    branch_id: row.branch_id,
    weekday: row.weekday,
    start_time: String(row.start_time).slice(0, 5),
    end_time: String(row.end_time).slice(0, 5),
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

export const DELETE = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "sys_admin"]);
  const { branchId, id } = ctx.params;

  await requireBranchAccess(pool, auth, branchId, "lab_tests:manage");

  const [existingRows] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM lab_test_schedules WHERE id = ? AND branch_id = ?`,
    [id, branchId],
  );
  if (existingRows.length === 0) {
    throw notFound("SCHEDULE_NOT_FOUND", "Schedule not found.");
  }

  await pool.query(`DELETE FROM lab_test_schedules WHERE id = ?`, [id]);
  await auditLabAction(pool, auth.userId, "lab_schedule_deleted", id, { branch_id: branchId });

  return noContent();
});
