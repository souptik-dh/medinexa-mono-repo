import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { notFound } from "@/lib/errors";
import { parseBody } from "@/lib/validators";
import { assertPublicId, cloudinaryImageUrl, getCloudinary } from "@/lib/cloudinary";
import { newId } from "@/lib/ids";

const createSchema = z.object({
  public_id: z.string().trim().min(1).max(255),
});

function serializeImage(r: Row) {
  return {
    id: r.id,
    branch_id: r.branch_id,
    image_url: r.image_url,
    position: Number(r.position),
    created_at: r.created_at,
  };
}

export const GET = api(undefined, async (ctx) => {
  const { id: branchId } = ctx.params;
  const [branches] = await pool.query<Row[]>(
    `SELECT id FROM branches WHERE id = ? AND deleted_at IS NULL`,
    [branchId],
  );
  if (!branches[0]) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");

  const [rows] = await pool.query<Row[]>(
    `SELECT id, branch_id, image_url, position, created_at
       FROM branch_gallery_images
      WHERE branch_id = ?
      ORDER BY position ASC, created_at ASC`,
    [branchId],
  );
  return json({ items: rows.map(serializeImage) });
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const { id: branchId } = ctx.params;
  await getOwnedBranch(pool, branchId, auth.userId);

  const body = parseBody(createSchema, await readJson(ctx.request));
  const publicId = assertPublicId(body.public_id, "branches/gallery");
  const imageUrl = cloudinaryImageUrl(getCloudinary().cloudName, publicId);

  const [posRows] = await pool.query<Row[]>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next_position
       FROM branch_gallery_images WHERE branch_id = ?`,
    [branchId],
  );
  const nextPosition = Number(posRows[0].next_position);
  const id = newId();
  await pool.query(
    `INSERT INTO branch_gallery_images (id, branch_id, public_id, image_url, position)
     VALUES (?, ?, ?, ?, ?)`,
    [id, branchId, publicId, imageUrl, nextPosition],
  );

  return json(
    {
      id,
      branch_id: branchId,
      image_url: imageUrl,
      position: nextPosition,
      created_at: new Date().toISOString(),
    },
    201,
  );
});
