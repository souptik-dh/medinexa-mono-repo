import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { saveUpload, signFileUrl } from "@/lib/upload";

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 10 * 1024 * 1024;

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["doctor"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM doctors WHERE id = ? AND deleted_at IS NULL`,
    [auth.doctorId],
  );
  if (!rows[0]) throw notFound("DOCTOR_NOT_FOUND", "Doctor profile not found.");

  const form = await ctx.request.formData();
  const file = form.get("file");
  const saved = await saveUpload(file, "doctor-photo", MAX_BYTES, IMAGE_MIMES);
  const photoUrl = signFileUrl(saved.fileName);

  await pool.query(`UPDATE doctors SET photo_url = ? WHERE id = ?`, [photoUrl, auth.doctorId]);
  return json({ photo_url: photoUrl });
});
