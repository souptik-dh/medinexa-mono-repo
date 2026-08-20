import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { getDoctorSpecializations } from "@/lib/specializations";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["doctor"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id, name, reg_no, smc_name, doctor_degree, phone, certificate_url, photo_url, bio
       FROM doctors WHERE id = ? AND deleted_at IS NULL`,
    [auth.doctorId],
  );
  const doc = rows[0];
  if (!doc) throw notFound("DOCTOR_NOT_FOUND", "Doctor profile not found.");
  const specializationsByDoctor = await getDoctorSpecializations(pool, [String(doc.id)]);
  return json({
    id: doc.id,
    name: doc.name,
    specializations: specializationsByDoctor.get(String(doc.id)) ?? [],
    reg_no: doc.reg_no,
    smc_name: doc.smc_name,
    doctor_degree: doc.doctor_degree,
    phone: doc.phone,
    certificate_url: doc.certificate_url,
    photo_url: doc.photo_url,
    bio: doc.bio,
  });
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  reg_no: z.string().trim().max(64).nullable().optional(),
  smc_name: z.string().trim().max(255).nullable().optional(),
  doctor_degree: z.string().trim().max(100).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  bio: z.string().trim().max(2000).nullable().optional(),
});

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["doctor"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM doctors WHERE id = ? AND deleted_at IS NULL`,
    [auth.doctorId],
  );
  if (!rows[0]) throw notFound("DOCTOR_NOT_FOUND", "Doctor profile not found.");
  const body = parseBody(patchSchema, await readJson(ctx.request));

  const fields: string[] = [];
  const params: unknown[] = [];
  if (body.name !== undefined) { fields.push("name = ?"); params.push(body.name); }
  if (body.reg_no !== undefined) { fields.push("reg_no = ?"); params.push(body.reg_no); }
  if (body.smc_name !== undefined) { fields.push("smc_name = ?"); params.push(body.smc_name); }
  if (body.doctor_degree !== undefined) { fields.push("doctor_degree = ?"); params.push(body.doctor_degree); }
  if (body.phone !== undefined) { fields.push("phone = ?"); params.push(body.phone); }
  if (body.bio !== undefined) { fields.push("bio = ?"); params.push(body.bio); }
  if (fields.length > 0) {
    await pool.query(`UPDATE doctors SET ${fields.join(", ")} WHERE id = ?`, [...params, auth.doctorId]);
  }

  const [updated] = await pool.query<Row[]>(
    `SELECT id, name, reg_no, smc_name, doctor_degree, phone, certificate_url, photo_url, bio
       FROM doctors WHERE id = ? AND deleted_at IS NULL`,
    [auth.doctorId],
  );
  const doc = updated[0];
  const specializationsByDoctor = await getDoctorSpecializations(pool, [String(doc.id)]);
  return json({
    id: doc.id,
    name: doc.name,
    specializations: specializationsByDoctor.get(String(doc.id)) ?? [],
    reg_no: doc.reg_no,
    smc_name: doc.smc_name,
    doctor_degree: doc.doctor_degree,
    phone: doc.phone,
    certificate_url: doc.certificate_url,
    photo_url: doc.photo_url,
    bio: doc.bio,
  });
});
