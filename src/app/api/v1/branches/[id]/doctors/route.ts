import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { nextAvailableSlot } from "@/lib/availability";

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
            dba.id AS assignment_id, dba.fee_amount, dba.currency, dba.branch_id, dba.slot_type,
            dba.start_date, dba.end_date
       FROM doctor_branch_assignments dba
       JOIN doctors d ON d.id = dba.doctor_id AND d.deleted_at IS NULL
      WHERE dba.branch_id = ? AND dba.is_active = 1
      ORDER BY d.name ASC`,
    [branchId],
  );

  const assignmentIds = rows.map((r) => r.assignment_id);
  const doctorIds = rows.map((r) => r.id);

  const unavailableByAssignment = new Map<string, { start_date: string; end_date: string; reason: string | null }[]>();
  if (assignmentIds.length > 0) {
    const [exceptionRows] = await pool.query<Row[]>(
      `SELECT doctor_branch_assignment_id, excluded_date, reason
         FROM doctor_slot_exceptions
        WHERE doctor_branch_assignment_id IN (?) AND excluded_date >= CURDATE()`,
      [assignmentIds],
    );
    for (const e of exceptionRows) {
      const date = String(e.excluded_date).slice(0, 10);
      const list = unavailableByAssignment.get(e.doctor_branch_assignment_id) ?? [];
      list.push({ start_date: date, end_date: date, reason: e.reason });
      unavailableByAssignment.set(e.doctor_branch_assignment_id, list);
    }
  }

  const timeOffsByDoctor = new Map<string, { start_date: string; end_date: string; reason: string | null }[]>();
  if (doctorIds.length > 0) {
    const [timeOffRows] = await pool.query<Row[]>(
      `SELECT doctor_id, starts_at, ends_at, reason
         FROM doctor_time_offs
        WHERE doctor_id IN (?) AND branch_id = ? AND ends_at >= NOW()`,
      [doctorIds, branchId],
    );
    for (const t of timeOffRows) {
      const list = timeOffsByDoctor.get(t.doctor_id) ?? [];
      list.push({
        start_date: String(t.starts_at).slice(0, 10),
        end_date: String(t.ends_at).slice(0, 10),
        reason: t.reason,
      });
      timeOffsByDoctor.set(t.doctor_id, list);
    }
  }

  const items = [];
  for (const r of rows) {
    const next_available_slot = await nextAvailableSlot(pool, r.assignment_id, tz);
    const unavailable_dates = [
      ...(unavailableByAssignment.get(r.assignment_id) ?? []),
      ...(timeOffsByDoctor.get(r.id) ?? []),
    ];
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
      start_date: r.start_date ? String(r.start_date).slice(0, 10) : null,
      end_date: r.end_date ? String(r.end_date).slice(0, 10) : null,
      next_available_slot,
      unavailable_dates,
    });
  }

  return json({ total: items.length, items });
});
