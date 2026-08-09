import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getOwnedClinic } from "@/lib/scope";
import { notFound } from "@/lib/errors";
import { newId } from "@/lib/ids";

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  address: z.string().trim().min(1).max(500),
  phone: z.string().trim().min(1).max(32),
  lat: z.coerce.number().min(-90).max(90).optional().nullable(),
  lng: z.coerce.number().min(-180).max(180).optional().nullable(),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isTimezone, "Invalid IANA timezone."),
});

export const GET = api(undefined, async (ctx) => {
  const { clinicId } = ctx.params;
  const [clinics] = await pool.query<Row[]>(
    `SELECT id FROM clinics WHERE id = ? AND deleted_at IS NULL`,
    [clinicId],
  );
  if (!clinics[0]) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");

  const [branches] = await pool.query<Row[]>(
    `SELECT id, clinic_id, name, address, phone, lat, lng, timezone, photo_url, created_at
       FROM branches WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    [clinicId],
  );
  return json({
    items: branches.map((b) => ({
      id: b.id,
      clinic_id: b.clinic_id,
      name: b.name,
      address: b.address,
      phone: b.phone,
      lat: b.lat != null ? Number(b.lat) : null,
      lng: b.lng != null ? Number(b.lng) : null,
      timezone: b.timezone,
      photo_url: b.photo_url,
      created_at: b.created_at,
    })),
  });
});

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const { clinicId } = ctx.params;
  await getOwnedClinic(pool, clinicId, auth.userId);
  const body = parseBody(createSchema, await readJson(ctx.request));

  const id = newId();
  await pool.query(
    `INSERT INTO branches (id, clinic_id, name, address, phone, lat, lng, timezone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, clinicId, body.name, body.address, body.phone, body.lat ?? null, body.lng ?? null, body.timezone],
  );

  return json(
    {
      id,
      clinic_id: clinicId,
      name: body.name,
      address: body.address,
      phone: body.phone,
      lat: body.lat ?? null,
      lng: body.lng ?? null,
      timezone: body.timezone,
      photo_url: null,
      created_at: new Date().toISOString(),
    },
    201,
  );
});
