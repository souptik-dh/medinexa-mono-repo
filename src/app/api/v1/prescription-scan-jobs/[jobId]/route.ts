import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["doctor"]);

  const [rows] = await pool.query<Row[]>(
    `SELECT id, status, draft_text, confidence FROM prescription_scan_jobs
      WHERE id = ? AND doctor_id = ?`,
    [ctx.params.jobId, auth.doctorId],
  );
  const job = rows[0];
  if (!job) throw notFound("JOB_NOT_FOUND", "OCR job not found.");

  return json({
    status: job.status,
    draft_text: job.draft_text ?? null,
    confidence: job.confidence != null ? Number(job.confidence) : null,
  });
});
