import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { getDoctorRating, maskPatientName } from "@/lib/reviews";

// Public — drives a doctor profile's rating summary + patient feedback list, both
// in the patient-facing app and on a clinic's own doctor page.
export const GET = api({ rateLimit: 120 }, async (ctx) => {
  const doctorId = ctx.params.id;
  const sp = ctx.request.nextUrl.searchParams;
  const rawLimit = Number(sp.get("limit") ?? 20);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const rawOffset = Number(sp.get("offset") ?? 0);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  const rating = await getDoctorRating(pool, doctorId);

  const [rows] = await pool.query<Row[]>(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.name AS patient_name
       FROM reviews r
       JOIN users u ON u.id = r.patient_id
      WHERE r.doctor_id = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`,
    [doctorId, limit + 1, offset],
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return json({
    rating,
    items: items.map((r) => ({
      id: r.id,
      patient_name: maskPatientName(r.patient_name),
      rating: Number(r.rating),
      comment: r.comment ?? null,
      created_at: r.created_at,
    })),
    has_more: hasMore,
  });
});
