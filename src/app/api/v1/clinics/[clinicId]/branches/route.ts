import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getOwnedClinic } from "@/lib/scope";
import { notFound } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { licenseFields } from "@/lib/licenses";

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
  nearby_location: z.string().trim().max(500).optional().nullable(),
  city: z.string().trim().max(255).optional().nullable(),
  district: z.string().trim().max(255).optional().nullable(),
  pin_code: z.string().trim().max(20).optional().nullable(),
  state: z.string().trim().max(255).optional().nullable(),
  post_office: z.string().trim().max(255).optional().nullable(),
  phone: z.string().trim().min(1).max(32),
  lat: z.coerce.number().min(-90).max(90).optional().nullable(),
  lng: z.coerce.number().min(-180).max(180).optional().nullable(),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isTimezone, "Invalid IANA timezone."),
  trade_license_number: z.string().trim().min(1).max(100),
  drug_license_number: z.string().trim().max(100).optional().nullable(),
  clinical_establishment_reg_number: z.string().trim().max(100).optional().nullable(),
});

export const GET = api(undefined, async (ctx) => {
  const { clinicId } = ctx.params;
  const [clinics] = await pool.query<Row[]>(
    `SELECT id FROM clinics WHERE id = ? AND deleted_at IS NULL`,
    [clinicId],
  );
  if (!clinics[0]) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");

  const [branches] = await pool.query<Row[]>(
    `SELECT * FROM branches WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    [clinicId],
  );
  return json({
    items: branches.map((b) => ({
      id: b.id,
      clinic_id: b.clinic_id,
      name: b.name,
      address: b.address,
      nearby_location: b.nearby_location ?? null,
      city: b.city ?? null,
      district: b.district ?? null,
      pin_code: b.pin_code ?? null,
      state: b.state ?? null,
      post_office: b.post_office ?? null,
      phone: b.phone,
      lat: b.lat != null ? Number(b.lat) : null,
      lng: b.lng != null ? Number(b.lng) : null,
      timezone: b.timezone,
      photo_url: b.photo_url,
      ...licenseFields(b),
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
    `INSERT INTO branches (id, clinic_id, name, address, nearby_location, city, district, pin_code, state, post_office, phone, lat, lng, timezone, trade_license_number, drug_license_number, clinical_establishment_reg_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      clinicId,
      body.name,
      body.address,
      body.nearby_location ?? null,
      body.city ?? null,
      body.district ?? null,
      body.pin_code ?? null,
      body.state ?? null,
      body.post_office ?? null,
      body.phone,
      body.lat ?? null,
      body.lng ?? null,
      body.timezone,
      body.trade_license_number,
      body.drug_license_number ?? null,
      body.clinical_establishment_reg_number ?? null,
    ],
  );

  return json(
    {
      id,
      clinic_id: clinicId,
      name: body.name,
      address: body.address,
      nearby_location: body.nearby_location ?? null,
      city: body.city ?? null,
      district: body.district ?? null,
      pin_code: body.pin_code ?? null,
      state: body.state ?? null,
      phone: body.phone,
      lat: body.lat ?? null,
      lng: body.lng ?? null,
      timezone: body.timezone,
      photo_url: null,
      trade_license_number: body.trade_license_number,
      trade_license_url: null,
      drug_license_number: body.drug_license_number ?? null,
      drug_license_url: null,
      clinical_establishment_reg_number: body.clinical_establishment_reg_number ?? null,
      clinical_establishment_reg_url: null,
      created_at: new Date().toISOString(),
    },
    201,
  );
});
