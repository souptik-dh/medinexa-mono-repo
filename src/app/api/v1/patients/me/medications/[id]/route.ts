import { z } from "zod";
import { api, json, noContent, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { parseBody } from "@/lib/validators";
import { badRequest, notFound } from "@/lib/errors";
import { medicationBaseSchema } from "../route";

const updateMedicationSchema = medicationBaseSchema.partial().extend({
  is_active: z.boolean().optional(),
});

const UPDATABLE_FIELDS = [
  "name",
  "dosage",
  "frequency_label",
  "prescriber",
  "refill_date",
  "is_active",
] as const;

function rowToMedication(r: Row) {
  return {
    id: r.id,
    patient_id: r.patient_id,
    name: r.name,
    dosage: r.dosage,
    frequency_label: r.frequency_label,
    schedule_type: r.schedule_type,
    day_of_month: r.day_of_month,
    times: r.times,
    prescriber: r.prescriber,
    refill_date: r.refill_date,
    is_active: !!r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(updateMedicationSchema, await readJson(ctx.request));

  const [existingRows] = await pool.query<Row[]>(
    `SELECT schedule_type, day_of_month FROM medications WHERE id = ? AND patient_id = ?`,
    [ctx.params.id, auth.userId],
  );
  if (!existingRows[0]) throw notFound("MEDICATION_NOT_FOUND", "Medication not found.");

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const field of UPDATABLE_FIELDS) {
    const value = body[field];
    if (value !== undefined) {
      sets.push(`${field} = ?`);
      values.push(field === "is_active" ? (value ? 1 : 0) : value ?? null);
    }
  }
  if (body.times !== undefined) {
    sets.push("times = ?");
    values.push(JSON.stringify(body.times));
  }

  if (body.schedule_type !== undefined || body.day_of_month !== undefined) {
    const effectiveType = body.schedule_type ?? existingRows[0].schedule_type;
    const effectiveDay = body.day_of_month !== undefined ? body.day_of_month : existingRows[0].day_of_month;
    if (effectiveType === "monthly" && !effectiveDay) {
      throw badRequest("VALIDATION_ERROR", "day_of_month is required when schedule_type is monthly.", "day_of_month");
    }
    sets.push("schedule_type = ?", "day_of_month = ?");
    values.push(effectiveType, effectiveType === "monthly" ? effectiveDay : null);
  }

  if (sets.length === 0) {
    throw badRequest("VALIDATION_ERROR", "At least one field must be provided.");
  }

  await pool.query(`UPDATE medications SET ${sets.join(", ")} WHERE id = ?`, [...values, ctx.params.id]);

  const [updated] = await pool.query<Row[]>(
    `SELECT id, patient_id, name, dosage, frequency_label, schedule_type, day_of_month, times, prescriber, refill_date, is_active, created_at, updated_at
       FROM medications WHERE id = ?`,
    [ctx.params.id],
  );
  return json(rowToMedication(updated[0]));
});

export const DELETE = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM medications WHERE id = ? AND patient_id = ?`,
    [ctx.params.id, auth.userId],
  );
  if (!rows[0]) throw notFound("MEDICATION_NOT_FOUND", "Medication not found.");
  await pool.query(`DELETE FROM medications WHERE id = ?`, [ctx.params.id]);
  return noContent();
});
