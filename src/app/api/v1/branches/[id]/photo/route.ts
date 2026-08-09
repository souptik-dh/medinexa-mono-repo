import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { saveUpload, signFileUrl } from "@/lib/upload";

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 10 * 1024 * 1024;

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  await getOwnedBranch(pool, ctx.params.id, auth.userId);

  const form = await ctx.request.formData();
  const file = form.get("file");
  const saved = await saveUpload(file, "branch-photo", MAX_BYTES, IMAGE_MIMES);
  const photoUrl = signFileUrl(saved.fileName);

  await pool.query(`UPDATE branches SET photo_url = ? WHERE id = ?`, [photoUrl, ctx.params.id]);
  return json({ photo_url: photoUrl });
});
