import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";

const SELECT_FIELDS =
  "id, name, email, phone, address, nearby_location, city, district, pin_code, state, post_office, photo_url, push_topic, created_at, updated_at";

function toProfile(u: Row) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    address: u.address,
    nearby_location: u.nearby_location,
    city: u.city,
    district: u.district,
    pin_code: u.pin_code,
    state: u.state,
    post_office: u.post_office,
    photo_url: u.photo_url,
    push_topic: u.push_topic,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT ${SELECT_FIELDS} FROM users WHERE id = ?`,
    [auth.userId],
  );
  const user = rows[0];
  if (!user) throw notFound("USER_NOT_FOUND", "User not found.");
  return json(toProfile(user));
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  address: z.string().trim().min(1).max(500).optional(),
  nearby_location: z.string().trim().max(500).nullable().optional(),
  city: z.string().trim().max(255).nullable().optional(),
  district: z.string().trim().max(255).nullable().optional(),
  pin_code: z.string().trim().max(20).nullable().optional(),
  state: z.string().trim().max(255).nullable().optional(),
  post_office: z.string().trim().max(255).nullable().optional(),
});

export const PATCH = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(patchSchema, await readJson(ctx.request));

  const fields: string[] = [];
  const params: unknown[] = [];
  for (const key of [
    "name",
    "phone",
    "address",
    "nearby_location",
    "city",
    "district",
    "pin_code",
    "state",
    "post_office",
  ] as const) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(body[key]);
    }
  }
  if (fields.length > 0) {
    await pool.query(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [
      ...params,
      auth.userId,
    ]);
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT ${SELECT_FIELDS} FROM users WHERE id = ?`,
    [auth.userId],
  );
  return json(toProfile(rows[0]));
});
