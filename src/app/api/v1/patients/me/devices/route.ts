import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { parseBody } from "@/lib/validators";
import { newId } from "@/lib/ids";

export const DEVICE_CATEGORIES = [
  "blood_pressure",
  "glucose",
  "pulse_oximeter",
  "thermometer",
  "heart_monitor",
  "weight_scale",
  "nebulizer",
  "cpap",
  "insulin_pump",
  "wearable",
  "other",
] as const;

export const createDeviceSchema = z.object({
  name: z.string().trim().min(1, "Device name is required.").max(255, "Device name must be at most 255 characters."),
  category: z.enum(DEVICE_CATEGORIES, "Invalid device category."),
  brand: z.string().trim().max(100, "Brand must be at most 100 characters.").optional().nullable(),
  model: z.string().trim().max(100, "Model must be at most 100 characters.").optional().nullable(),
  serial_number: z.string().trim().max(100, "Serial number must be at most 100 characters.").optional().nullable(),
  notes: z.string().trim().max(1000, "Notes must be at most 1000 characters.").optional().nullable(),
});

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

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id, patient_id, name, category, brand, model, serial_number, notes, created_at, updated_at
       FROM patient_devices WHERE patient_id = ? ORDER BY created_at DESC`,
    [auth.userId],
  );
  return json({ items: rows.map(rowToDevice) });
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(createDeviceSchema, await readJson(ctx.request));
  const id = newId();
  const createdAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO patient_devices (id, patient_id, name, category, brand, model, serial_number, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      auth.userId,
      body.name,
      body.category,
      body.brand ?? null,
      body.model ?? null,
      body.serial_number ?? null,
      body.notes ?? null,
    ],
  );
  return json(
    {
      id,
      patient_id: auth.userId,
      name: body.name,
      category: body.category,
      brand: body.brand ?? null,
      model: body.model ?? null,
      serial_number: body.serial_number ?? null,
      notes: body.notes ?? null,
      created_at: createdAt,
      updated_at: createdAt,
    },
    201,
  );
});
