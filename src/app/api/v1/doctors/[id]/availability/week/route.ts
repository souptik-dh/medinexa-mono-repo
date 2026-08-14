import { pool, type Row } from "@/lib/db";
import { api, json } from "@/lib/http";
import { badRequest, notFound } from "@/lib/errors";
import {
  addDays,
  computeDateAvailability,
  formatTime12h,
  getActiveLeaves,
  getAvailabilityPeriods,
  resolveActiveAssignment,
  todayInTz,
  weekdayNameInTz,
} from "@/lib/availability";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function displayTime(info: { status: string; is_bookable: boolean; slots: { time: string; available: boolean }[] }): string {
  if (info.status === "leave") return "Doctor on leave";
  if (info.status === "fully_booked") return "Fully booked";
  if (!info.is_bookable) return "No slots";
  const first = info.slots.find((s) => s.available);
  return first ? formatTime12h(first.time) : "No slots";
}

export const GET = api(undefined, async (ctx) => {
  const doctorId = ctx.params.id;
  const sp = ctx.request.nextUrl.searchParams;

  const [doctors] = await pool.query<Row[]>(
    `SELECT id FROM doctors WHERE id = ? AND deleted_at IS NULL`,
    [doctorId],
  );
  if (!doctors[0]) throw notFound("DOCTOR_NOT_FOUND", "Doctor not found.");

  const branchId = sp.get("branch_id");
  if (!branchId) throw badRequest("VALIDATION_ERROR", "branch_id is required.", "branch_id");

  const assignment = await resolveActiveAssignment(pool, doctorId, branchId);
  if (!assignment) throw notFound("DOCTOR_NOT_FOUND", "Doctor is not assigned to this branch.");

  const anchorParam = sp.get("date");
  if (anchorParam && !DATE_RE.test(anchorParam)) {
    throw badRequest("VALIDATION_ERROR", "date must be YYYY-MM-DD.", "date");
  }
  const today = todayInTz(assignment.timezone);
  const weekStart = anchorParam ?? today;
  const weekEnd = addDays(weekStart, 6);

  const periods = await getAvailabilityPeriods(pool, [assignment.assignmentId]);
  const period = periods.get(assignment.assignmentId) ?? { start_date: null, end_date: null };
  const leavesByAssignment = await getActiveLeaves(pool, [assignment.assignmentId], {
    from: weekStart,
    to: weekEnd,
  });
  const leaves = leavesByAssignment.get(assignment.assignmentId) ?? [];

  const dates = [];
  for (let d = weekStart; d <= weekEnd; d = addDays(d, 1)) {
    const info = await computeDateAvailability(
      pool,
      doctorId,
      assignment.branchId,
      d,
      assignment.timezone,
      period,
      leaves,
      today,
    );
    dates.push({
      date: info.date,
      day: weekdayNameInTz(info.date, assignment.timezone, "short"),
      status: info.status,
      is_bookable: info.is_bookable,
      display_time: displayTime(info),
    });
  }

  return json({ week_start: weekStart, week_end: weekEnd, dates });
});
