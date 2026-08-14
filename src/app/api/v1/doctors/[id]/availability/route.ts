import { z } from "zod";
import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";
import {
  addDays,
  computeDateAvailability,
  getActiveLeaves,
  getAvailabilityPeriods,
  getBranchSchedule,
  resolveActiveAssignment,
  todayInTz,
  weekdayNameInTz,
} from "@/lib/availability";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 62;

export const GET = api(undefined, async (ctx) => {
  const doctorId = ctx.params.id;
  const sp = ctx.request.nextUrl.searchParams;

  const [doctors] = await pool.query<Row[]>(
    `SELECT id FROM doctors WHERE id = ? AND deleted_at IS NULL`,
    [doctorId],
  );
  if (!doctors[0]) throw notFound("DOCTOR_NOT_FOUND", "Doctor not found.");

  const branchId = sp.get("branch_id") ?? undefined;
  const from = sp.get("from");
  const to = sp.get("to");
  const dateParam = sp.get("date");

  // Range mode (§2): from/to + branch_id, one call replaces N single-date lookups.
  if (from || to) {
    if (!branchId) {
      throw badRequest("VALIDATION_ERROR", "branch_id is required.", "branch_id");
    }
    if (!from || !DATE_RE.test(from)) {
      throw badRequest("VALIDATION_ERROR", "from must be YYYY-MM-DD.", "from");
    }
    if (!to || !DATE_RE.test(to)) {
      throw badRequest("VALIDATION_ERROR", "to must be YYYY-MM-DD.", "to");
    }
    if (to < from) {
      throw badRequest("VALIDATION_ERROR", "to must not be before from.", "to");
    }

    const assignment = await resolveActiveAssignment(pool, doctorId, branchId);
    if (!assignment) throw notFound("DOCTOR_NOT_FOUND", "Doctor is not assigned to this branch.");

    const spanDays = Math.round(
      (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
        86_400_000,
    ) + 1;
    if (spanDays > MAX_RANGE_DAYS) {
      throw badRequest("VALIDATION_ERROR", `Range must be at most ${MAX_RANGE_DAYS} days.`, "to");
    }

    const periods = await getAvailabilityPeriods(pool, [assignment.assignmentId]);
    const period = periods.get(assignment.assignmentId) ?? { start_date: null, end_date: null };
    const leavesByAssignment = await getActiveLeaves(pool, [assignment.assignmentId], { from, to });
    const leaves = leavesByAssignment.get(assignment.assignmentId) ?? [];
    const today = todayInTz(assignment.timezone);
    const branchSchedule = await getBranchSchedule(pool, assignment.branchId, { from, to });

    const dates = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const info = await computeDateAvailability(
        pool,
        doctorId,
        assignment.branchId,
        d,
        assignment.timezone,
        period,
        leaves,
        today,
        branchSchedule,
      );
      dates.push({
        date: info.date,
        day: weekdayNameInTz(info.date, assignment.timezone, "long"),
        status: info.status,
        is_bookable: info.is_bookable,
        leave: info.leave,
        closure: info.closure,
        slots: info.slots,
      });
    }

    return json({
      doctor_id: doctorId,
      branch_id: assignment.branchId,
      availability_period: period,
      leaves: leaves.map((l) => ({ start_date: l.start_date, end_date: l.end_date, reason: l.reason })),
      closures: branchSchedule.closures.map((c) => ({
        start_date: c.start_date,
        end_date: c.end_date,
        reason: c.reason,
      })),
      dates,
    });
  }

  // Legacy single-date mode — kept byte-compatible (`{ date, slots }`), with the new
  // status/is_bookable/leave fields added alongside since additive fields don't break
  // existing clients (API.md §2 versioning rule).
  const parsed = z.object({ date: z.string().regex(DATE_RE, "date must be YYYY-MM-DD") }).safeParse({
    date: dateParam ?? "",
  });
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Invalid date.",
          field: "date",
          request_id: ctx.reqId,
        },
      },
      422,
    );
  }
  const date = parsed.data.date;

  const assignment = await resolveActiveAssignment(pool, doctorId, branchId);
  if (!assignment) {
    // Preserve legacy behavior for doctors with no active assignment: empty slots,
    // not a 404, since this endpoint historically only required the doctor to exist.
    return json({ date, status: "outside_schedule", is_bookable: false, leave: null, closure: null, slots: [] });
  }

  const periods = await getAvailabilityPeriods(pool, [assignment.assignmentId]);
  const period = periods.get(assignment.assignmentId) ?? { start_date: null, end_date: null };
  const leavesByAssignment = await getActiveLeaves(pool, [assignment.assignmentId], {
    from: date,
    to: date,
  });
  const leaves = leavesByAssignment.get(assignment.assignmentId) ?? [];
  const today = todayInTz(assignment.timezone);
  const branchSchedule = await getBranchSchedule(pool, assignment.branchId, { from: date, to: date });

  const info = await computeDateAvailability(
    pool,
    doctorId,
    assignment.branchId,
    date,
    assignment.timezone,
    period,
    leaves,
    today,
    branchSchedule,
  );

  return json({
    date,
    status: info.status,
    is_bookable: info.is_bookable,
    leave: info.leave,
    closure: info.closure,
    slots: info.slots,
  });
});
