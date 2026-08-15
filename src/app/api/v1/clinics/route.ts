import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool } from "@/lib/db";
import { parseBody, parsePagination } from "@/lib/validators";
import { decodeCursor } from "@/lib/http";
import { fetchPage } from "@/lib/pagination";
import { requireRoles } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { unprocessable } from "@/lib/errors";

export const GET = api(undefined, async (ctx) => {
  const { limit, cursor } = parsePagination(ctx.request.nextUrl.searchParams);
  const search = ctx.request.nextUrl.searchParams.get("search")?.trim() ?? "";

  const conditions = ["c.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (search) {
    conditions.push("c.name LIKE ?");
    params.push(`%${search}%`);
  }
  if (ctx.auth?.role === "clinic_owner") {
    conditions.push("c.owner_user_id = ?");
    params.push(ctx.auth.userId);
  }
  const where = conditions.join(" AND ");

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: `SELECT c.id, c.name, c.description,
                    (SELECT COUNT(*) FROM branches b WHERE b.clinic_id = c.id AND b.deleted_at IS NULL) AS branch_count,
                    c.created_at`,
    from: "FROM clinics c",
    where,
    params,
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      branch_count: Number(r.branch_count),
      created_at: r.created_at,
    })),
    next_cursor: nextCursor,
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).optional().nullable(),
  nearby_location: z.string().trim().max(500).optional().nullable(),
  city: z.string().trim().max(255).optional().nullable(),
  district: z.string().trim().max(255).optional().nullable(),
  pin_code: z.string().trim().max(20).optional().nullable(),
  state: z.string().trim().max(255).optional().nullable(),
  post_office: z.string().trim().max(255).optional().nullable(),
  trade_license_number: z.string().trim().min(1).max(100),
  // Must be "VALID" — the client echoes back the `status` a prior
  // POST /clinics/validate-trade-license call returned for this exact number. A clinic
  // can't be created at all until that number has been validated; see the check below.
  trade_license_validation_status: z.enum(["PENDING", "VALID", "INVALID"]).optional(),
  drug_license_number: z.string().trim().max(100).optional().nullable(),
  clinical_establishment_reg_number: z.string().trim().max(100).optional().nullable(),
});

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const body = parseBody(createSchema, await readJson(ctx.request));

  // Entering a number is never itself validation (see "Trade license validation" in
  // API.md) — a clinic may not be created until POST /clinics/validate-trade-license
  // has actually returned VALID for this number.
  if (body.trade_license_validation_status !== "VALID") {
    throw unprocessable(
      "TRADE_LICENSE_NOT_VALIDATED",
      "Trade License Number must be validated before creating a clinic.",
      "trade_license_number",
    );
  }

  const validatedAt = new Date();

  const id = newId();
  await pool.query(
    `INSERT INTO clinics (
       id, name, description, nearby_location, city, district, pin_code, state, post_office,
       owner_user_id, trade_license_number, trade_license_validated, trade_license_validation_status,
       trade_license_validated_at, drug_license_number, clinical_establishment_reg_number
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.name,
      body.description ?? null,
      body.nearby_location ?? null,
      body.city ?? null,
      body.district ?? null,
      body.pin_code ?? null,
      body.state ?? null,
      body.post_office ?? null,
      auth.userId,
      body.trade_license_number,
      true,
      "VALID",
      validatedAt,
      body.drug_license_number ?? null,
      body.clinical_establishment_reg_number ?? null,
    ],
  );

  return json(
    {
      id,
      name: body.name,
      description: body.description ?? null,
      nearby_location: body.nearby_location ?? null,
      city: body.city ?? null,
      district: body.district ?? null,
      pin_code: body.pin_code ?? null,
      state: body.state ?? null,
      post_office: body.post_office ?? null,
      owner_id: auth.userId,
      trade_license_number: body.trade_license_number,
      trade_license_url: null,
      trade_license_validated: true,
      trade_license_validation_status: "VALID",
      trade_license_validated_at: validatedAt.toISOString(),
      drug_license_number: body.drug_license_number ?? null,
      drug_license_url: null,
      clinical_establishment_reg_number: body.clinical_establishment_reg_number ?? null,
      clinical_establishment_reg_url: null,
      created_at: new Date().toISOString(),
    },
    201,
  );
});
