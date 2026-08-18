import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { newId } from "@/lib/ids";
import { parseBody } from "@/lib/validators";
import { serializeBranchLabTest, auditLabAction } from "@/lib/lab-tests";
import { requireBranchAccess } from "@/lib/permissions";
import { badRequest, notFound } from "@/lib/errors";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

export const GET = api({ rateLimit: 60 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const { branchId } = ctx.params;
  const sp = ctx.request.nextUrl.searchParams;
  const status = sp.get("status");

  const conditions = ["blt.branch_id = ?"];
  const params: unknown[] = [branchId];

  if (status) {
    conditions.push("blt.status = ?");
    params.push(status);
  }

  const where = conditions.join(" AND ");

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT blt.*, lt.name AS test_name, lt.code AS test_code, lt.category AS test_category,
            lt.description AS test_description, lt.default_precautions
       FROM branch_lab_tests blt
       JOIN lab_tests lt ON lt.id = blt.test_id
     WHERE ${where}
     ORDER BY lt.name ASC`,
    params,
  );

  return json({ items: (rows as any[]).map(serializeBranchLabTest) });
});

const createSchema = z.object({
  test_id: z.string().uuid(),
  price: z.number().min(0),
  currency: z.string().length(3).default("INR"),
  duration_minutes: z.number().int().min(5).max(480).default(30),
  clinic_available: z.boolean().default(true),
  home_collection_available: z.boolean().default(false),
  prescription_required: z.boolean().default(false),
});

export const POST = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "sys_admin"]);
  const { branchId } = ctx.params;
  const body = parseBody(createSchema, await ctx.request.json());

  await requireBranchAccess(pool, auth, branchId, "lab_tests:manage");

  const [testRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, clinic_id FROM lab_tests WHERE id = ? AND status = 'active'`,
    [body.test_id],
  );
  if (testRows.length === 0) {
    throw notFound("LAB_TEST_NOT_FOUND", "Lab test not found or inactive.");
  }
  const test = testRows[0];

  const [branchRows] = await pool.query<RowDataPacket[]>(
    `SELECT clinic_id FROM branches WHERE id = ? AND deleted_at IS NULL`,
    [branchId],
  );
  if (branchRows.length === 0) {
    throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
  }

  if (test.clinic_id !== branchRows[0].clinic_id) {
    throw badRequest("CLINIC_MISMATCH", "Test does not belong to this branch's clinic.");
  }

  const [existing] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM branch_lab_tests WHERE branch_id = ? AND test_id = ?`,
    [branchId, body.test_id],
  );
  if (existing.length > 0) {
    throw badRequest("DUPLICATE_TEST", "This test is already configured for this branch.");
  }

  const id = newId();
  await pool.query(
    `INSERT INTO branch_lab_tests (id, clinic_id, branch_id, test_id, price, currency, duration_minutes, clinic_available, home_collection_available, prescription_required, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      id,
      test.clinic_id,
      branchId,
      body.test_id,
      body.price,
      body.currency,
      body.duration_minutes,
      body.clinic_available ? 1 : 0,
      body.home_collection_available ? 1 : 0,
      body.prescription_required ? 1 : 0,
    ],
  );

  await auditLabAction(pool, auth.userId, "branch_test_configured", id, {
    branch_id: branchId,
    test_id: body.test_id,
    price: body.price,
  });

  const [row] = await pool.query<RowDataPacket[]>(
    `SELECT blt.*, lt.name AS test_name, lt.code AS test_code, lt.category AS test_category,
            lt.description AS test_description, lt.default_precautions
       FROM branch_lab_tests blt
       JOIN lab_tests lt ON lt.id = blt.test_id
     WHERE blt.id = ?`,
    [id],
  );

  return json(serializeBranchLabTest(row[0]), 201);
});
