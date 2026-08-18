import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { serializeBranchLabTest } from "@/lib/lab-tests";
import { badRequest, notFound } from "@/lib/errors";

export const GET = api({ rateLimit: 60 }, async (ctx) => {
  requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "sys_admin"]);
  const { id: branchId } = ctx.params;
  const sp = ctx.request.nextUrl.searchParams;
  const category = sp.get("category");
  const search = sp.get("search");
  const serviceMode = sp.get("service_mode");

  const conditions = ["blt.branch_id = ?", "blt.status = 'active'", "lt.status = 'active'"];
  const params: unknown[] = [branchId];

  if (category) {
    conditions.push("lt.category = ?");
    params.push(category);
  }
  if (search) {
    conditions.push("(lt.name LIKE ? OR lt.code LIKE ? OR lt.description LIKE ?)");
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  if (serviceMode === "HOME") {
    conditions.push("blt.home_collection_available = 1");
  } else if (serviceMode === "CLINIC") {
    conditions.push("blt.clinic_available = 1");
  }

  const where = conditions.join(" AND ");

  const [rows] = await pool.query(
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
