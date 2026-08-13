import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  return Math.max(0, WEEKDAYS.indexOf(weekday ?? ""));
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

export function generateSlotTimes(startTime: string, endTime: string, durationMinutes: number): string[] {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  const times: string[] = [];
  for (let m = start; m + durationMinutes <= end; m += durationMinutes) {
    times.push(fmtMinutes(m));
  }
  return times;
}

export type SlotType = "fixed" | "sequential";

export interface DaySlot {
  time: string;
  available: boolean;
  slot_type: SlotType;
}

export async function computeDaySlots(
  db: Db,
  doctorId: string,
  date: string,
  tz: string,
): Promise<DaySlot[]> {
  const wd = weekdayInTz(date, tz);
  const [templates] = await db.query<Row[]>(
    `SELECT dst.start_time, dst.end_time, dst.slot_duration_minutes, dba.slot_type
       FROM doctor_slot_templates dst
       JOIN doctor_branch_assignments dba ON dba.id = dst.doctor_branch_assignment_id
       JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
      WHERE dba.doctor_id = ? AND dba.is_active = 1 AND dst.weekday = ?
        AND dst.effective_from <= ? AND (dst.effective_to IS NULL OR dst.effective_to >= ?)`,
    [doctorId, wd, date, date],
  );

  const slots = new Map<string, { available: boolean; slotType: SlotType }>();
  for (const t of templates) {
    const dur = Number(t.slot_duration_minutes);
    for (const key of generateSlotTimes(t.start_time, t.end_time, dur)) {
      if (!slots.has(key)) slots.set(key, { available: true, slotType: t.slot_type as SlotType });
    }
  }

  if (slots.size > 0) {
    const [booked] = await db.query<Row[]>(
      `SELECT scheduled_time FROM appointments
        WHERE doctor_id = ? AND scheduled_date = ? AND status != 'cancelled'`,
      [doctorId, date],
    );
    for (const b of booked) {
      const entry = slots.get(b.scheduled_time);
      if (entry) entry.available = false;
    }
  }

  return [...slots.entries()]
    .map(([time, { available, slotType }]) => ({ time, available, slot_type: slotType }))
    .sort((a, b) => a.time.localeCompare(b.time));
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
  const [templates] = await db.query<Row[]>(
    `SELECT dst.start_time, dst.end_time, dst.slot_duration_minutes
       FROM doctor_slot_templates dst
       JOIN doctor_branch_assignments dba ON dba.id = dst.doctor_branch_assignment_id
      WHERE dba.doctor_id = ? AND dba.branch_id = ? AND dba.is_active = 1
        AND dba.slot_type = 'sequential' AND dst.weekday = ?
        AND dst.effective_from <= ? AND (dst.effective_to IS NULL OR dst.effective_to >= ?)`,
    [doctorId, branchId, wd, date, date],
  );
  if (templates.length === 0) return null;

  const [booked] = await db.query<Row[]>(
    `SELECT scheduled_time FROM appointments
      WHERE doctor_id = ? AND scheduled_date = ? AND status != 'cancelled'`,
    [doctorId, date],
  );
  const taken = new Set(booked.map((b) => b.scheduled_time));
  for (const t of excludeTimes) taken.add(t);

  const today = todayInTz(tz);
  const nowKey = date === today ? currentTimeKeyInTz(tz) : null;

  const candidates: string[] = [];
  for (const t of templates) {
    for (const key of generateSlotTimes(t.start_time, t.end_time, Number(t.slot_duration_minutes))) {
      candidates.push(key);
    }
  }
  candidates.sort((a, b) => a.localeCompare(b));

  for (const key of candidates) {
    if (taken.has(key)) continue;
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
    `SELECT doctor_id FROM doctor_branch_assignments WHERE id = ?`,
    [assignmentId],
  );
  const doctorId = assignments[0]?.doctor_id;
  if (!doctorId) return null;

  const today = todayInTz(tz);

  for (let dayOffset = 0; dayOffset < 60; dayOffset++) {
    const date = addDays(today, dayOffset);
    const wd = weekdayInTz(date, tz);
    const nowKey = dayOffset === 0 ? currentTimeKeyInTz(tz) : null;
    for (const t of templates) {
      if (Number(t.weekday) !== wd) continue;
      if (t.effective_from > date) continue;
      if (t.effective_to && t.effective_to < date) continue;
      const [booked] = await db.query<Row[]>(
        `SELECT scheduled_time FROM appointments
          WHERE doctor_id = ? AND scheduled_date = ? AND status != 'cancelled'`,
        [doctorId, date],
      );
      const taken = new Set(booked.map((b) => b.scheduled_time));
      for (const key of generateSlotTimes(t.start_time, t.end_time, Number(t.slot_duration_minutes))) {
        if (taken.has(key)) continue;
        if (nowKey !== null && key <= nowKey) continue;
        return `${date}T${key}:00`;
      }
    }
  }
  return null;
}
