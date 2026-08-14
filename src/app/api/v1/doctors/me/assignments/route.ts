import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAvailabilityPeriods } from "@/lib/availability";

// Lets a logged-in doctor discover which branch(es) they're assigned to, and the
// assignment_id each one needs for PATCH /doctor-assignments/:id and the
// exceptions/leave endpoints — there was previously no self-service way for a
// doctor to find this without a clinic_owner/branch_staff pointing them at a URL.
export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["doctor"]);

  const [rows] = await pool.query<Row[]>(
    `SELECT dba.id AS assignment_id, dba.branch_id, dba.fee_amount, dba.currency, dba.slot_type,
            b.name AS branch_name, b.timezone
       FROM doctor_branch_assignments dba
       JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
      WHERE dba.doctor_id = ? AND dba.is_active = 1
      ORDER BY b.name ASC`,
    [auth.doctorId],
  );

  const assignmentIds = rows.map((r) => r.assignment_id);
  const periods = await getAvailabilityPeriods(pool, assignmentIds);

  return json({
    items: rows.map((r) => {
      const period = periods.get(r.assignment_id) ?? { start_date: null, end_date: null };
      return {
        assignment_id: r.assignment_id,
        branch_id: r.branch_id,
        branch_name: r.branch_name,
        timezone: r.timezone,
        fee_amount: Number(r.fee_amount),
        currency: r.currency,
        slot_type: r.slot_type,
        start_date: period.start_date,
        end_date: period.end_date,
      };
    }),
  });
});
