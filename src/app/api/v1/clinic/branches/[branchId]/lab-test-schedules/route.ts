import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { newId } from "@/lib/ids";
import { parseBody } from "@/lib/validators";
import { requireBranchAccess } from "@/lib/permissions";
import { auditLabAction } from "@/lib/lab-tests";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

export const GET = api({ rateLimit: 60 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const { branchId } = ctx.params;

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lab_test_schedules WHERE branch_id = ? ORDER BY weekday ASC, start_time ASC`,
    [branchId],
  );

  return json({
    items: rows.map((r) => ({
      id: r.id,
      branch_id: r.branch_id,
      weekday: r.weekday,
      start_time: String(r.start_time).slice(0, 5),
      end_time: String(r.end_time).slice(0, 5),
      is_active: Boolean(r.is_active),
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  });
});

const scheduleSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  start_time: z.string().regex(/^\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}$/),
  is_active: z.boolean().default(true),
});

export const POST = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "sys_admin"]);
  const { branchId } = ctx.params;
  const body = parseBody(scheduleSchema, await ctx.request.json());

  await requireBranchAccess(pool, auth, branchId, "lab_tests:manage");

  if (body.start_time >= body.end_time) {
    throw new Error("start_time must be before end_time.");
  }

  const id = newId();
  await pool.query(
    `INSERT INTO lab_test_schedules (id, branch_id, weekday, start_time, end_time, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, branchId, body.weekday, body.start_time, body.end_time, body.is_active ? 1 : 0],
  );

  await auditLabAction(pool, auth.userId, "lab_schedule_created", id, {
    branch_id: branchId,
    weekday: body.weekday,
    start_time: body.start_time,
    end_time: body.end_time,
  });

  return json({
    id,
    branch_id: branchId,
    weekday: body.weekday,
    start_time: body.start_time,
    end_time: body.end_time,
    is_active: body.is_active,
  }, 201);
});
