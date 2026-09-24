import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { conflict, notFound, isUniqueViolation } from "@/lib/errors";
import { newId } from "@/lib/ids";
import type { AuthContext } from "@/lib/auth";
import {
  weekdayInTz,
  generateSlotTimes,
  todayInTz,
  currentTimeKeyInTz,
  addDays,
  getBranchSchedule,
  isWeekdayOpen,
  findCoveringLeave,
  bookedCountsByTime,
  type LeaveRange,
} from "@/lib/availability";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export const APPT_STATUSES = [
  "pending",
  "confirmed",
  "paid",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type ApptStatus = (typeof APPT_STATUSES)[number];

export const NON_TERMINAL = ["pending", "confirmed", "paid"];

export function serializeAppointment(r: Row) {
  const base = {
    id: r.id,
    patient_id: r.patient_id,
    clinic_id: r.clinic_id,
    branch_id: r.branch_id,
    doctor_id: r.doctor_id,
    scheduled_date: r.scheduled_date,
    scheduled_time: r.scheduled_time,
    duration_minutes: Number(r.duration_minutes),
    status: r.status,
    fee_amount: Number(r.fee_amount),
    currency: r.currency,
    payment_method: r.payment_method,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  const withPatientDetails = {
    ...base,
    // Who the visit is actually for — may differ from the booking account (patient_id)
    // when booked on behalf of a family member/friend. Always present once joined,
    // since every appointment gets a row (defaulting to relationship "self").
    ...(r.visitor_name !== undefined
      ? {
          patient_details: {
            patient_id: r.visitor_patient_id ?? null,
            relationship: r.visitor_relationship ?? "self",
            name: r.visitor_name,
            phone: r.visitor_phone ?? null,
            age: r.visitor_age !== null && r.visitor_age !== undefined ? Number(r.visitor_age) : null,
            gender: r.visitor_gender ?? null,
          },
          relationship: r.visitor_relationship ?? "self",
          booking_source: r.visitor_booking_source ?? null,
          // The actual patient the visit is for. `id` resolves to a real users row
          // once known — null for legacy bookings that predate this field.
          patient: {
            id: r.visitor_patient_id ?? null,
            name: r.visitor_name,
            mobile: r.visitor_phone ?? null,
          },
          // The account that created the booking — the patient themselves, or clinic
          // staff booking on behalf of a walk-in/family member.
          booked_by: {
            id: r.visitor_booked_by ?? r.patient_id,
            ...(r.patient_name !== undefined
              ? { name: r.patient_name ?? null, email: r.patient_email ?? null, phone: r.patient_phone ?? null }
              : {}),
          },
        }
      : {}),
  };
  if (r.doctor_name === undefined && r.branch_name === undefined) return withPatientDetails;
  return {
    ...withPatientDetails,
    doctor_name: r.doctor_name ?? null,
    doctor_photo_url: r.doctor_photo_url ?? null,
    branch_name: r.branch_name ?? null,
    branch_phone: r.branch_phone ?? null,
  };
}

export function scopeWhere(auth: AuthContext): { where: string; params: unknown[] } {
  switch (auth.role) {
    case "patient":
      return { where: "a.patient_id = ?", params: [auth.userId] };
    case "branch_staff":
      return { where: "a.branch_id = ?", params: [auth.branchId ?? "__none__"] };
    case "doctor":
      return { where: "a.doctor_id = ?", params: [auth.doctorId ?? "__none__"] };
    case "clinic_owner":
      return {
        where: "a.clinic_id IN (SELECT id FROM clinics WHERE owner_user_id = ?)",
        params: [auth.userId],
      };
    default:
      return { where: "1 = 1", params: [] };
  }
}

export async function getAppointmentInScope(
  db: Db,
  id: string,
  auth: AuthContext,
): Promise<Row> {
  const { where, params } = scopeWhere(auth);
  const [rows] = await db.query<Row[]>(
    `SELECT a.*, b.timezone AS branch_timezone
       FROM appointments a
       JOIN branches b ON b.id = a.branch_id
      WHERE a.id = ? AND ${where} FOR UPDATE`,
    [id, ...params],
  );
  const row = rows[0];
  if (!row) throw notFound("APPOINTMENT_NOT_FOUND", "Appointment not found.");
  return row;
}

/**
 * Doctor/branch/patient display names for an appointment — used to build full-text
 * push notification bodies (doctor, branch) at the point a notification is created,
 * since `getAppointmentInScope` itself only joins branch timezone.
 */
export async function getAppointmentNames(
  db: Db,
  appointmentId: string,
): Promise<{
  doctor_name: string | null;
  branch_name: string | null;
  patient_name: string | null;
  visitor_name: string | null;
  visitor_relationship: string | null;
}> {
  const [rows] = await db.query<Row[]>(
    `SELECT d.name AS doctor_name, b.name AS branch_name, u.name AS patient_name,
            ap.name AS visitor_name, ap.relationship AS visitor_relationship
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN branches b ON b.id = a.branch_id
       JOIN users u ON u.id = a.patient_id
       LEFT JOIN appointment_patients ap ON ap.appointment_id = a.id
      WHERE a.id = ?`,
    [appointmentId],
  );
  const row = rows[0];
  return {
    doctor_name: row?.doctor_name ?? null,
    branch_name: row?.branch_name ?? null,
    patient_name: row?.patient_name ?? null,
    visitor_name: row?.visitor_name ?? null,
    visitor_relationship: row?.visitor_relationship ?? null,
  };
}

export async function writeStatusLog(
  conn: PoolConnection,
  appointmentId: string,
  from: string | null,
  to: string,
  changedBy: string | null,
  note: string | null,
): Promise<void> {
  await conn.query(
    `INSERT INTO appointment_status_log (id, appointment_id, from_status, to_status, changed_by, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), appointmentId, from, to, changedBy, note ?? null],
  );
}

// Cancels every non-terminal (pending/confirmed) appointment that falls inside a newly
// created branch closure or doctor leave date range. Paid appointments are left alone —
// same guard as a manual cancel, since cancelling a paid visit has refund implications
// out of scope here. Returns the cancelled rows (pre-transition snapshot) so the caller
// can notify/email each affected patient after the transaction commits.
export async function autoCancelAppointmentsInRange(
  conn: PoolConnection,
  opts: { branchId: string; doctorId?: string; startDate: string; endDate: string; reason: string; changedBy: string },
): Promise<Row[]> {
  const doctorFilter = opts.doctorId ? "AND a.doctor_id = ?" : "";
  const params: unknown[] = [opts.branchId, opts.startDate, opts.endDate];
  if (opts.doctorId) params.push(opts.doctorId);

  const [rows] = await conn.query<Row[]>(
    `SELECT a.* FROM appointments a
     WHERE a.branch_id = ? AND a.scheduled_date BETWEEN ? AND ?
       AND a.status IN ('pending', 'confirmed') ${doctorFilter}
     FOR UPDATE`,
    params,
  );

  for (const appt of rows) {
    await transition(conn, appt, "cancelled", opts.changedBy, ["pending", "confirmed"], opts.reason);
  }

  return rows;
}

export async function transition(
  conn: PoolConnection,
  appointment: Row,
  toStatus: ApptStatus,
  changedBy: string | null,
  allowedFrom: string[],
  note: string | null = null,
): Promise<void> {
  if (!allowedFrom.includes(appointment.status)) {
    throw conflict(
      "INVALID_STATUS_TRANSITION",
      `Cannot transition appointment from '${appointment.status}' to '${toStatus}'.`,
    );
  }
  await conn.query(`UPDATE appointments SET status = ? WHERE id = ?`, [toStatus, appointment.id]);
  await writeStatusLog(conn, appointment.id, appointment.status, toStatus, changedBy, note);
}

// True when an appointment's weekday+time still lines up with an active slot_template
// row as of `date` — used after a slot_template edit to detect appointments that fell
// outside the new schedule (time window changed, weekday dropped, or the duration
// changed so the exact time key no longer aligns).
function apptStillFitsTemplate(templates: Row[], weekday: number, date: string, time: string): boolean {
  for (const t of templates) {
    if (Number(t.weekday) !== weekday) continue;
    if (String(t.start_date).slice(0, 10) > date) continue;
    if (t.end_date && String(t.end_date).slice(0, 10) < date) continue;
    const keys = generateSlotTimes(String(t.start_time).slice(0, 5), String(t.end_time).slice(0, 5), Number(t.slot_duration_minutes));
    if (keys.includes(time)) return true;
  }
  return false;
}

// Soonest open slot under the assignment's (already updated) template, honoring branch
// operating days/closures and the doctor's leaves — same rules as `nextAvailableSlot` in
// availability.ts, kept separate here because this caller also needs the matched
// template's max_patients/duration to place the moved appointment correctly, which that
// simpler date+time-only helper doesn't expose. Templates/leaves/branch schedule are
// passed in (fetched once by the caller) since they're the same for every appointment
// being rescheduled off one template change — only booked counts change per placement.
async function findReplacementSlot(
  conn: PoolConnection,
  opts: {
    doctorId: string;
    tz: string;
    templates: Row[];
    leaveRanges: LeaveRange[];
    branchSchedule: Awaited<ReturnType<typeof getBranchSchedule>>;
  },
): Promise<{ date: string; time: string; maxPatients: number; durationMinutes: number } | null> {
  const { templates, leaveRanges, branchSchedule } = opts;
  const today = todayInTz(opts.tz);

  for (let dayOffset = 0; dayOffset < 60; dayOffset++) {
    const date = addDays(today, dayOffset);
    if (findCoveringLeave(date, leaveRanges)) continue;
    const wd = weekdayInTz(date, opts.tz);
    if (!isWeekdayOpen(branchSchedule, wd) || findCoveringLeave(date, branchSchedule.closures)) continue;
    const nowKey = dayOffset === 0 ? currentTimeKeyInTz(opts.tz) : null;
    const dayTemplates = templates.filter(
      (t) =>
        Number(t.weekday) === wd &&
        String(t.start_date).slice(0, 10) <= date &&
        (!t.end_date || String(t.end_date).slice(0, 10) >= date),
    );
    if (dayTemplates.length === 0) continue;
    const booked = await bookedCountsByTime(conn, opts.doctorId, date);
    for (const t of dayTemplates) {
      const maxPatients = Number(t.max_patients ?? 1);
      const durationMinutes = Number(t.slot_duration_minutes);
      for (const key of generateSlotTimes(String(t.start_time).slice(0, 5), String(t.end_time).slice(0, 5), durationMinutes)) {
        if (nowKey !== null && key <= nowKey) continue;
        if ((booked.get(key) ?? 0) >= maxPatients) continue;
        return { date, time: key, maxPatients, durationMinutes };
      }
    }
  }
  return null;
}

export interface RescheduledAppointment {
  id: string;
  patient_id: string;
  old_date: string;
  old_time: string;
  new_date: string;
  new_time: string;
}

/**
 * After a doctor's slot_template is replaced (PATCH /doctor-assignments/:id), moves
 * every pending/confirmed future appointment that no longer falls inside the new
 * schedule to the soonest matching slot, instead of leaving it stranded at a time the
 * doctor is no longer available. Paid appointments are left untouched — same
 * "resolve manually" policy as autoCancelAppointmentsInRange, since moving a paid visit
 * has refund/reschedule-fee implications out of scope here. An appointment with no
 * replacement slot inside the lookahead window is cancelled instead (mirrors what
 * already happens when a doctor goes on leave over their only remaining slots).
 * Must run inside the same transaction as the slot_template write, so the replacement
 * search sees the new rows and each successive placement sees the previous ones.
 */
export async function rescheduleAppointmentsAfterTemplateChange(
  conn: PoolConnection,
  opts: {
    assignmentId: string;
    doctorId: string;
    branchId: string;
    tz: string;
    changedBy: string;
    reason: string;
  },
): Promise<{ rescheduled: RescheduledAppointment[]; cancelled: Row[] }> {
  const today = todayInTz(opts.tz);
  const [appts] = await conn.query<Row[]>(
    `SELECT * FROM appointments
      WHERE doctor_id = ? AND branch_id = ? AND status IN ('pending', 'confirmed') AND scheduled_date >= ?
      FOR UPDATE`,
    [opts.doctorId, opts.branchId, today],
  );
  if (appts.length === 0) return { rescheduled: [], cancelled: [] };

  const [templates] = await conn.query<Row[]>(
    `SELECT * FROM doctor_slot_templates WHERE doctor_branch_assignment_id = ? AND is_active = 1`,
    [opts.assignmentId],
  );
  const [exceptions] = await conn.query<Row[]>(
    `SELECT excluded_date, end_date FROM doctor_slot_exceptions
      WHERE doctor_branch_assignment_id = ? AND status = 'active'`,
    [opts.assignmentId],
  );
  const leaveRanges: LeaveRange[] = exceptions.map((e) => ({
    start_date: String(e.excluded_date).slice(0, 10),
    end_date: String(e.end_date ?? e.excluded_date).slice(0, 10),
    reason: null,
  }));
  const branchSchedule = await getBranchSchedule(conn, opts.branchId, { from: today, to: addDays(today, 59) });

  const rescheduled: RescheduledAppointment[] = [];
  const cancelled: Row[] = [];

  // Earliest-booked-first, so when two invalid appointments compete for the same
  // replacement slot, the one whose original visit was sooner wins the earlier opening.
  const sorted = [...appts].sort((a, b) =>
    `${a.scheduled_date}${a.scheduled_time}`.localeCompare(`${b.scheduled_date}${b.scheduled_time}`),
  );

  for (const appt of sorted) {
    const date = String(appt.scheduled_date).slice(0, 10);
    const time = String(appt.scheduled_time).slice(0, 5);
    const wd = weekdayInTz(date, opts.tz);
    if (apptStillFitsTemplate(templates, wd, date, time)) continue;

    const replacement = await findReplacementSlot(conn, {
      doctorId: opts.doctorId,
      tz: opts.tz,
      templates,
      leaveRanges,
      branchSchedule,
    });

    if (!replacement) {
      await transition(conn, appt, "cancelled", opts.changedBy, ["pending", "confirmed"], opts.reason);
      cancelled.push(appt);
      continue;
    }

    let moved = false;
    for (let seq = 0; seq < replacement.maxPatients && !moved; seq++) {
      try {
        await conn.query(
          `UPDATE appointments SET scheduled_date = ?, scheduled_time = ?, slot_seq = ?, duration_minutes = ? WHERE id = ?`,
          [replacement.date, replacement.time, seq, replacement.durationMinutes, appt.id],
        );
        moved = true;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    if (!moved) {
      // Every seq for the chosen slot was claimed between the read and the write
      // (concurrent booking) — cancel rather than leave the appointment stranded at
      // its now-invalid original time.
      await transition(conn, appt, "cancelled", opts.changedBy, ["pending", "confirmed"], opts.reason);
      cancelled.push(appt);
      continue;
    }

    await writeStatusLog(conn, appt.id, appt.status, appt.status, opts.changedBy, opts.reason);
    rescheduled.push({
      id: appt.id,
      patient_id: appt.patient_id,
      old_date: date,
      old_time: time,
      new_date: replacement.date,
      new_time: replacement.time,
    });
  }

  return { rescheduled, cancelled };
}
