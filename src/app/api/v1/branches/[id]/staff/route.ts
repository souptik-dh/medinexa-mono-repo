import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody, emailSchema } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { conflict, isUniqueViolation } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { sendEmail, emailHtml } from "@/lib/notifications";
import {
  BRANCH_STAFF_PERMISSIONS,
  DEFAULT_BRANCH_STAFF_PERMISSIONS,
  parsePermissions,
  assertBranchStaffPermission,
} from "@/lib/permissions";

function serializeStaff(r: Row) {
  return {
    id: r.id,
    branch_id: r.branch_id,
    name: r.name,
    email: r.email,
    added_by: r.added_by,
    permissions: parsePermissions(r.permissions_json),
    created_at: r.created_at,
  };
}

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const branchId = ctx.params.id;

  if (auth.role === "branch_staff") {
    if (auth.branchId !== branchId) {
      return json(
        { error: { code: "BRANCH_NOT_FOUND", message: "Branch not found.", field: null, request_id: ctx.reqId } },
        404,
      );
    }
  } else {
    await getOwnedBranch(pool, branchId, auth.userId);
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT bs.id, bs.branch_id, u.name, u.email, bs.added_by, bs.permissions_json, bs.created_at
       FROM branch_staff bs
       JOIN users u ON u.id = bs.user_id
      WHERE bs.branch_id = ? ORDER BY bs.created_at ASC`,
    [branchId],
  );

  return json({
    items: rows.map(serializeStaff),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: emailSchema,
  permissions: z.array(z.enum(BRANCH_STAFF_PERMISSIONS)).optional(),
});

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const branchId = ctx.params.id;

  if (auth.role === "clinic_owner") {
    await getOwnedBranch(pool, branchId, auth.userId);
  } else {
    await assertBranchStaffPermission(pool, auth, branchId, "staff:manage");
  }

  const body = parseBody(createSchema, await readJson(ctx.request));
  const permissions = body.permissions ?? [...DEFAULT_BRANCH_STAFF_PERMISSIONS];

  const userId = newId();
  const staffId = newId();
  try {
    await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO users (id, name, email, role, status) VALUES (?, ?, ?, 'branch_staff', 'active')`,
        [userId, body.name, body.email],
      );
      await conn.query(
        `INSERT INTO branch_staff (id, branch_id, user_id, added_by, permissions_json) VALUES (?, ?, ?, ?, ?)`,
        [staffId, branchId, userId, auth.userId, JSON.stringify(permissions)],
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(
        "STAFF_ALREADY_EXISTS_FOR_BRANCH",
        "This email is already registered as staff for this branch.",
      );
    }
    throw err;
  }

  const staffBody = "You can now log in to Jido Healthcare using the email-based OTP flow. Use the OTP sent to your email at login.";
  await sendEmail(
    body.email,
    "You've been added as branch staff",
    staffBody,
    emailHtml(staffBody),
  );

  return json(
    {
      id: staffId,
      branch_id: branchId,
      name: body.name,
      email: body.email,
      added_by: auth.userId,
      permissions,
      created_at: new Date().toISOString(),
    },
    201,
  );
});
