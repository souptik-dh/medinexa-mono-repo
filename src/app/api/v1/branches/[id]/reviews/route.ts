import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { requireBranchAccess } from "@/lib/permissions";
import { getBranchRating } from "@/lib/reviews";

// Clinic-side view of patient feedback for a branch — every doctor's reviews whose
// most recent submission was tied to this branch (see the note in
// appointments/:id/review/route.ts on why a review carries only one branch_id).
// Unlike GET /doctors/:id/reviews (public, name-masked), this shows the full patient
// name, matching GET /branches/:id/patients — already visible to clinic staff.
export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const branchId = ctx.params.id;
  await requireBranchAccess(pool, auth, branchId, "reviews:view");

  const sp = ctx.request.nextUrl.searchParams;
  const rawLimit = Number(sp.get("limit") ?? 20);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const rawOffset = Number(sp.get("offset") ?? 0);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const doctorId = sp.get("doctor_id")?.trim() || null;

  const rating = await getBranchRating(pool, branchId);

  const filters = ["r.branch_id = ?"];
  const params: unknown[] = [branchId];
  if (doctorId) {
    filters.push("r.doctor_id = ?");
    params.push(doctorId);
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT r.id, r.rating, r.comment, r.created_at, r.doctor_id,
            u.name AS patient_name, d.name AS doctor_name
       FROM reviews r
       JOIN users u ON u.id = r.patient_id
       JOIN doctors d ON d.id = r.doctor_id
      WHERE ${filters.join(" AND ")}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit + 1, offset],
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return json({
    rating,
    items: items.map((r) => ({
      id: r.id,
      doctor_id: r.doctor_id,
      doctor_name: r.doctor_name,
      patient_name: r.patient_name,
      rating: Number(r.rating),
      comment: r.comment ?? null,
      created_at: r.created_at,
    })),
    has_more: hasMore,
  });
});
