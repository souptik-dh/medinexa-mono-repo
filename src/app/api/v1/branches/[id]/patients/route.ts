import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { requireBranchAccess } from "@/lib/permissions";
import { badRequest } from "@/lib/errors";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function serializePatient(r: Row) {
  const visitCount = Number(r.visit_count);
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    address: r.address,
    photo_url: r.photo_url,
    visit_count: visitCount,
    is_new_patient: visitCount <= 1,
    first_visit_date: r.first_visit_date,
    last_visit_date: r.last_visit_date,
  };
}

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const branchId = ctx.params.id;
  await requireBranchAccess(pool, auth, branchId, "patients:view");

  const sp = ctx.request.nextUrl.searchParams;
  const rawLimit = Number(sp.get("limit") ?? 20);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const rawOffset = Number(sp.get("offset") ?? 0);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  const type = sp.get("type");
  if (type && type !== "new" && type !== "old") {
    throw badRequest("VALIDATION_ERROR", "type must be either `new` or `old`.");
  }

  const whereParts = ["a.branch_id = ?", "a.status != 'cancelled'"];
  const params: unknown[] = [branchId];

  const search = sp.get("search")?.trim();
  if (search) {
    const like = `%${escapeLike(search)}%`;
    whereParts.push("(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)");
    params.push(like, like, like);
  }

  const having = type === "new" ? "HAVING visit_count <= 1" : type === "old" ? "HAVING visit_count > 1" : "";

  const [rows] = await pool.query<Row[]>(
    `SELECT u.id, u.name, u.email, u.phone, u.address, u.photo_url,
            COUNT(a.id) AS visit_count,
            MIN(a.scheduled_date) AS first_visit_date,
            MAX(a.scheduled_date) AS last_visit_date
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
      WHERE ${whereParts.join(" AND ")}
      GROUP BY u.id, u.name, u.email, u.phone, u.address, u.photo_url
      ${having}
      ORDER BY last_visit_date DESC
      LIMIT ? OFFSET ?`,
    [...params, limit + 1, offset],
  );

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return json({
    items: items.map(serializePatient),
    has_more: hasMore,
  });
});
