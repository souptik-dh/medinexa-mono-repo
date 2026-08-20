import { api, json, decodeCursor } from "@/lib/http";
import { pool } from "@/lib/db";
import { parsePagination } from "@/lib/validators";
import { fetchPage } from "@/lib/pagination";
import { getAvailabilityPeriods, nextAvailableSlot } from "@/lib/availability";
import { getDoctorSpecializations, specializationDisplayName } from "@/lib/specializations";
import { getDoctorRatingMap } from "@/lib/reviews";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Public browse listing — unlike GET /doctors/search (auth-required, requires `q`) and
// GET /branches/:id/doctors (requires a known branch), this drives a patient-facing
// "browse all doctors" view (e.g. a home screen's "Top doctors") with no prerequisites.
// One row per active doctor<->branch assignment, same item shape as
// GET /branches/:id/doctors so the client can render a card without extra calls.
export const GET = api({ rateLimit: 120 }, async (ctx) => {
  const sp = ctx.request.nextUrl.searchParams;
  const { limit: rawLimit, cursor } = parsePagination(sp);
  const limit = Math.min(rawLimit, 50); // nextAvailableSlot below is one extra query per row
  const specializationId = sp.get("specialization_id")?.trim() || null;
  const city = sp.get("city")?.trim() || null;
  const q = sp.get("q")?.trim() || null;

  const filters: string[] = [];
  const params: unknown[] = [];
  if (specializationId) {
    filters.push(
      "AND EXISTS (SELECT 1 FROM doctor_specialization_map dsm WHERE dsm.doctor_id = d.id AND dsm.specialization_id = ?)",
    );
    params.push(specializationId);
  }
  if (city) {
    filters.push("AND b.city = ?");
    params.push(city);
  }
  if (q) {
    filters.push("AND d.name LIKE ?");
    params.push(`%${escapeLike(q)}%`);
  }

  // Wrapped in a derived table so the generic cursor clause's bare `created_at`/`id`
  // columns (added by fetchPage) stay unambiguous despite the multi-table join.
  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: "SELECT *",
    from: `FROM (
        SELECT dba.id AS id, dba.created_at AS created_at, dba.fee_amount, dba.currency, dba.slot_type,
               d.id AS doctor_id, d.name AS doctor_name, d.smc_name, d.doctor_degree,
               d.phone, d.photo_url,
               b.id AS branch_id, b.name AS branch_name, b.city AS branch_city, b.timezone AS branch_timezone,
               c.id AS clinic_id, c.name AS clinic_name
          FROM doctor_branch_assignments dba
          JOIN doctors d ON d.id = dba.doctor_id AND d.deleted_at IS NULL
          JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
          JOIN clinics c ON c.id = b.clinic_id AND c.deleted_at IS NULL
         WHERE dba.is_active = 1
         ${filters.join(" ")}
      ) t`,
    params,
    cursor: decodeCursor(cursor),
    limit,
  });

  const assignmentIds = rows.map((r) => String(r.id));
  const datesByAssignment = await getAvailabilityPeriods(pool, assignmentIds);
  const specializationsByDoctor = await getDoctorSpecializations(pool, rows.map((r) => String(r.doctor_id)));
  const ratingByDoctor = await getDoctorRatingMap(pool, rows.map((r) => String(r.doctor_id)));

  const items = [];
  for (const r of rows) {
    const next_available_slot = await nextAvailableSlot(pool, String(r.id), r.branch_timezone as string);
    const dates = datesByAssignment.get(String(r.id)) ?? { start_date: null, end_date: null };
    const specializations = specializationsByDoctor.get(String(r.doctor_id)) ?? [];
    items.push({
      id: r.doctor_id,
      assignment_id: r.id,
      name: r.doctor_name,
      specialization: specializationDisplayName(specializations),
      specializations,
      smc_name: r.smc_name,
      doctor_degree: r.doctor_degree,
      phone: r.phone,
      photo_url: r.photo_url,
      fee_amount: Number(r.fee_amount),
      currency: r.currency,
      branch_id: r.branch_id,
      branch_name: r.branch_name,
      clinic_id: r.clinic_id,
      clinic_name: r.clinic_name,
      city: r.branch_city,
      slot_type: r.slot_type,
      start_date: dates.start_date,
      end_date: dates.end_date,
      next_available_slot,
      rating: ratingByDoctor.get(String(r.doctor_id)) ?? { average: null, count: 0 },
    });
  }

  return json({ items, next_cursor: nextCursor });
});
