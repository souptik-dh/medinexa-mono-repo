import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { saveUpload, signFileUrl } from "@/lib/upload";
import { newId } from "@/lib/ids";

const DOC_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_BYTES = 20 * 1024 * 1024;

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const form = await ctx.request.formData();
  const saved = await saveUpload(form.get("file"), "medical-doc", MAX_BYTES, DOC_MIMES);

  const id = newId();
  const fileUrl = signFileUrl(saved.fileName);
  const fileName = form.get("file") instanceof File ? (form.get("file") as File).name : saved.fileName;

  await pool.query(
    `INSERT INTO medical_documents (id, patient_id, file_url, file_name, mime_type, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, auth.userId, fileUrl, fileName, saved.mime, saved.size],
  );

  return json(
    {
      id,
      patient_id: auth.userId,
      file_url: fileUrl,
      file_name: fileName,
      mime_type: saved.mime,
      size_bytes: saved.size,
      uploaded_at: new Date().toISOString(),
    },
    201,
  );
});

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id, patient_id, file_url, file_name, mime_type, size_bytes, uploaded_at
       FROM medical_documents WHERE patient_id = ? ORDER BY uploaded_at DESC`,
    [auth.userId],
  );
  return json({
    items: rows.map((r) => ({
      id: r.id,
      patient_id: r.patient_id,
      file_url: r.file_url,
      file_name: r.file_name,
      mime_type: r.mime_type,
      size_bytes: Number(r.size_bytes),
      uploaded_at: r.uploaded_at,
    })),
  });
});
