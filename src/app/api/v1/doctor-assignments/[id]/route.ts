import { z } from "zod";
import { api, json, noContent, readJson } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { forbidden, notFound, conflict } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { slotTemplateSchema } from "@/lib/slot-template";
import { rescheduleAppointmentsAfterTemplateChange, type RescheduledAppointment } from "@/lib/appointments";
import {
  notifyRescheduledDoctorAppointments,
  notifyAutoCancelledDoctorAppointments,
} from "@/lib/schedule-cancellations";

const RESCHEDULE_REASON =
  "The doctor's schedule was updated, so this appointment has been moved to a new time. Please review it.";

const patchSchema = z.object({
  fee_amount: z.coerce.number().positive().max(1_000_000).optional(),
  slot_type: z.enum(["fixed", "sequential"]).optional(),
  slot_template: slotTemplateSchema.optional(),
  certificate: z.string().trim().max(500).nullable().optional(),
});

async function loadAssignment(assignmentId: string) {
  const [rows] = await pool.query<Row[]>(
    `SELECT dba.*, c.owner_user_id, b.timezone AS branch_timezone, b.name AS branch_name
       FROM doctor_branch_assignments dba
       JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
       JOIN clinics c ON c.id = b.clinic_id AND c.deleted_at IS NULL
      WHERE dba.id = ?`,
    [assignmentId],
  );
  const row = rows[0];
  if (!row) throw notFound("ASSIGNMENT_NOT_FOUND", "Doctor assignment not found.");
  return row;
}

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "doctor", "branch_staff"]);
  const assignment = await loadAssignment(ctx.params.id);
  const body = parseBody(patchSchema, await readJson(ctx.request));

  let isOwner = false;
  if (auth.role === "clinic_owner") {
    if (assignment.owner_user_id !== auth.userId) {
      throw notFound("ASSIGNMENT_NOT_FOUND", "Doctor assignment not found.");
    }
    isOwner = true;
  } else if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, assignment.branch_id, "doctors:manage");
    isOwner = true;
  } else if (auth.role === "doctor") {
    if (assignment.doctor_id !== auth.doctorId) {
      throw notFound("ASSIGNMENT_NOT_FOUND", "Doctor assignment not found.");
    }
  }

  if (!isOwner && body.fee_amount !== undefined) {
    throw forbidden(
      "FEE_OWNER_CONTROLLED",
      "Only the clinic owner can change the consultation fee.",
    );
  }

  let rescheduleResult: { rescheduled: RescheduledAppointment[]; cancelled: Row[] } = {
    rescheduled: [],
    cancelled: [],
  };

  await withTransaction(async (conn) => {
    const fields: string[] = [];
    const params: unknown[] = [];
    if (body.fee_amount !== undefined) {
      fields.push("fee_amount = ?");
      params.push(body.fee_amount);
    }
    if (body.slot_type !== undefined) {
      fields.push("slot_type = ?");
      params.push(body.slot_type);
    }
    if (fields.length > 0) {
      await conn.query(
        `UPDATE doctor_branch_assignments SET ${fields.join(", ")} WHERE id = ?`,
        [...params, assignment.id],
      );
    }

    if (body.certificate !== undefined) {
      await conn.query(`UPDATE doctors SET certificate_url = ? WHERE id = ?`, [
        body.certificate,
        assignment.doctor_id,
      ]);
    }

    if (body.slot_template !== undefined) {
      await conn.query(
        `DELETE FROM doctor_slot_templates WHERE doctor_branch_assignment_id = ?`,
        [assignment.id],
      );
      for (const t of body.slot_template) {
        const [h, m] = t.start_time.split(":");
        const [eh, em] = t.end_time.split(":");
        await conn.query(
          `INSERT INTO doctor_slot_templates
             (id, doctor_branch_assignment_id, weekday, label, start_time, end_time, slot_duration_minutes, max_patients, is_active, start_date, end_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId(),
            assignment.id,
            t.weekday,
            t.label ?? null,
            `${h}:${m}:00`,
            `${eh}:${em}:00`,
            t.slot_duration_minutes,
            t.max_patients,
            t.is_active ? 1 : 0,
            t.start_date,
            t.end_date ?? null,
          ],
        );
      }

      // The new rows just replaced the doctor's whole weekly pattern — any existing
      // pending/confirmed appointment that no longer lines up with it (time moved,
      // weekday dropped, duration changed) gets moved to the soonest matching slot,
      // or cancelled if nothing matches within the lookahead window. Notified after
      // the transaction commits (see below).
      rescheduleResult = await rescheduleAppointmentsAfterTemplateChange(conn, {
        assignmentId: assignment.id,
        doctorId: assignment.doctor_id,
        branchId: assignment.branch_id,
        tz: assignment.branch_timezone,
        changedBy: auth.userId,
        reason: RESCHEDULE_REASON,
      });
    }
  });

  await Promise.all([
    notifyRescheduledDoctorAppointments(rescheduleResult.rescheduled, assignment.branch_name, RESCHEDULE_REASON),
    notifyAutoCancelledDoctorAppointments(rescheduleResult.cancelled, assignment.branch_name, RESCHEDULE_REASON),
  ]);

  return json({
    id: assignment.id,
    doctor_id: assignment.doctor_id,
    branch_id: assignment.branch_id,
    fee_amount: Number(body.fee_amount ?? assignment.fee_amount),
    currency: assignment.currency,
    slot_type: body.slot_type ?? assignment.slot_type,
    certificate_url: body.certificate !== undefined ? body.certificate : assignment.certificate_url ?? null,
    slot_template: await loadSlotTemplate(assignment.id),
    rescheduled_appointment_count: rescheduleResult.rescheduled.length,
    cancelled_appointment_count: rescheduleResult.cancelled.length,
  });
});

function serializeSlotTemplateRow(r: Row) {
  return {
    id: r.id,
    weekday: Number(r.weekday),
    label: r.label ?? null,
    start_time: String(r.start_time).slice(0, 5),
    end_time: String(r.end_time).slice(0, 5),
    slot_duration_minutes: Number(r.slot_duration_minutes),
    max_patients: Number(r.max_patients),
    is_active: !!r.is_active,
    start_date: String(r.start_date).slice(0, 10),
    end_date: r.end_date ? String(r.end_date).slice(0, 10) : null,
  };
}

async function loadSlotTemplate(assignmentId: string) {
  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM doctor_slot_templates WHERE doctor_branch_assignment_id = ? ORDER BY weekday, start_time`,
    [assignmentId],
  );
  return rows.map(serializeSlotTemplateRow);
}

// Lets clinic/branch staff and the doctor themself load the current per-weekday slot
// ranges for editing — nothing previously returned these raw rows to a client.
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "doctor", "branch_staff"]);
  const assignment = await loadAssignment(ctx.params.id);

  if (auth.role === "clinic_owner") {
    if (assignment.owner_user_id !== auth.userId) {
      throw notFound("ASSIGNMENT_NOT_FOUND", "Doctor assignment not found.");
    }
  } else if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, assignment.branch_id, "doctors:manage");
  } else if (auth.role === "doctor" && assignment.doctor_id !== auth.doctorId) {
    throw notFound("ASSIGNMENT_NOT_FOUND", "Doctor assignment not found.");
  }

  return json({
    id: assignment.id,
    doctor_id: assignment.doctor_id,
    branch_id: assignment.branch_id,
    fee_amount: Number(assignment.fee_amount),
    currency: assignment.currency,
    slot_type: assignment.slot_type,
    certificate_url: assignment.certificate_url ?? null,
    slot_template: await loadSlotTemplate(assignment.id),
  });
});

export const DELETE = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const assignment = await loadAssignment(ctx.params.id);
  if (auth.role === "clinic_owner") {
    if (assignment.owner_user_id !== auth.userId) {
      throw notFound("ASSIGNMENT_NOT_FOUND", "Doctor assignment not found.");
    }
  } else {
    await assertBranchStaffPermission(pool, auth, assignment.branch_id, "doctors:manage");
  }

  const [active] = await pool.query<Row[]>(
    `SELECT COUNT(*) AS cnt FROM appointments
      WHERE doctor_id = ? AND branch_id = ? AND status IN ('pending','confirmed','paid')`,
    [assignment.doctor_id, assignment.branch_id],
  );
  if (Number(active[0].cnt) > 0) {
    throw conflict(
      "DOCTOR_HAS_ACTIVE_APPOINTMENTS",
      "This doctor has active appointments at the branch. Resolve or cancel them first.",
    );
  }

  await pool.query(`UPDATE doctor_branch_assignments SET is_active = 0 WHERE id = ?`, [assignment.id]);
  return noContent();
});
