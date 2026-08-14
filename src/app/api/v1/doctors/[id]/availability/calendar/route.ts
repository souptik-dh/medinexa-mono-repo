import { pool, type Row } from "@/lib/db";
import { api, json } from "@/lib/http";
import { badRequest, notFound } from "@/lib/errors";
import {
  addDays,
  computeDateAvailability,
  getActiveLeaves,
  getAvailabilityPeriods,
  resolveActiveAssignment,
  todayInTz,
} from "@/lib/availability";

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

  const yearRaw = sp.get("year");
  const monthRaw = sp.get("month");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!yearRaw || !Number.isInteger(year) || year < 1970 || year > 9999) {
    throw badRequest("VALIDATION_ERROR", "year must be a valid integer.", "year");
  }
  if (!monthRaw || !Number.isInteger(month) || month < 1 || month > 12) {
    throw badRequest("VALIDATION_ERROR", "month must be between 1 and 12.", "month");
  }

  const assignment = await resolveActiveAssignment(pool, doctorId, branchId);
  if (!assignment) throw notFound("DOCTOR_NOT_FOUND", "Doctor is not assigned to this branch.");

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

  const periods = await getAvailabilityPeriods(pool, [assignment.assignmentId]);
  const period = periods.get(assignment.assignmentId) ?? { start_date: null, end_date: null };
  const leavesByAssignment = await getActiveLeaves(pool, [assignment.assignmentId], {
    from: monthStart,
    to: monthEnd,
  });
  const leaves = leavesByAssignment.get(assignment.assignmentId) ?? [];
  const today = todayInTz(assignment.timezone);

  const dates = [];
  for (let d = monthStart; d <= monthEnd; d = addDays(d, 1)) {
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
    dates.push({ date: info.date, status: info.status, is_bookable: info.is_bookable });
  }

  return json({ year, month, availability_period: period, dates });
});
