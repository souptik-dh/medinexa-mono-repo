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
    // A patient created by staff (e.g. a walk-in booking) never sets their own
    // password, so password_hash IS NULL doubles as "never self-registered".
    is_registered: Boolean(r.is_registered),
  };
}

// The true "All Patients" list: every actual patient with EITHER a Doctor
// appointment OR a Lab Test booking at this branch, deduped by identity across
// both sources (unlike GET /branches/[id]/patients, which is Doctor-only, and
// GET /branches/[id]/lab-patients, which is Lab-only).
export const GET = api({ rateLimit: 200 }, async (ctx) => {
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

  const whereParts: string[] = [];
  const params: unknown[] = [branchId, branchId];

  const search = sp.get("search")?.trim();
  if (search) {
    const like = `%${escapeLike(search)}%`;
    whereParts.push("(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)");
    params.push(like, like, like);
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  const having = type === "new" ? "HAVING visit_count <= 1" : type === "old" ? "HAVING visit_count > 1" : "";

  const [rows] = await pool.query<Row[]>(
    `SELECT u.id, u.name, u.email, u.phone, u.address, u.photo_url,
            (u.password_hash IS NOT NULL) AS is_registered,
            COUNT(*) AS visit_count,
            MIN(v.visit_date) AS first_visit_date,
            MAX(v.visit_date) AS last_visit_date
       FROM (
         -- The actual patient behind each Doctor appointment, falling back to the
         -- booking account for legacy rows that predate appointment_patients.patient_id.
         SELECT COALESCE(ap.patient_id, a.patient_id) AS patient_id, a.scheduled_date AS visit_date
           FROM appointments a
           LEFT JOIN appointment_patients ap ON ap.appointment_id = a.id
          WHERE a.branch_id = ? AND a.status != 'cancelled'
         UNION ALL
         -- Same, for Lab Test bookings.
         SELECT COALESCE(ltap.patient_id, la.patient_id) AS patient_id, la.appointment_date AS visit_date
           FROM lab_test_appointments la
           LEFT JOIN lab_test_appointment_patients ltap ON ltap.appointment_id = la.id
          WHERE la.branch_id = ? AND la.status NOT IN ('CANCELLED', 'REJECTED')
       ) v
       -- A branch_staff/clinic_owner can never itself be "the patient," so a legacy
       -- visit with no linked patient record (v.patient_id NULL, or resolving to a
       -- staff/owner account) is excluded here rather than being misattributed.
       JOIN users u ON u.id = v.patient_id AND u.role = 'patient'
       ${where}
      GROUP BY u.id, u.name, u.email, u.phone, u.address, u.photo_url, u.password_hash
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
