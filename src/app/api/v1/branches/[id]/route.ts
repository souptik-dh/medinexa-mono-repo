import { z } from "zod";
import { api, json, noContent, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { conflict } from "@/lib/errors";

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  address: z.string().trim().min(1).max(500).optional(),
  nearby_location: z.string().trim().max(500).nullable().optional(),
  city: z.string().trim().max(255).nullable().optional(),
  district: z.string().trim().max(255).nullable().optional(),
  pin_code: z.string().trim().max(20).nullable().optional(),
  state: z.string().trim().max(255).nullable().optional(),
  phone: z.string().trim().min(1).max(32).optional(),
  lat: z.coerce.number().min(-90).max(90).nullable().optional(),
  lng: z.coerce.number().min(-180).max(180).nullable().optional(),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isTimezone, "Invalid IANA timezone.")
    .optional(),
});

export const PATCH = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const branch = await getOwnedBranch(pool, ctx.params.id, auth.userId);
  const body = parseBody(patchSchema, await readJson(ctx.request));

  const fields: string[] = [];
  const params: unknown[] = [];
  if (body.name !== undefined) { fields.push("name = ?"); params.push(body.name); }
  if (body.address !== undefined) { fields.push("address = ?"); params.push(body.address); }
  if (body.nearby_location !== undefined) { fields.push("nearby_location = ?"); params.push(body.nearby_location); }
  if (body.city !== undefined) { fields.push("city = ?"); params.push(body.city); }
  if (body.district !== undefined) { fields.push("district = ?"); params.push(body.district); }
  if (body.pin_code !== undefined) { fields.push("pin_code = ?"); params.push(body.pin_code); }
  if (body.state !== undefined) { fields.push("state = ?"); params.push(body.state); }
  if (body.post_office !== undefined) { fields.push("post_office = ?"); params.push(body.post_office); }
  if (body.phone !== undefined) { fields.push("phone = ?"); params.push(body.phone); }
  if (body.lat !== undefined) { fields.push("lat = ?"); params.push(body.lat); }
  if (body.lng !== undefined) { fields.push("lng = ?"); params.push(body.lng); }
  if (body.timezone !== undefined) { fields.push("timezone = ?"); params.push(body.timezone); }

  if (fields.length > 0) {
    await pool.query(`UPDATE branches SET ${fields.join(", ")} WHERE id = ?`, [...params, branch.id]);
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT id, clinic_id, name, address, nearby_location, city, district, pin_code, state, post_office, phone, lat, lng, timezone, photo_url, created_at
       FROM branches WHERE id = ? AND deleted_at IS NULL`,
    [branch.id],
  );
  const b = rows[0];
  return json({
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
    created_at: b.created_at,
  });
});

export const DELETE = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const branch = await getOwnedBranch(pool, ctx.params.id, auth.userId);
  const force = ctx.request.nextUrl.searchParams.get("force") === "true";

  const [active] = await pool.query<Row[]>(
    `SELECT COUNT(*) AS cnt FROM appointments a
      WHERE a.branch_id = ? AND a.status IN ('pending','confirmed','paid')`,
    [branch.id],
  );
  const hasActive = Number(active[0].cnt) > 0;

  if (hasActive && !force) {
    throw conflict(
      "CLINIC_HAS_ACTIVE_APPOINTMENTS",
      "This branch has active appointments. Resolve or cancel them first, or pass ?force=true.",
    );
  }
  if (force && hasActive) {
    await pool.query(
      `UPDATE appointments SET status = 'cancelled' WHERE branch_id = ? AND status IN ('pending','confirmed','paid')`,
      [branch.id],
    );
  }

  await pool.query(`UPDATE branches SET deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [branch.id]);
  return noContent();
});
