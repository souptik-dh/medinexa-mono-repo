import { z } from "zod";
import { api, json, noContent, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getOwnedClinic } from "@/lib/scope";
import { notFound, conflict } from "@/lib/errors";

export const GET = api(undefined, async (ctx) => {
  const { clinicId } = ctx.params;
  const [rows] = await pool.query<Row[]>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM branches b WHERE b.clinic_id = c.id AND b.deleted_at IS NULL) AS branch_count
       FROM clinics c WHERE c.id = ? AND c.deleted_at IS NULL`,
    [clinicId],
  );
  const clinic = rows[0];
  if (!clinic) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");
  return json({
    id: clinic.id,
    name: clinic.name,
    description: clinic.description,
    branch_count: Number(clinic.branch_count),
    created_at: clinic.created_at,
  });
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  nearby_location: z.string().trim().max(500).nullable().optional(),
  city: z.string().trim().max(255).nullable().optional(),
  district: z.string().trim().max(255).nullable().optional(),
  pin_code: z.string().trim().max(20).nullable().optional(),
  state: z.string().trim().max(255).nullable().optional(),
  post_office: z.string().trim().max(255).nullable().optional(),
});

export const PATCH = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const clinic = await getOwnedClinic(pool, ctx.params.clinicId, auth.userId);
  const body = parseBody(patchSchema, await readJson(ctx.request));

  const fields: string[] = [];
  const params: unknown[] = [];
  if (body.name !== undefined) {
    fields.push("name = ?");
    params.push(body.name);
  }
  if (body.description !== undefined) {
    fields.push("description = ?");
    params.push(body.description);
  }
  if (body.nearby_location !== undefined) { fields.push("nearby_location = ?"); params.push(body.nearby_location); }
  if (body.city !== undefined) { fields.push("city = ?"); params.push(body.city); }
  if (body.district !== undefined) { fields.push("district = ?"); params.push(body.district); }
  if (body.pin_code !== undefined) { fields.push("pin_code = ?"); params.push(body.pin_code); }
  if (body.state !== undefined) { fields.push("state = ?"); params.push(body.state); }
  if (body.post_office !== undefined) { fields.push("post_office = ?"); params.push(body.post_office); }

  if (fields.length > 0) {
    await pool.query(`UPDATE clinics SET ${fields.join(", ")} WHERE id = ?`, [...params, clinic.id]);
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM clinics WHERE id = ? AND deleted_at IS NULL`,
    [clinic.id],
  );
  const updated = rows[0];
  return json({
    id: updated.id,
    name: updated.name,
    description: updated.description,
    nearby_location: updated.nearby_location,
    city: updated.city,
    district: updated.district,
    pin_code: updated.pin_code,
    state: updated.state,
    post_office: updated.post_office,
    owner_id: updated.owner_user_id,
    created_at: updated.created_at,
  });
});

export const DELETE = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const clinic = await getOwnedClinic(pool, ctx.params.clinicId, auth.userId);
  const { searchParams } = ctx.request.nextUrl;
  const force = searchParams.get("force") === "true";

  const [active] = await pool.query<Row[]>(
    `SELECT COUNT(*) AS cnt FROM appointments a
      WHERE a.clinic_id = ? AND a.status IN ('pending','confirmed','paid')`,
    [clinic.id],
  );
  const hasActive = Number(active[0].cnt) > 0;

  if (hasActive && !force) {
    throw conflict(
      "CLINIC_HAS_ACTIVE_APPOINTMENTS",
      "This clinic has active appointments. Cancel or complete them first, or pass ?force=true to cancel them.",
    );
  }

  if (force && hasActive) {
    await pool.query(
      `UPDATE appointments SET status = 'cancelled' WHERE clinic_id = ? AND status IN ('pending','confirmed','paid')`,
      [clinic.id],
    );
  }

  await pool.query(`UPDATE clinics SET deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [clinic.id]);
  return noContent();
});
