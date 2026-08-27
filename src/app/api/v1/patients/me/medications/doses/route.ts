import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { parseBody, idSchema, timeSchema } from "@/lib/validators";
import { badRequest, notFound } from "@/lib/errors";
import { newId } from "@/lib/ids";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().regex(DATE_RE, "Date must be YYYY-MM-DD.");

const logDoseSchema = z.object({
  medication_id: idSchema,
  dose_date: dateSchema,
  scheduled_time: timeSchema,
});

function rowToDose(r: Row) {
  return {
    id: r.id,
    medication_id: r.medication_id,
    patient_id: r.patient_id,
    dose_date: r.dose_date,
    scheduled_time: r.scheduled_time,
    taken_at: r.taken_at,
  };
}

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const sp = ctx.request.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  if (!from || !dateSchema.safeParse(from).success) {
    throw badRequest("VALIDATION_ERROR", "from must be YYYY-MM-DD.", "from");
  }
  if (!to || !dateSchema.safeParse(to).success) {
    throw badRequest("VALIDATION_ERROR", "to must be YYYY-MM-DD.", "to");
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT id, medication_id, patient_id, dose_date, scheduled_time, taken_at
       FROM medication_doses WHERE patient_id = ? AND dose_date BETWEEN ? AND ?
       ORDER BY dose_date ASC, scheduled_time ASC`,
    [auth.userId, from, to],
  );
  return json({ items: rows.map(rowToDose) });
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(logDoseSchema, await readJson(ctx.request));

  const [meds] = await pool.query<Row[]>(
    `SELECT id FROM medications WHERE id = ? AND patient_id = ?`,
    [body.medication_id, auth.userId],
  );
  if (!meds[0]) throw notFound("MEDICATION_NOT_FOUND", "Medication not found.");

  const id = newId();
  await pool.query(
    `INSERT IGNORE INTO medication_doses (id, medication_id, patient_id, dose_date, scheduled_time)
     VALUES (?, ?, ?, ?, ?)`,
    [id, body.medication_id, auth.userId, body.dose_date, body.scheduled_time],
  );

  const [rows] = await pool.query<Row[]>(
    `SELECT id, medication_id, patient_id, dose_date, scheduled_time, taken_at
       FROM medication_doses WHERE medication_id = ? AND dose_date = ? AND scheduled_time = ?`,
    [body.medication_id, body.dose_date, body.scheduled_time],
  );
  return json(rowToDose(rows[0]), 201);
});
