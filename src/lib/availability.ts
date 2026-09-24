import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function weekdayInTz(date: string, tz: string): number {
  const dt = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).formatToParts(dt);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const idx = WEEKDAYS.indexOf(weekday ?? "");
  if (idx === -1) throw new Error(`Unrecognized weekday "${weekday}" for tz "${tz}"`);
  return idx;
}

export function weekdayNameInTz(date: string, tz: string, style: "long" | "short" = "long"): string {
  const wd = weekdayInTz(date, tz);
  return (style === "long" ? WEEKDAYS_LONG : WEEKDAYS)[wd];
}

export function formatTime12h(t: string): string {
  const [hStr, mStr] = t.split(":");
  let h = Number(hStr);
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${mStr} ${period}`;
}

export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function currentTimeKeyInTz(tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return fmtMinutes((Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0));
}

export function hasSlotPassedInTz(date: string, time: string, tz: string): boolean {
  const today = todayInTz(tz);
  if (date < today) return true;
  if (date > today) return false;
  return time <= currentTimeKeyInTz(tz);
}

export function generateSlotTimes(startTime: string, endTime: string, durationMinutes: number): string[] {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  const times: string[] = [];
  for (let m = start; m + durationMinutes <= end; m += durationMinutes) {
    times.push(fmtMinutes(m));
  }
  return times;
}

export const DEFAULT_BOOKING_CUTOFF_MINUTES = 30;

// The doctor's actual final appointment end time for a day, derived from the last
// generated slot rather than the raw `end_time` column — the two only differ when
// slot_duration_minutes doesn't evenly divide the configured window, and it's the
// last real slot's end that must anchor the cutoff. Multiple template rows (e.g. a
// morning + evening shift on the same weekday) are supported by taking the max.
export function scheduleFinalEndTime(templates: Row[]): string | null {
  let maxEnd: number | null = null;
  for (const t of templates) {
    const dur = Number(t.slot_duration_minutes);
    const keys = generateSlotTimes(t.start_time, t.end_time, dur);
    const lastKey = keys[keys.length - 1];
    if (lastKey === undefined) continue;
    const end = toMinutes(lastKey) + dur;
    if (maxEnd === null || end > maxEnd) maxEnd = end;
  }
  return maxEnd === null ? null : fmtMinutes(maxEnd);
}

// True once "now" (in the branch's tz) is within `cutoffMinutes` of, at, or past the
// day's final end time — the shared predicate behind the patient booking cutoff, for
// both fixed and sequential schedules alike (see scheduleFinalEndTime above).
export function isPastBookingCutoff(
  date: string,
  finalEndTime: string | null,
  tz: string,
  cutoffMinutes: number = DEFAULT_BOOKING_CUTOFF_MINUTES,
): boolean {
  if (finalEndTime === null) return false;
  const today = todayInTz(tz);
  if (date < today) return true;
  if (date > today) return false;
  const cutoff = fmtMinutes(Math.max(0, toMinutes(finalEndTime) - cutoffMinutes));
  return currentTimeKeyInTz(tz) >= cutoff;
}

// Reception/staff/clinic-owner bookings and dashboards are exempt from the patient
// booking cutoff; an absent role (unauthenticated/public callers) is treated as a
// patient view for safety.
export function bookingCutoffAppliesToRole(role: string | null | undefined): boolean {
  return role == null || role === "patient";
}

export type SlotType = "fixed" | "sequential";

export interface DaySlot {
  time: string;
  available: boolean;
  slot_type: SlotType;
  capacity: number;
  remaining: number;
}

export interface DaySlotsResult {
  slots: DaySlot[];
  pastBookingCutoff: boolean;
}

export interface SlotCapacity {
  slotType: SlotType;
  maxPatients: number;
  durationMinutes: number;
}

// Shared by computeDaySlots/findNextSequentialSlot/nextAvailableSlot and the booking
// route: expands every template row into its generated HH:MM keys and records each
// key's slot_type/max_patients/duration — a doctor with multiple ranges in one day
// (e.g. morning + evening) can have different durations per range, so the caller must
// never assume a single `templates[0]` applies to every generated key. Two templates
// should never generate the same key post overlap validation, but the max capacity is
// taken defensively for data written before that check existed.
export function buildSlotCapacityMap(templates: Row[]): Map<string, SlotCapacity> {
  const map = new Map<string, SlotCapacity>();
  for (const t of templates) {
    const dur = Number(t.slot_duration_minutes);
    const maxPatients = Number(t.max_patients ?? 1);
    for (const key of generateSlotTimes(t.start_time, t.end_time, dur)) {
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { slotType: t.slot_type as SlotType, maxPatients, durationMinutes: dur });
      } else if (maxPatients > existing.maxPatients) {
        existing.maxPatients = maxPatients;
      }
    }
  }
  return map;
}

// Non-cancelled booking counts per time for a doctor/date, used to derive remaining
// capacity per slot key.
export async function bookedCountsByTime(db: Db, doctorId: string, date: string): Promise<Map<string, number>> {
  const [rows] = await db.query<Row[]>(
    `SELECT scheduled_time, COUNT(*) AS cnt FROM appointments
      WHERE doctor_id = ? AND scheduled_date = ? AND status != 'cancelled'
      GROUP BY scheduled_time`,
    [doctorId, date],
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.scheduled_time, Number(r.cnt));
  return map;
}

export async function computeDaySlots(
  db: Db,
  doctorId: string,
  date: string,
  tz: string,
  branchId?: string,
  applyBookingCutoff = true,
): Promise<DaySlotsResult> {
  const wd = weekdayInTz(date, tz);
  const params: unknown[] = [doctorId];
  const branchFilter = branchId ? "AND dba.branch_id = ?" : "";
  if (branchId) params.push(branchId);
  params.push(wd, date, date, date, date);

  const [templates] = await db.query<Row[]>(
    `SELECT dst.start_time, dst.end_time, dst.slot_duration_minutes, dst.max_patients, dba.slot_type
       FROM doctor_slot_templates dst
       JOIN doctor_branch_assignments dba ON dba.id = dst.doctor_branch_assignment_id
       JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
      WHERE dba.doctor_id = ? ${branchFilter} AND dba.is_active = 1 AND dst.is_active = 1 AND dst.weekday = ?
        AND dst.start_date <= ? AND (dst.end_date IS NULL OR dst.end_date >= ?)
        AND NOT EXISTS (
          SELECT 1 FROM doctor_slot_exceptions dse
           WHERE dse.doctor_branch_assignment_id = dba.id AND dse.status = 'active'
             AND dse.excluded_date <= ? AND COALESCE(dse.end_date, dse.excluded_date) >= ?
        )`,
    params,
  );

  const capacityMap = buildSlotCapacityMap(templates);
  const booked = capacityMap.size > 0 ? await bookedCountsByTime(db, doctorId, date) : new Map<string, number>();

  const pastBookingCutoff =
    applyBookingCutoff && isPastBookingCutoff(date, scheduleFinalEndTime(templates), tz);

  const slots: DaySlot[] = [...capacityMap.entries()]
    .map(([time, { slotType, maxPatients }]) => {
      const bookedCount = booked.get(time) ?? 0;
      const remaining = pastBookingCutoff ? 0 : Math.max(0, maxPatients - bookedCount);
      return {
        time,
        available: remaining > 0,
        slot_type: slotType,
        capacity: maxPatients,
        remaining,
      };
    })
    .sort((a, b) => a.time.localeCompare(b.time));

  return { slots, pastBookingCutoff };
}

export async function findNextSequentialSlot(
  db: Db,
  doctorId: string,
  branchId: string,
  date: string,
  tz: string,
  excludeTimes: Set<string> = new Set(),
): Promise<string | null> {
  const wd = weekdayInTz(date, tz);
  // Defensive backstop: the appointments route already checks the branch schedule
  // and returns a specific CLINIC_CLOSED error before reaching this function, but a
  // closed branch/weekday must never surface a sequential slot regardless of caller.
  const branchSchedule = await getBranchSchedule(db, branchId, { from: date, to: date });
  if (!isWeekdayOpen(branchSchedule, wd) || findCoveringLeave(date, branchSchedule.closures)) {
    return null;
  }
  const [templates] = await db.query<Row[]>(
    `SELECT dst.start_time, dst.end_time, dst.slot_duration_minutes, dst.max_patients
       FROM doctor_slot_templates dst
       JOIN doctor_branch_assignments dba ON dba.id = dst.doctor_branch_assignment_id
      WHERE dba.doctor_id = ? AND dba.branch_id = ? AND dba.is_active = 1
        AND dba.slot_type = 'sequential' AND dst.weekday = ? AND dst.is_active = 1
        AND dst.start_date <= ? AND (dst.end_date IS NULL OR dst.end_date >= ?)
        AND NOT EXISTS (
          SELECT 1 FROM doctor_slot_exceptions dse
           WHERE dse.doctor_branch_assignment_id = dba.id AND dse.status = 'active'
             AND dse.excluded_date <= ? AND COALESCE(dse.end_date, dse.excluded_date) >= ?
        )`,
    [doctorId, branchId, wd, date, date, date, date],
  );
  if (templates.length === 0) return null;

  const capacityMap = buildSlotCapacityMap(templates);
  const booked = await bookedCountsByTime(db, doctorId, date);
  // A time already tried and rejected in this same booking attempt counts as one
  // more occupant, so a capacity > 1 slot doesn't hand out the same key twice in a row.
  for (const t of excludeTimes) booked.set(t, (booked.get(t) ?? 0) + 1);

  const today = todayInTz(tz);
  const nowKey = date === today ? currentTimeKeyInTz(tz) : null;

  const candidates = [...capacityMap.keys()].sort((a, b) => a.localeCompare(b));

  for (const key of candidates) {
    const { maxPatients } = capacityMap.get(key)!;
    if ((booked.get(key) ?? 0) >= maxPatients) continue;
    if (nowKey !== null && key <= nowKey) continue;
    return key;
  }
  return null;
}

export async function nextAvailableSlot(
  db: Db,
  assignmentId: string,
  tz: string,
): Promise<string | null> {
  const [templates] = await db.query<Row[]>(
    `SELECT dst.* FROM doctor_slot_templates dst
      WHERE dst.doctor_branch_assignment_id = ? ORDER BY dst.weekday, dst.start_time`,
    [assignmentId],
  );
  const [assignments] = await db.query<Row[]>(
    `SELECT doctor_id, branch_id FROM doctor_branch_assignments WHERE id = ?`,
    [assignmentId],
  );
  const doctorId = assignments[0]?.doctor_id;
  const branchId = assignments[0]?.branch_id;
  if (!doctorId || !branchId) return null;

  const [exceptions] = await db.query<Row[]>(
    `SELECT excluded_date, end_date FROM doctor_slot_exceptions
      WHERE doctor_branch_assignment_id = ? AND status = 'active'`,
    [assignmentId],
  );
  const leaveRanges: LeaveRange[] = exceptions.map((e) => ({
    start_date: String(e.excluded_date).slice(0, 10),
    end_date: String(e.end_date ?? e.excluded_date).slice(0, 10),
    reason: null,
  }));

  const today = todayInTz(tz);
  const branchSchedule = await getBranchSchedule(db, branchId, { from: today, to: addDays(today, 59) });

  for (let dayOffset = 0; dayOffset < 60; dayOffset++) {
    const date = addDays(today, dayOffset);
    if (findCoveringLeave(date, leaveRanges)) continue;
    const wd = weekdayInTz(date, tz);
    if (!isWeekdayOpen(branchSchedule, wd) || findCoveringLeave(date, branchSchedule.closures)) continue;
    const nowKey = dayOffset === 0 ? currentTimeKeyInTz(tz) : null;
    const dayTemplates = templates.filter(
      (t) => Number(t.weekday) === wd && Number(t.is_active) === 1 && t.start_date <= date && (!t.end_date || t.end_date >= date),
    );
    if (dayTemplates.length === 0) continue;
    const booked = await bookedCountsByTime(db, doctorId, date);
    for (const t of dayTemplates) {
      const maxPatients = Number(t.max_patients ?? 1);
      for (const key of generateSlotTimes(t.start_time, t.end_time, Number(t.slot_duration_minutes))) {
        if ((booked.get(key) ?? 0) >= maxPatients) continue;
        if (nowKey !== null && key <= nowKey) continue;
        return `${date}T${key}:00`;
      }
    }
  }
  return null;
}

export interface LeaveRange {
  id?: string;
  start_date: string;
  end_date: string;
  reason: string | null;
}

export function findCoveringLeave(date: string, leaves: LeaveRange[]): LeaveRange | null {
  for (const l of leaves) {
    if (date >= l.start_date && date <= l.end_date) return l;
  }
  return null;
}

export interface AvailabilityPeriod {
  start_date: string | null;
  end_date: string | null;
}

// The doctor-level availability period is derived (not stored): the union of an
// assignment's recurring doctor_slot_templates date ranges, per §6/§9 of the
// availability redesign — a doctor never has a single stored start/end date.
export async function getAvailabilityPeriods(
  db: Db,
  assignmentIds: string[],
): Promise<Map<string, AvailabilityPeriod>> {
  const result = new Map<string, AvailabilityPeriod>();
  if (assignmentIds.length === 0) return result;
  const [rows] = await db.query<Row[]>(
    `SELECT doctor_branch_assignment_id,
            MIN(start_date) AS start_date,
            CASE WHEN SUM(end_date IS NULL) > 0 THEN NULL ELSE MAX(end_date) END AS end_date
       FROM doctor_slot_templates
      WHERE doctor_branch_assignment_id IN (?) AND is_active = 1
      GROUP BY doctor_branch_assignment_id`,
    [assignmentIds],
  );
  for (const r of rows) {
    result.set(r.doctor_branch_assignment_id, {
      start_date: r.start_date ? String(r.start_date).slice(0, 10) : null,
      end_date: r.end_date ? String(r.end_date).slice(0, 10) : null,
    });
  }
  return result;
}

// Range-overlap query (per §11): only ACTIVE leaves overlapping [from, to] are fetched,
// so a selected week/month doesn't have to scan every historical leave row.
export async function getActiveLeaves(
  db: Db,
  assignmentIds: string[],
  range?: { from?: string; to?: string },
): Promise<Map<string, LeaveRange[]>> {
  const result = new Map<string, LeaveRange[]>();
  if (assignmentIds.length === 0) return result;
  const where = [`doctor_branch_assignment_id IN (?)`, `status = 'active'`];
  const params: unknown[] = [assignmentIds];
  if (range?.to) {
    where.push(`excluded_date <= ?`);
    params.push(range.to);
  }
  if (range?.from) {
    where.push(`COALESCE(end_date, excluded_date) >= ?`);
    params.push(range.from);
  }
  const [rows] = await db.query<Row[]>(
    `SELECT id, doctor_branch_assignment_id, excluded_date, end_date, reason
       FROM doctor_slot_exceptions
      WHERE ${where.join(" AND ")}
      ORDER BY excluded_date`,
    params,
  );
  for (const r of rows) {
    const list = result.get(r.doctor_branch_assignment_id) ?? [];
    list.push({
      id: r.id,
      start_date: String(r.excluded_date).slice(0, 10),
      end_date: String(r.end_date ?? r.excluded_date).slice(0, 10),
      reason: r.reason,
    });
    result.set(r.doctor_branch_assignment_id, list);
  }
  return result;
}

export interface BranchScheduleGate {
  // weekday -> is_open; absence of a key means "open" (the branch default).
  operatingDays: Map<number, boolean>;
  closures: LeaveRange[];
}

export function isWeekdayOpen(schedule: BranchScheduleGate, weekday: number): boolean {
  return schedule.operatingDays.get(weekday) ?? true;
}

export async function getBranchOperatingDays(db: Db, branchId: string): Promise<Map<number, boolean>> {
  const [rows] = await db.query<Row[]>(
    `SELECT weekday, is_open FROM branch_operating_days WHERE branch_id = ?`,
    [branchId],
  );
  const map = new Map<number, boolean>();
  for (const r of rows) map.set(Number(r.weekday), !!r.is_open);
  return map;
}

// Same range-overlap pattern as getActiveLeaves, scoped to one branch rather than a
// set of assignments.
export async function getActiveBranchClosures(
  db: Db,
  branchId: string,
  range?: { from?: string; to?: string },
): Promise<LeaveRange[]> {
  const where = [`branch_id = ?`, `status = 'active'`];
  const params: unknown[] = [branchId];
  if (range?.to) {
    where.push(`start_date <= ?`);
    params.push(range.to);
  }
  if (range?.from) {
    where.push(`end_date >= ?`);
    params.push(range.from);
  }
  const [rows] = await db.query<Row[]>(
    `SELECT id, start_date, end_date, reason FROM branch_closures
      WHERE ${where.join(" AND ")}
      ORDER BY start_date`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    start_date: String(r.start_date).slice(0, 10),
    end_date: String(r.end_date).slice(0, 10),
    reason: r.reason,
  }));
}

export async function getBranchSchedule(
  db: Db,
  branchId: string,
  range?: { from?: string; to?: string },
): Promise<BranchScheduleGate> {
  const [operatingDays, closures] = await Promise.all([
    getBranchOperatingDays(db, branchId),
    getActiveBranchClosures(db, branchId, range),
  ]);
  return { operatingDays, closures };
}

export type DateStatus =
  | "available"
  | "leave"
  | "clinic_closed"
  | "unavailable"
  | "fully_booked"
  | "booking_closed"
  | "outside_schedule"
  | "past";

export interface DateAvailability {
  date: string;
  status: DateStatus;
  is_bookable: boolean;
  leave: { start_date: string; end_date: string; reason: string | null } | null;
  closure: { start_date: string; end_date: string; reason: string | null } | null;
  slots: DaySlot[];
}

// The single source of truth for "is this date bookable": AVAILABLE = the branch is
// open that weekday and not under an active closure, the date is within the doctor's
// derived schedule range, not covered by an active doctor leave, not in the past, and
// has at least one open slot for that weekday. Every availability endpoint
// (single-date, range, week, calendar) and the booking endpoint must agree with this.
// `applyBookingCutoff` (default true) folds in the 30-minute patient booking cutoff;
// callers viewing on behalf of reception/staff/clinic-owner pass false to bypass it.
export async function computeDateAvailability(
  db: Db,
  doctorId: string,
  branchId: string,
  date: string,
  tz: string,
  period: AvailabilityPeriod,
  leaves: LeaveRange[],
  today: string,
  branchSchedule: BranchScheduleGate,
  applyBookingCutoff = true,
): Promise<DateAvailability> {
  if (date < today) {
    return { date, status: "past", is_bookable: false, leave: null, closure: null, slots: [] };
  }
  const weekday = weekdayInTz(date, tz);
  const closure = findCoveringLeave(date, branchSchedule.closures);
  if (closure || !isWeekdayOpen(branchSchedule, weekday)) {
    return {
      date,
      status: "clinic_closed",
      is_bookable: false,
      leave: null,
      closure: closure
        ? { start_date: closure.start_date, end_date: closure.end_date, reason: closure.reason }
        : null,
      slots: [],
    };
  }
  if (!period.start_date || date < period.start_date || (period.end_date !== null && date > period.end_date)) {
    return { date, status: "outside_schedule", is_bookable: false, leave: null, closure: null, slots: [] };
  }
  const leave = findCoveringLeave(date, leaves);
  if (leave) {
    return {
      date,
      status: "leave",
      is_bookable: false,
      leave: { start_date: leave.start_date, end_date: leave.end_date, reason: leave.reason },
      closure: null,
      slots: [],
    };
  }
  const { slots, pastBookingCutoff } = await computeDaySlots(db, doctorId, date, tz, branchId, applyBookingCutoff);
  if (slots.length === 0) {
    return { date, status: "unavailable", is_bookable: false, leave: null, closure: null, slots: [] };
  }
  const hasOpen = slots.some((s) => s.available);
  return {
    date,
    status: hasOpen ? "available" : pastBookingCutoff ? "booking_closed" : "fully_booked",
    is_bookable: hasOpen,
    leave: null,
    closure: null,
    slots,
  };
}

export interface ResolvedAssignment {
  assignmentId: string;
  branchId: string;
  timezone: string;
}

// Resolves which doctor_branch_assignment an availability lookup means. If branchId is
// given, it must match exactly (a doctor's schedule differs per branch). If omitted, the
// doctor's first active assignment is used — preserved for callers that predate the
// multi-branch-aware availability endpoints.
export async function resolveActiveAssignment(
  db: Db,
  doctorId: string,
  branchId?: string,
): Promise<ResolvedAssignment | null> {
  const params: unknown[] = [doctorId];
  const branchFilter = branchId ? "AND dba.branch_id = ?" : "";
  if (branchId) params.push(branchId);
  const [rows] = await db.query<Row[]>(
    `SELECT dba.id AS assignment_id, dba.branch_id, b.timezone
       FROM doctor_branch_assignments dba
       JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
      WHERE dba.doctor_id = ? ${branchFilter} AND dba.is_active = 1
      ORDER BY dba.created_at
      LIMIT 1`,
    params,
  );
  const row = rows[0];
  if (!row) return null;
  return { assignmentId: row.assignment_id, branchId: row.branch_id, timezone: row.timezone };
}
