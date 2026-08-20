import { z } from "zod";
import { api, json, noContent, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { conflict } from "@/lib/errors";
import { licenseFields, tradeLicenseValidationFields } from "@/lib/licenses";

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
  post_office: z.string().trim().max(255).nullable().optional(),
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
  trade_license_number: z.string().trim().min(1).max(100).optional(),
  // Set only via a prior POST /clinics/validate-trade-license call for this same
  // number — see the reset-on-change note below.
  trade_license_validation_status: z.enum(["PENDING", "VALID", "INVALID"]).optional(),
  drug_license_number: z.string().trim().max(100).nullable().optional(),
  clinical_establishment_reg_number: z.string().trim().max(100).nullable().optional(),
});

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
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
  if (body.trade_license_number !== undefined) { fields.push("trade_license_number = ?"); params.push(body.trade_license_number); }
  if (body.drug_license_number !== undefined) { fields.push("drug_license_number = ?"); params.push(body.drug_license_number); }
  if (body.clinical_establishment_reg_number !== undefined) {
    fields.push("clinical_establishment_reg_number = ?");
    params.push(body.clinical_establishment_reg_number);
  }

  // The client always echoes its current trade_license_validation_status on every save
  // (not just right after clicking Validate), so only treat this as a genuine validation
  // event — and bump trade_license_validated_at — when the number is changing or the
  // status itself differs from what's stored; an unrelated save that just re-sends the
  // branch's already-current status leaves these columns untouched entirely. If the
  // number is changing and no fresh status came with it, force a reset to PENDING —
  // the "re-validation required" rule from the spec shouldn't rely on the client
  // remembering to do it.
  const numberChanging =
    body.trade_license_number !== undefined && body.trade_license_number !== branch.trade_license_number;
  const statusChanging =
    body.trade_license_validation_status !== undefined &&
    body.trade_license_validation_status !== branch.trade_license_validation_status;

  if (body.trade_license_validation_status !== undefined && (numberChanging || statusChanging)) {
    const validated = body.trade_license_validation_status === "VALID";
    fields.push("trade_license_validated = ?", "trade_license_validation_status = ?", "trade_license_validated_at = ?");
    params.push(validated, body.trade_license_validation_status, validated ? new Date() : null);
  } else if (body.trade_license_validation_status === undefined && numberChanging) {
    fields.push("trade_license_validated = ?", "trade_license_validation_status = ?", "trade_license_validated_at = ?");
    params.push(false, "PENDING", null);
  }

  if (fields.length > 0) {
    await pool.query(`UPDATE branches SET ${fields.join(", ")} WHERE id = ?`, [...params, branch.id]);
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM branches WHERE id = ? AND deleted_at IS NULL`,
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
    ...licenseFields(b),
    ...tradeLicenseValidationFields(b),
    created_at: b.created_at,
  });
});

export const DELETE = api({ rateLimit: 200 }, async (ctx) => {
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
