import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { newId } from "@/lib/ids";
import { parseBody } from "@/lib/validators";
import { serializeLabTest, generateUniqueLabTestCode, auditLabAction } from "@/lib/lab-tests";
import { getOwnedClinic } from "@/lib/scope";
import { parsePagination } from "@/lib/validators";
import { encodeCursor } from "@/lib/http";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

export const GET = api({ rateLimit: 120 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const sp = ctx.request.nextUrl.searchParams;
  const clinicId = sp.get("clinic_id");
  const status = sp.get("status");
  const category = sp.get("category");
  const search = sp.get("search");
  const { limit, cursor } = parsePagination(sp);

  const conditions = ["lt.clinic_id IN (SELECT id FROM clinics WHERE owner_user_id = ?)"];
  const params: unknown[] = [ctx.auth!.userId];

  if (ctx.auth!.role === "sys_admin") {
    conditions[0] = "1 = 1";
    params.length = 0;
  } else if (ctx.auth!.role === "branch_staff") {
    conditions[0] = "lt.clinic_id = (SELECT clinic_id FROM branches WHERE id = ?)";
    params[0] = ctx.auth!.branchId ?? "__none__";
  }

  if (clinicId) {
    conditions.push("lt.clinic_id = ?");
    params.push(clinicId);
  }
  if (status) {
    conditions.push("lt.status = ?");
    params.push(status);
  }
  if (category) {
    conditions.push("lt.category = ?");
    params.push(category);
  }
  if (search) {
    conditions.push("(lt.name LIKE ? OR lt.code LIKE ?)");
    const q = `%${search}%`;
    params.push(q, q);
  }
  if (cursor) {
    conditions.push("lt.created_at < ?");
    params.push(cursor);
  }

  const where = conditions.join(" AND ");

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT lt.* FROM lab_tests lt
     WHERE ${where}
     ORDER BY lt.created_at DESC
     LIMIT ?`,
    [...params, limit + 1],
  );

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0 ? encodeCursor({ created_at: items[items.length - 1].created_at }) : null;

  return json({ items: items.map(serializeLabTest), next_cursor: nextCursor });
});

const createSchema = z.object({
  clinic_id: z.string().uuid(),
  // Omit both to quick-create from just a category — name and code are then
  // derived from it (see below) rather than required up front.
  name: z.string().min(1).max(255).optional(),
  code: z.string().min(1).max(50).optional(),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().min(1).max(100),
  instructions: z.string().max(2000).nullable().optional(),
  default_precautions: z.array(z.string().max(500)).optional(),
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "sys_admin"]);
  const body = parseBody(createSchema, await ctx.request.json());

  if (auth.role === "clinic_owner") {
    await getOwnedClinic(pool, body.clinic_id, auth.userId);
  }

  const name = body.name?.trim() || body.category.trim();
  const code = body.code?.trim() || (await generateUniqueLabTestCode(pool, body.clinic_id, body.category));

  const id = newId();
  await pool.query(
    `INSERT INTO lab_tests (id, clinic_id, name, code, description, category, instructions, default_precautions, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      id,
      body.clinic_id,
      name,
      code,
      body.description ?? null,
      body.category,
      body.instructions ?? null,
      body.default_precautions ? JSON.stringify(body.default_precautions) : null,
    ],
  );

  await auditLabAction(pool, auth.userId, "lab_test_created", id, {
    clinic_id: body.clinic_id,
    name: body.name,
    code: body.code,
  });

  const [row] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lab_tests WHERE id = ?`,
    [id],
  );

  return json(serializeLabTest(row[0]), 201);
});
