import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody, idSchema, phoneSchema } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";

const SELECT_FIELDS = `u.id, u.name, u.first_name, u.last_name, u.email, u.phone, u.phone_verified, u.date_of_birth, u.gender,
       u.height_cm, u.weight_kg, u.bmi,
       u.address, u.nearby_location, u.city, u.district, u.pin_code, u.state, u.post_office,
       u.photo_url, u.preferred_clinic_id, u.preferred_branch_id,
       pc.name AS preferred_clinic_name, pb.name AS preferred_branch_name,
       u.created_at, u.updated_at`;

const FROM_CLAUSE = `FROM users u
       LEFT JOIN clinics pc ON pc.id = u.preferred_clinic_id
       LEFT JOIN branches pb ON pb.id = u.preferred_branch_id`;

const GENDERS = ["male", "female", "other", "prefer_not_to_say"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toProfile(u: Row) {
  return {
    id: u.id,
    name: u.name,
    first_name: u.first_name,
    last_name: u.last_name,
    email: u.email,
    phone: u.phone,
    phone_verified: u.phone_verified === 1 || u.phone_verified === true,
    date_of_birth: u.date_of_birth,
    gender: u.gender,
    height_cm: u.height_cm === null || u.height_cm === undefined ? null : Number(u.height_cm),
    weight_kg: u.weight_kg === null || u.weight_kg === undefined ? null : Number(u.weight_kg),
    bmi: u.bmi === null || u.bmi === undefined ? null : Number(u.bmi),
    address: u.address,
    nearby_location: u.nearby_location,
    city: u.city,
    district: u.district,
    pin_code: u.pin_code,
    state: u.state,
    post_office: u.post_office,
    photo_url: u.photo_url,
    preferred_clinic_id: u.preferred_clinic_id,
    preferred_clinic_name: u.preferred_clinic_name,
    preferred_branch_id: u.preferred_branch_id,
    preferred_branch_name: u.preferred_branch_name,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT ${SELECT_FIELDS} ${FROM_CLAUSE} WHERE u.id = ?`,
    [auth.userId],
  );
  const user = rows[0];
  if (!user) throw notFound("USER_NOT_FOUND", "User not found.");
  return json(toProfile(user));
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  first_name: z.string().trim().min(1).max(150).optional(),
  last_name: z.string().trim().min(1).max(150).optional(),
  phone: phoneSchema.nullable().optional(),
  date_of_birth: z
    .string()
    .regex(DATE_RE, "date_of_birth must be YYYY-MM-DD.")
    .nullable()
    .optional(),
  gender: z.enum(GENDERS).nullable().optional(),
  height_cm: z.number().positive().max(300).nullable().optional(),
  weight_kg: z.number().positive().max(500).nullable().optional(),
  address: z.string().trim().min(1).max(500).optional(),
  nearby_location: z.string().trim().max(500).nullable().optional(),
  city: z.string().trim().max(255).nullable().optional(),
  district: z.string().trim().max(255).nullable().optional(),
  pin_code: z.string().trim().max(20).nullable().optional(),
  state: z.string().trim().max(255).nullable().optional(),
  post_office: z.string().trim().max(255).nullable().optional(),
  preferred_clinic_id: idSchema.nullable().optional(),
  preferred_branch_id: idSchema.nullable().optional(),
});

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(patchSchema, await readJson(ctx.request));

  if (body.date_of_birth && body.date_of_birth > new Date().toISOString().slice(0, 10)) {
    throw badRequest("VALIDATION_ERROR", "date_of_birth cannot be in the future.", "date_of_birth");
  }

  const fields: string[] = [];
  const params: unknown[] = [];
  for (const key of [
    "name",
    "phone",
    "date_of_birth",
    "gender",
    "height_cm",
    "weight_kg",
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

  if (body.height_cm !== undefined || body.weight_kg !== undefined) {
    const [rows] = await pool.query<Row[]>(
      `SELECT height_cm, weight_kg FROM users WHERE id = ?`,
      [auth.userId],
    );
    const height = body.height_cm !== undefined ? body.height_cm : rows[0]?.height_cm;
    const weight = body.weight_kg !== undefined ? body.weight_kg : rows[0]?.weight_kg;
    const heightNum = height === null || height === undefined ? null : Number(height);
    const weightNum = weight === null || weight === undefined ? null : Number(weight);
    const bmi =
      heightNum && weightNum
        ? Math.round((weightNum / (heightNum / 100) ** 2) * 10) / 10
        : null;
    fields.push("bmi = ?");
    params.push(bmi);
  }

  if (body.first_name !== undefined) {
    fields.push("first_name = ?");
    params.push(body.first_name);
  }
  if (body.last_name !== undefined) {
    fields.push("last_name = ?");
    params.push(body.last_name);
  }
  if (body.name === undefined && (body.first_name !== undefined || body.last_name !== undefined)) {
    const [rows] = await pool.query<Row[]>(
      `SELECT first_name, last_name FROM users WHERE id = ?`,
      [auth.userId],
    );
    const first = body.first_name ?? rows[0]?.first_name ?? "";
    const last = body.last_name ?? rows[0]?.last_name ?? "";
    const combined = `${first} ${last}`.trim();
    if (combined) {
      fields.push("name = ?");
      params.push(combined);
    }
  }

  if (body.preferred_branch_id !== undefined) {
    if (body.preferred_branch_id === null) {
      fields.push("preferred_branch_id = ?");
      params.push(null);
    } else {
      const [branches] = await pool.query<Row[]>(
        `SELECT id, clinic_id FROM branches WHERE id = ? AND deleted_at IS NULL`,
        [body.preferred_branch_id],
      );
      const branch = branches[0];
      if (!branch) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
      fields.push("preferred_branch_id = ?", "preferred_clinic_id = ?");
      params.push(branch.id, branch.clinic_id);
    }
  } else if (body.preferred_clinic_id !== undefined) {
    if (body.preferred_clinic_id === null) {
      fields.push("preferred_clinic_id = ?", "preferred_branch_id = ?");
      params.push(null, null);
    } else {
      const [clinics] = await pool.query<Row[]>(
        `SELECT id FROM clinics WHERE id = ? AND deleted_at IS NULL`,
        [body.preferred_clinic_id],
      );
      if (!clinics[0]) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");
      fields.push("preferred_clinic_id = ?", "preferred_branch_id = ?");
      params.push(body.preferred_clinic_id, null);
    }
  }

  if (fields.length > 0) {
    await pool.query(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [
      ...params,
      auth.userId,
    ]);
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT ${SELECT_FIELDS} ${FROM_CLAUSE} WHERE u.id = ?`,
    [auth.userId],
  );
  return json(toProfile(rows[0]));
});
