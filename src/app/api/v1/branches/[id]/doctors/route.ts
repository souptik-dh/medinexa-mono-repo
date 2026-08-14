import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { getActiveLeaves, getAvailabilityPeriods, nextAvailableSlot, todayInTz } from "@/lib/availability";

export const GET = api(undefined, async (ctx) => {
  const branchId = ctx.params.id;

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

  const [rows] = await pool.query<Row[]>(
    `SELECT d.id, d.name, d.specialization, d.smc_name, d.doctor_degree, d.phone, d.certificate_url, d.photo_url,
            dba.id AS assignment_id, dba.fee_amount, dba.currency, dba.branch_id, dba.slot_type
       FROM doctor_branch_assignments dba
       JOIN doctors d ON d.id = dba.doctor_id AND d.deleted_at IS NULL
      WHERE dba.branch_id = ? AND dba.is_active = 1
      ORDER BY d.name ASC`,
    [branchId],
  );

  const assignmentIds = rows.map((r) => r.assignment_id);

  const datesByAssignment = await getAvailabilityPeriods(pool, assignmentIds);
  // Leave ranges are stored natively as { start_date, end_date } rows now, so no
  // client-side merging of adjacent single-day rows is needed here anymore.
  const unavailableByAssignment = await getActiveLeaves(pool, assignmentIds, { from: todayInTz(tz) });

  const items = [];
  for (const r of rows) {
    const next_available_slot = await nextAvailableSlot(pool, r.assignment_id, tz);
    const dates = datesByAssignment.get(r.assignment_id) ?? { start_date: null, end_date: null };
    const unavailable_dates = (unavailableByAssignment.get(r.assignment_id) ?? []).map((l) => ({
      start_date: l.start_date,
      end_date: l.end_date,
      reason: l.reason,
    }));
    items.push({
      id: r.id,
      assignment_id: r.assignment_id,
      name: r.name,
      specialization: r.specialization,
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
    });
  }

  return json({ total: items.length, items });
});
