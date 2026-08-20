import { api, json, noContent, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { parseBody } from "@/lib/validators";
import { badRequest, notFound } from "@/lib/errors";
import { createDeviceSchema } from "../route";

const updateDeviceSchema = createDeviceSchema.partial();
const UPDATABLE_FIELDS = ["name", "category", "brand", "model", "serial_number", "notes"] as const;

function rowToDevice(r: Row) {
  return {
    id: r.id,
    patient_id: r.patient_id,
    name: r.name,
    category: r.category,
    brand: r.brand,
    model: r.model,
    serial_number: r.serial_number,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(updateDeviceSchema, await readJson(ctx.request));

  const sets: string[] = [];
  const values: (string | null)[] = [];
  for (const field of UPDATABLE_FIELDS) {
    const value = body[field];
    if (value !== undefined) {
      sets.push(`${field} = ?`);
      values.push(value ?? null);
    }
  }
  if (sets.length === 0) {
    throw badRequest("VALIDATION_ERROR", "At least one field must be provided.");
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM patient_devices WHERE id = ? AND patient_id = ?`,
    [ctx.params.id, auth.userId],
  );
  if (!rows[0]) throw notFound("DEVICE_NOT_FOUND", "Device not found.");

  await pool.query(`UPDATE patient_devices SET ${sets.join(", ")} WHERE id = ?`, [...values, ctx.params.id]);
  const [updated] = await pool.query<Row[]>(
    `SELECT id, patient_id, name, category, brand, model, serial_number, notes, created_at, updated_at
       FROM patient_devices WHERE id = ?`,
    [ctx.params.id],
  );
  return json(rowToDevice(updated[0]));
});

export const DELETE = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM patient_devices WHERE id = ? AND patient_id = ?`,
    [ctx.params.id, auth.userId],
  );
  if (!rows[0]) throw notFound("DEVICE_NOT_FOUND", "Device not found.");
  await pool.query(`DELETE FROM patient_devices WHERE id = ?`, [ctx.params.id]);
  return noContent();
});
