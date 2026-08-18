import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import type { RowDataPacket } from "mysql2/promise";

// Distinct categories this clinic has already used on its lab tests — feeds
// the category combobox on the create form so typing can suggest existing
// values while still allowing an arbitrary new one.
export const GET = api({ rateLimit: 60 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const clinicId = ctx.request.nextUrl.searchParams.get("clinic_id");

  const conditions = ["clinic_id IN (SELECT id FROM clinics WHERE owner_user_id = ?)"];
  const params: unknown[] = [ctx.auth!.userId];

  if (ctx.auth!.role === "sys_admin") {
    conditions[0] = "1 = 1";
    params.length = 0;
  } else if (ctx.auth!.role === "branch_staff") {
    conditions[0] = "clinic_id = (SELECT clinic_id FROM branches WHERE id = ?)";
    params[0] = ctx.auth!.branchId ?? "__none__";
  }

  if (clinicId) {
    conditions.push("clinic_id = ?");
    params.push(clinicId);
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT category FROM lab_tests WHERE ${conditions.join(" AND ")} ORDER BY category ASC`,
    params,
  );

  return json({ items: rows.map((r) => r.category as string) });
});
