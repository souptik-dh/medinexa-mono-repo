import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { getActiveLeaves, getAvailabilityPeriods, nextAvailableSlot, todayInTz } from "@/lib/availability";
import { getDoctorSpecializations, specializationDisplayName } from "@/lib/specializations";
import { getDoctorRatingMap } from "@/lib/reviews";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export const GET = api({ rateLimit: 120 }, async (ctx) => {
  const branchId = ctx.params.id;
  const sp = ctx.request.nextUrl.searchParams;
  const search = sp.get("search")?.trim() || null;
  const rawLimit = Number(sp.get("limit") ?? 50);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 50;

  const [branches] = await pool.query<Row[]>(
    `SELECT b.timezone, c.deleted_at AS clinic_deleted
       FROM branches b
       JOIN clinics c ON c.id = b.clinic_id
      WHERE b.id = ? AND b.deleted_at IS NULL`,
    [branchId],
  );
  const branch = branches[0];
  if (!branch || branch.clinic_deleted) {
    throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
  }
  const tz = branch.timezone as string;

  const filters: string[] = [];
  const params: unknown[] = [branchId];
  if (search) {
    const like = `%${escapeLike(search)}%`;
    filters.push(
      `AND (d.name LIKE ?
            OR EXISTS (SELECT 1 FROM doctor_specialization_map dsm
                         JOIN doctor_specializations ds ON ds.id = dsm.specialization_id
                        WHERE dsm.doctor_id = d.id AND ds.name LIKE ?))`,
    );
    params.push(like, like);
  }
  params.push(limit);

  const [rows] = await pool.query<Row[]>(
    `SELECT d.id, d.name, d.smc_name, d.doctor_degree, d.phone, d.certificate_url, d.photo_url,
            dba.id AS assignment_id, dba.fee_amount, dba.currency, dba.branch_id, dba.slot_type
       FROM doctor_branch_assignments dba
       JOIN doctors d ON d.id = dba.doctor_id AND d.deleted_at IS NULL
      WHERE dba.branch_id = ? AND dba.is_active = 1
      ${filters.join(" ")}
      ORDER BY d.name ASC
      LIMIT ?`,
    params,
  );

  const assignmentIds = rows.map((r) => r.assignment_id);

  const datesByAssignment = await getAvailabilityPeriods(pool, assignmentIds);
  // Leave ranges are stored natively as { start_date, end_date } rows now, so no
  // client-side merging of adjacent single-day rows is needed here anymore.
  const unavailableByAssignment = await getActiveLeaves(pool, assignmentIds, { from: todayInTz(tz) });
  const specializationsByDoctor = await getDoctorSpecializations(pool, rows.map((r) => String(r.id)));
  const ratingByDoctor = await getDoctorRatingMap(pool, rows.map((r) => String(r.id)));

  const items = [];
  for (const r of rows) {
    const next_available_slot = await nextAvailableSlot(pool, r.assignment_id, tz);
    const dates = datesByAssignment.get(r.assignment_id) ?? { start_date: null, end_date: null };
    const unavailable_dates = (unavailableByAssignment.get(r.assignment_id) ?? []).map((l) => ({
      start_date: l.start_date,
      end_date: l.end_date,
      reason: l.reason,
    }));
    const specializations = specializationsByDoctor.get(String(r.id)) ?? [];
    items.push({
      id: r.id,
      assignment_id: r.assignment_id,
      name: r.name,
      specialization: specializationDisplayName(specializations),
      specializations,
      smc_name: r.smc_name,
      doctor_degree: r.doctor_degree,
      phone: r.phone,
      certificate_url: r.certificate_url,
      photo_url: r.photo_url,
      fee_amount: Number(r.fee_amount),
      currency: r.currency,
      branch_id: r.branch_id,
      slot_type: r.slot_type,
      start_date: dates.start_date,
      end_date: dates.end_date,
      next_available_slot,
      unavailable_dates,
      rating: ratingByDoctor.get(String(r.id)) ?? { average: null, count: 0 },
    });
  }

  return json({ total: items.length, items });
});
