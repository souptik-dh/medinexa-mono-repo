import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { parseBody } from "@/lib/validators";
import { assertPublicId, cloudinaryImageUrl, getCloudinary } from "@/lib/cloudinary";

const schema = z.object({
  public_id: z.string().trim().min(1).max(255),
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  await getOwnedBranch(pool, ctx.params.id, auth.userId);

  const body = parseBody(schema, await readJson(ctx.request));
  const publicId = assertPublicId(body.public_id, "branches");
  const photoUrl = cloudinaryImageUrl(getCloudinary().cloudName, publicId);

  await pool.query(`UPDATE branches SET photo_url = ? WHERE id = ?`, [photoUrl, ctx.params.id]);
  return json({ photo_url: photoUrl });
});
