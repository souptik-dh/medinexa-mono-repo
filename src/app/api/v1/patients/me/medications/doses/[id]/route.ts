import { api, noContent } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";

export const DELETE = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM medication_doses WHERE id = ? AND patient_id = ?`,
    [ctx.params.id, auth.userId],
  );
  if (!rows[0]) throw notFound("DOSE_NOT_FOUND", "Dose log not found.");
  await pool.query(`DELETE FROM medication_doses WHERE id = ?`, [ctx.params.id]);
  return noContent();
});
