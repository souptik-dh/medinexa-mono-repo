import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { isUniqueViolation } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { slugify } from "@/lib/specializations";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Public — the platform-level master list of doctor specializations. Drives both
// jido's home-screen category chips and the searchable specialization picker on a
// clinic's doctor-invite form.
export const GET = api({ rateLimit: 120 }, async (ctx) => {
  const q = ctx.request.nextUrl.searchParams.get("q")?.trim() || null;

  const filters: string[] = ["ds.status = 'active'"];
  const params: unknown[] = [];
  if (q) {
    filters.push("ds.name LIKE ?");
    params.push(`%${escapeLike(q)}%`);
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT ds.id, ds.name, ds.slug, ds.description,
            (SELECT COUNT(DISTINCT dsm.doctor_id)
               FROM doctor_specialization_map dsm
               JOIN doctors d ON d.id = dsm.doctor_id AND d.deleted_at IS NULL
              WHERE dsm.specialization_id = ds.id) AS doctor_count
       FROM doctor_specializations ds
      WHERE ${filters.join(" AND ")}
      ORDER BY doctor_count DESC, ds.name ASC`,
    params,
  );

  return json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      doctor_count: Number(r.doctor_count),
    })),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(500).optional().nullable(),
});

// Lets a clinic add a specialization directly from the doctor-invite form when the
// one they need isn't in the master list yet. Case-insensitive dedup via `slug`: if a
// specialization with the same slug already exists (created by this clinic or any
// other), that existing row is returned instead of creating a duplicate.
export const POST = api({ rateLimit: 200 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const body = parseBody(createSchema, await readJson(ctx.request));
  const slug = slugify(body.name);

  const [existing] = await pool.query<Row[]>(
    `SELECT id, name, slug, description, status, created_at, updated_at
       FROM doctor_specializations WHERE slug = ?`,
    [slug],
  );
  if (existing[0]) {
    return json(existing[0], 200);
  }

  const id = newId();
  try {
    await pool.query(
      `INSERT INTO doctor_specializations (id, name, slug, description, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [id, body.name, slug, body.description ?? null],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [row] = await pool.query<Row[]>(
        `SELECT id, name, slug, description, status, created_at, updated_at
           FROM doctor_specializations WHERE slug = ?`,
        [slug],
      );
      return json(row[0], 200);
    }
    throw err;
  }

  return json(
    { id, name: body.name, slug, description: body.description ?? null, status: "active" },
    201,
  );
});
