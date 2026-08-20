import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { parseBody } from "@/lib/validators";
import { assertPublicId, cloudinaryImageUrl, getCloudinary } from "@/lib/cloudinary";

const schema = z.object({
  public_id: z.string().trim().min(1).max(255),
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["doctor"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM doctors WHERE id = ? AND deleted_at IS NULL`,
    [auth.doctorId],
  );
  if (!rows[0]) throw notFound("DOCTOR_NOT_FOUND", "Doctor profile not found.");

  const body = parseBody(schema, await readJson(ctx.request));
  const publicId = assertPublicId(body.public_id, "doctors");
  const photoUrl = cloudinaryImageUrl(getCloudinary().cloudName, publicId);

  await pool.query(`UPDATE doctors SET photo_url = ? WHERE id = ?`, [photoUrl, auth.doctorId]);
  return json({ photo_url: photoUrl });
});
