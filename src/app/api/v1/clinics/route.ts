import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool } from "@/lib/db";
import { parseBody, parsePagination } from "@/lib/validators";
import { decodeCursor } from "@/lib/http";
import { fetchPage } from "@/lib/pagination";
import { requireRoles } from "@/lib/auth";
import { newId } from "@/lib/ids";

export const GET = api(undefined, async (ctx) => {
  const { limit, cursor } = parsePagination(ctx.request.nextUrl.searchParams);
  const search = ctx.request.nextUrl.searchParams.get("search")?.trim() ?? "";

  const where = search
    ? "c.deleted_at IS NULL AND c.name LIKE ?"
    : "c.deleted_at IS NULL";
  const params: unknown[] = search ? [`%${search}%`] : [];

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
});

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const body = parseBody(createSchema, await readJson(ctx.request));

  const id = newId();
  await pool.query(
    `INSERT INTO clinics (id, name, description, nearby_location, city, district, pin_code, state, post_office, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      created_at: new Date().toISOString(),
    },
    201,
  );
});
