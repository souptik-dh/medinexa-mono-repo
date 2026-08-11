import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { parseBody } from "@/lib/validators";
import { assertPublicId, cloudinaryImageUrl, getCloudinary } from "@/lib/cloudinary";

const schema = z.object({
  public_id: z.string().trim().min(1).max(255),
});

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(schema, await readJson(ctx.request));
  const publicId = assertPublicId(body.public_id, "patients");
  const photoUrl = cloudinaryImageUrl(getCloudinary().cloudName, publicId);

  await pool.query(`UPDATE users SET photo_url = ? WHERE id = ?`, [photoUrl, auth.userId]);
  return json({ photo_url: photoUrl });
});
