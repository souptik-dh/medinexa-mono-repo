import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { forbidden } from "@/lib/errors";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["doctor"]);
  const patientId = ctx.params.patientId;

  const [rel] = await pool.query<Row[]>(
    `SELECT a.id FROM appointments a
      WHERE a.patient_id = ? AND a.doctor_id = ? AND a.status != 'cancelled'
      LIMIT 1`,
    [patientId, auth.doctorId],
  );
  if (!rel[0]) {
    throw forbidden(
      "NO_APPOINTMENT_RELATIONSHIP",
      "You do not have an appointment relationship with this patient.",
    );
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT id, patient_id, file_url, file_name, mime_type, size_bytes, uploaded_at
       FROM medical_documents WHERE patient_id = ? ORDER BY uploaded_at DESC`,
    [patientId],
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
