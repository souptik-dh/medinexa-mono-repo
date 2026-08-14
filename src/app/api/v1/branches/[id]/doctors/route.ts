import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { addDays, nextAvailableSlot, todayInTz } from "@/lib/availability";

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

  const datesByAssignment = new Map<string, { start_date: string | null; end_date: string | null }>();
  if (assignmentIds.length > 0) {
    const [templateRows] = await pool.query<Row[]>(
      `SELECT doctor_branch_assignment_id,
              MIN(start_date) AS start_date,
              CASE WHEN SUM(end_date IS NULL) > 0 THEN NULL ELSE MAX(end_date) END AS end_date
         FROM doctor_slot_templates
        WHERE doctor_branch_assignment_id IN (?)
        GROUP BY doctor_branch_assignment_id`,
      [assignmentIds],
    );
    for (const t of templateRows) {
      datesByAssignment.set(t.doctor_branch_assignment_id, {
        start_date: t.start_date ? String(t.start_date).slice(0, 10) : null,
        end_date: t.end_date ? String(t.end_date).slice(0, 10) : null,
      });
    }
  }

  // Consecutive excluded_date rows (same assignment, same reason, back-to-back calendar
  // days) are merged into a single { start_date, end_date } range so a multi-day leave
  // reads as one range instead of one entry per day — matches the documented contract.
  const unavailableByAssignment = new Map<string, { start_date: string; end_date: string; reason: string | null }[]>();
  if (assignmentIds.length > 0) {
    const [exceptionRows] = await pool.query<Row[]>(
      `SELECT doctor_branch_assignment_id, excluded_date, reason
         FROM doctor_slot_exceptions
        WHERE doctor_branch_assignment_id IN (?) AND excluded_date >= ?
        ORDER BY doctor_branch_assignment_id, excluded_date`,
      [assignmentIds, todayInTz(tz)],
    );
    for (const e of exceptionRows) {
      const date = String(e.excluded_date).slice(0, 10);
      const ranges = unavailableByAssignment.get(e.doctor_branch_assignment_id) ?? [];
      const last = ranges[ranges.length - 1];
      if (last && last.reason === e.reason && addDays(last.end_date, 1) === date) {
        last.end_date = date;
      } else {
        ranges.push({ start_date: date, end_date: date, reason: e.reason });
      }
      unavailableByAssignment.set(e.doctor_branch_assignment_id, ranges);
    }
  }

  const items = [];
  for (const r of rows) {
    const next_available_slot = await nextAvailableSlot(pool, r.assignment_id, tz);
    const dates = datesByAssignment.get(r.assignment_id) ?? { start_date: null, end_date: null };
    const unavailable_dates = unavailableByAssignment.get(r.assignment_id) ?? [];
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
