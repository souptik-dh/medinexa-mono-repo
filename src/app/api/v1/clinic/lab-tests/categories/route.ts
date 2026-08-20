import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { newId } from "@/lib/ids";
import { parseBody } from "@/lib/validators";
import { serializeLabTestCategory, auditLabAction } from "@/lib/lab-tests";
import { getOwnedClinic } from "@/lib/scope";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

function scopeFilter(auth: { role: string; userId: string; branchId?: string | null }) {
  const conditions = ["clinic_id IN (SELECT id FROM clinics WHERE owner_user_id = ?)"];
  const params: unknown[] = [auth.userId];

  if (auth.role === "sys_admin") {
    conditions[0] = "1 = 1";
    params.length = 0;
  } else if (auth.role === "branch_staff") {
    conditions[0] = "clinic_id = (SELECT clinic_id FROM branches WHERE id = ?)";
    params[0] = auth.branchId ?? "__none__";
  }

  return { conditions, params };
}

// Categories this clinic can use on its lab tests — feeds the category combobox
// on the create form, along with the badge color set for each. Includes both
// explicitly-created categories (lab_test_categories) and legacy free-text
// category values already used on lab_tests but never formally registered.
export const GET = api({ rateLimit: 120 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const clinicId = ctx.request.nextUrl.searchParams.get("clinic_id");

  const { conditions, params } = scopeFilter(ctx.auth!);
  if (clinicId) {
    conditions.push("clinic_id = ?");
    params.push(clinicId);
  }
  const where = conditions.join(" AND ");

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, badge_color FROM lab_test_categories WHERE ${where}
     UNION
     SELECT NULL AS id, category AS name, NULL AS badge_color FROM lab_tests
      WHERE ${where} AND category NOT IN (SELECT name FROM lab_test_categories WHERE ${where})
     ORDER BY name ASC`,
    [...params, ...params, ...params],
  );

  return json({ items: rows.map(serializeLabTestCategory) });
});

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

const bulkCreateSchema = z.object({
  clinic_id: z.string().uuid(),
  categories: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        badge_color: z.string().regex(HEX_COLOR_RE, "badge_color must be a hex color, e.g. #22C55E").optional(),
      }),
    )
    .min(1, "At least one category is required.")
    .max(100),
});

// Bulk-create (or re-color) named categories with a badge in one request, so
// clinic staff can set up a full category list — each with its own badge
// color for the Add Lab Test screen — without one request per category.
export const POST = api({ rateLimit: 10 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "sys_admin"]);
  const body = parseBody(bulkCreateSchema, await ctx.request.json());

  if (auth.role === "clinic_owner") {
    await getOwnedClinic(pool, body.clinic_id, auth.userId);
  }

  const seen = new Set<string>();
  const names: string[] = [];

  for (const cat of body.categories) {
    const name = cat.name.trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);

    await pool.query(
      `INSERT INTO lab_test_categories (id, clinic_id, name, badge_color)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE badge_color = VALUES(badge_color)`,
      [newId(), body.clinic_id, name, cat.badge_color ?? "#6B7280"],
    );
  }

  await auditLabAction(pool, auth.userId, "lab_test_categories_bulk_created", body.clinic_id, {
    count: names.length,
    names,
  });

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, badge_color FROM lab_test_categories WHERE clinic_id = ? AND name IN (?)`,
    [body.clinic_id, names],
  );

  return json({ items: rows.map(serializeLabTestCategory) }, 201);
});
