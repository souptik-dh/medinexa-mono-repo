import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { badRequest } from "@/lib/errors";
import { saveUpload, signFileUrl } from "@/lib/upload";
import { newId } from "@/lib/ids";

const DOC_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_BYTES = 20 * 1024 * 1024;
const DOC_CATEGORIES = ["prescription", "lab_report", "doctor_note", "other"] as const;
type DocCategory = (typeof DOC_CATEGORIES)[number];

function parseCategory(value: unknown): DocCategory {
  if (value === null || value === undefined || value === "") return "other";
  if (typeof value === "string" && (DOC_CATEGORIES as readonly string[]).includes(value)) {
    return value as DocCategory;
  }
  throw badRequest(
    "VALIDATION_ERROR",
    `category must be one of: ${DOC_CATEGORIES.join(", ")}.`,
    "category",
  );
}

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const form = await ctx.request.formData();
  const saved = await saveUpload(form.get("file"), "medical-doc", MAX_BYTES, DOC_MIMES);
  const category = parseCategory(form.get("category"));

  const id = newId();
  const fileUrl = signFileUrl(saved.fileName);
  const fileName = form.get("file") instanceof File ? (form.get("file") as File).name : saved.fileName;

  await pool.query(
    `INSERT INTO medical_documents (id, patient_id, category, file_url, file_name, mime_type, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, auth.userId, category, fileUrl, fileName, saved.mime, saved.size],
  );

  return json(
    {
      id,
      patient_id: auth.userId,
      category,
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
  const sp = ctx.request.nextUrl.searchParams;
  const category = sp.get("category");
  if (category && !(DOC_CATEGORIES as readonly string[]).includes(category)) {
    throw badRequest(
      "VALIDATION_ERROR",
      `category must be one of: ${DOC_CATEGORIES.join(", ")}.`,
      "category",
    );
  }

  const where = category ? "patient_id = ? AND category = ?" : "patient_id = ?";
  const params = category ? [auth.userId, category] : [auth.userId];
  const [rows] = await pool.query<Row[]>(
    `SELECT id, patient_id, category, file_url, file_name, mime_type, size_bytes, uploaded_at
       FROM medical_documents WHERE ${where} ORDER BY uploaded_at DESC`,
    params,
  );
  return json({
    items: rows.map((r) => ({
      id: r.id,
      patient_id: r.patient_id,
      category: r.category,
      file_url: r.file_url,
      file_name: r.file_name,
      mime_type: r.mime_type,
      size_bytes: Number(r.size_bytes),
      uploaded_at: r.uploaded_at,
    })),
  });
});
