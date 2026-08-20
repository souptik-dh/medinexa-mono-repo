import { z } from "zod";
import { api, json, noContent, readJson } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { forbidden, notFound, conflict } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { assertBranchStaffPermission } from "@/lib/permissions";

const slotTemplateSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
    slot_duration_minutes: z.number().int().min(5).max(240),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .array()
  .min(1)
  .refine(
    (arr) => arr.every((s) => s.start_time < s.end_time),
    "start_time must be earlier than end_time.",
  )
  .refine(
    (arr) => arr.every((s) => !s.end_date || s.start_date <= s.end_date),
    "start_date must not be after end_date.",
  );

const patchSchema = z.object({
  fee_amount: z.coerce.number().positive().max(1_000_000).optional(),
  slot_type: z.enum(["fixed", "sequential"]).optional(),
  slot_template: slotTemplateSchema.optional(),
  certificate: z.string().trim().max(500).nullable().optional(),
});

async function loadAssignment(assignmentId: string) {
  const [rows] = await pool.query<Row[]>(
    `SELECT dba.*, c.owner_user_id
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
             (id, doctor_branch_assignment_id, weekday, start_time, end_time, slot_duration_minutes, start_date, end_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId(),
            assignment.id,
            t.weekday,
            `${h}:${m}:00`,
            `${eh}:${em}:00`,
            t.slot_duration_minutes,
            t.start_date,
            t.end_date ?? null,
          ],
        );
      }
    }
  });

  return json({
    id: assignment.id,
    doctor_id: assignment.doctor_id,
    branch_id: assignment.branch_id,
    fee_amount: Number(body.fee_amount ?? assignment.fee_amount),
    currency: assignment.currency,
    slot_type: body.slot_type ?? assignment.slot_type,
    certificate_url: body.certificate !== undefined ? body.certificate : assignment.certificate_url ?? null,
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
