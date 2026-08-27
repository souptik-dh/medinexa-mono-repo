import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { parseBody, timeSchema } from "@/lib/validators";
import { badRequest } from "@/lib/errors";
import { newId } from "@/lib/ids";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCHEDULE_TYPES = ["daily", "monthly"] as const;

export const medicationBaseSchema = z.object({
  name: z.string().trim().min(1, "Medication name is required.").max(255),
  dosage: z.string().trim().min(1, "Dosage is required.").max(100),
  frequency_label: z.string().trim().max(100).optional().nullable(),
  schedule_type: z.enum(SCHEDULE_TYPES).optional(),
  day_of_month: z.number().int().min(1).max(31).optional().nullable(),
  times: z.array(timeSchema).min(1, "At least one time is required.").max(10, "Too many times."),
  prescriber: z.string().trim().max(255).optional().nullable(),
  refill_date: z.string().regex(DATE_RE, "refill_date must be YYYY-MM-DD.").optional().nullable(),
});

export const createMedicationSchema = medicationBaseSchema.refine(
  (body) => body.schedule_type !== "monthly" || !!body.day_of_month,
  { message: "day_of_month is required when schedule_type is monthly.", path: ["day_of_month"] },
);

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

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const activeParam = ctx.request.nextUrl.searchParams.get("active");
  const where = activeParam !== null ? "patient_id = ? AND is_active = ?" : "patient_id = ?";
  const params = activeParam !== null ? [auth.userId, activeParam === "true" ? 1 : 0] : [auth.userId];
  const [rows] = await pool.query<Row[]>(
    `SELECT id, patient_id, name, dosage, frequency_label, schedule_type, day_of_month, times, prescriber, refill_date, is_active, created_at, updated_at
       FROM medications WHERE ${where} ORDER BY is_active DESC, created_at DESC`,
    params,
  );
  return json({ items: rows.map(rowToMedication) });
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(createMedicationSchema, await readJson(ctx.request));
  if (body.schedule_type !== "monthly" && body.day_of_month) {
    throw badRequest("VALIDATION_ERROR", "day_of_month is only valid when schedule_type is monthly.", "day_of_month");
  }
  const id = newId();
  const scheduleType = body.schedule_type ?? "daily";

  await pool.query(
    `INSERT INTO medications (id, patient_id, name, dosage, frequency_label, schedule_type, day_of_month, times, prescriber, refill_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      auth.userId,
      body.name,
      body.dosage,
      body.frequency_label ?? null,
      scheduleType,
      scheduleType === "monthly" ? body.day_of_month : null,
      JSON.stringify(body.times),
      body.prescriber ?? null,
      body.refill_date ?? null,
    ],
  );

  const [rows] = await pool.query<Row[]>(
    `SELECT id, patient_id, name, dosage, frequency_label, schedule_type, day_of_month, times, prescriber, refill_date, is_active, created_at, updated_at
       FROM medications WHERE id = ?`,
    [id],
  );
  return json(rowToMedication(rows[0]), 201);
});
