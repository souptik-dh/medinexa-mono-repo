import type { Pool } from "mysql2/promise";
import { pool as defaultPool, withTransaction, type Row } from "@/lib/db";
import { hasSlotPassedInTz } from "@/lib/availability";
import { transition } from "@/lib/appointments";
import { transitionLabAppointment } from "@/lib/lab-tests";
import {
  notifyAutoCancelledDoctorAppointments,
  notifyAutoCancelledLabTestAppointments,
} from "@/lib/schedule-cancellations";

// Auto-cancels appointments whose scheduled date+time has passed while they were never
// acted on. Mirrors autoCancelAppointmentsInRange/autoCancelLabTestAppointmentsInRange
// (the branch-closure/doctor-leave cascade) but is time-driven instead of event-driven.
// 'paid' doctor appointments are excluded, same as those functions — a paid-but-missed
// visit has refund implications a human should decide, not a cron. changed_by is left
// NULL on the status-log row (the existing NULL = system/cron convention).
const OVERDUE_REASON = "Appointment date/time passed without being confirmed/approved in time.";
const BATCH_LIMIT = 500;

export interface OverdueSweepResult {
  cancelledDoctorAppointments: number;
  cancelledLabTestAppointments: number;
}

export async function processOverdueAppointments(
  poolDb: Pool = defaultPool,
): Promise<OverdueSweepResult> {
  const cancelledDoctorAppts = await sweepDoctorAppointments(poolDb);
  const cancelledLabAppts = await sweepLabTestAppointments(poolDb);

  for (const [branchName, rows] of groupByBranch(cancelledDoctorAppts)) {
    await notifyAutoCancelledDoctorAppointments(rows, branchName, OVERDUE_REASON);
  }
  for (const [branchName, rows] of groupByBranch(cancelledLabAppts)) {
    await notifyAutoCancelledLabTestAppointments(rows, branchName, OVERDUE_REASON);
  }

  return {
    cancelledDoctorAppointments: cancelledDoctorAppts.length,
    cancelledLabTestAppointments: cancelledLabAppts.length,
  };
}

function groupByBranch(rows: Row[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = row.branch_name ?? "Unknown Branch";
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

async function sweepDoctorAppointments(poolDb: Pool): Promise<Row[]> {
  const [candidates] = await poolDb.query<Row[]>(
    `SELECT a.*, b.timezone AS branch_timezone, b.name AS branch_name
       FROM appointments a
       JOIN branches b ON b.id = a.branch_id
      WHERE a.status IN ('pending', 'confirmed')
        AND a.scheduled_date <= DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
      LIMIT ${BATCH_LIMIT}`,
  );

  const cancelled: Row[] = [];
  for (const appt of candidates) {
    if (!hasSlotPassedInTz(appt.scheduled_date, appt.scheduled_time, appt.branch_timezone)) continue;
    try {
      const didCancel = await withTransaction(async (conn) => {
        const [locked] = await conn.query<Row[]>(
          `SELECT * FROM appointments WHERE id = ? AND status IN ('pending', 'confirmed') FOR UPDATE`,
          [appt.id],
        );
        const current = locked[0];
        if (!current) return false;
        await transition(conn, current, "cancelled", null, ["pending", "confirmed"], OVERDUE_REASON);
        return true;
      });
      if (didCancel) cancelled.push(appt);
    } catch {
      // One failing appointment must not block the sweep of the rest.
    }
  }
  return cancelled;
}

async function sweepLabTestAppointments(poolDb: Pool): Promise<Row[]> {
  const [candidates] = await poolDb.query<Row[]>(
    `SELECT a.*, b.timezone AS branch_timezone, b.name AS branch_name
       FROM lab_test_appointments a
       JOIN branches b ON b.id = a.branch_id
      WHERE a.status IN ('PENDING', 'APPROVED')
        AND a.appointment_date <= DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
      LIMIT ${BATCH_LIMIT}`,
  );

  const cancelled: Row[] = [];
  for (const appt of candidates) {
    if (!hasSlotPassedInTz(appt.appointment_date, appt.start_time, appt.branch_timezone)) continue;
    try {
      const didCancel = await withTransaction(async (conn) => {
        const [locked] = await conn.query<Row[]>(
          `SELECT * FROM lab_test_appointments WHERE id = ? AND status IN ('PENDING', 'APPROVED') FOR UPDATE`,
          [appt.id],
        );
        const current = locked[0];
        if (!current) return false;
        await transitionLabAppointment(conn, current, "CANCELLED", null, OVERDUE_REASON);
        await conn.query(`UPDATE lab_test_appointments SET cancelled_at = NOW(3) WHERE id = ?`, [appt.id]);
        return true;
      });
      if (didCancel) cancelled.push(appt);
    } catch {
      // One failing appointment must not block the sweep of the rest.
    }
  }
  return cancelled;
}

let cronStarted = false;

/** In-process scheduler (started from instrumentation.ts) — runs every 15 minutes. */
export function startAppointmentExpiryCron(): void {
  if (cronStarted) return;
  cronStarted = true;
  const tick = async (): Promise<void> => {
    try {
      const { pool } = await import("@/lib/db");
      await processOverdueAppointments(pool);
    } catch {
      // Swallow — next tick retries. Never crash the server from the cron path.
    }
  };
  setTimeout(() => void tick(), 30_000).unref?.();
  setInterval(() => void tick(), 15 * 60 * 1000).unref?.();
}
