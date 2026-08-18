import type { Pool, RowDataPacket } from "mysql2/promise";

type Db = Pool;
type Row = RowDataPacket;

interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export async function generateLabTestSlots(
  db: Db,
  branchId: string,
  branchTestId: string,
  date: string,
  durationMinutes: number,
): Promise<TimeSlot[]> {
  const dateObj = new Date(date + "T00:00:00Z");
  const weekday = dateObj.getUTCDay();

  const [scheduleRows] = await db.query<Row[]>(
    `SELECT start_time, end_time FROM lab_test_schedules
     WHERE branch_id = ? AND weekday = ? AND is_active = 1`,
    [branchId, weekday],
  );

  if (scheduleRows.length === 0) return [];

  const [closureRows] = await db.query<Row[]>(
    `SELECT id FROM branch_closures
     WHERE branch_id = ? AND status = 'active' AND start_date <= ? AND end_date >= ?`,
    [branchId, date, date],
  );
  if (closureRows.length > 0) return [];

  const [apptRows] = await db.query<Row[]>(
    `SELECT start_time, end_time FROM lab_test_appointments
     WHERE branch_id = ? AND branch_lab_test_id = ? AND appointment_date = ? AND status NOT IN ('CANCELLED', 'REJECTED')`,
    [branchId, branchTestId, date],
  );

  const bookedRanges = apptRows.map((r) => ({
    start: timeToMinutes(r.start_time),
    end: timeToMinutes(r.end_time),
  }));

  const slots: TimeSlot[] = [];

  for (const sched of scheduleRows) {
    const schedStart = timeToMinutes(String(sched.start_time).slice(0, 5));
    const schedEnd = timeToMinutes(String(sched.end_time).slice(0, 5));

    for (let t = schedStart; t + durationMinutes <= schedEnd; t += durationMinutes) {
      const slotStart = t;
      const slotEnd = t + durationMinutes;

      const isBooked = bookedRanges.some(
        (b) => slotStart < b.end && slotEnd > b.start,
      );

      slots.push({
        start: minutesToTime(slotStart),
        end: minutesToTime(slotEnd),
        available: !isBooked,
      });
    }
  }

  return slots;
}
