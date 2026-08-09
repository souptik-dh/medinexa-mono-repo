import { api, noContent } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";

export const DELETE = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM medical_documents WHERE id = ? AND patient_id = ?`,
    [ctx.params.id, auth.userId],
  );
  if (!rows[0]) throw notFound("DOCUMENT_NOT_FOUND", "Document not found.");
  await pool.query(`DELETE FROM medical_documents WHERE id = ?`, [ctx.params.id]);
  return noContent();
});
