import { pool } from "@/lib/db";
import { newId } from "@/lib/ids";

/**
 * Async OCR stub. Creates a `processing` job and marks it `done` after a short
 * delay with simulated draft text. Swap the setTimeout body for a real OCR
 * vendor call (and persist via a worker) in production.
 */
export async function createOcrJob(
  appointmentId: string,
  doctorId: string,
  scanUrl: string,
): Promise<string> {
  const id = newId();
  await pool.query(
    `INSERT INTO prescription_scan_jobs (id, appointment_id, doctor_id, scan_url, status)
     VALUES (?, ?, ?, ?, 'processing')`,
    [id, appointmentId, doctorId, scanUrl],
  );

  const draft = `[OCR DRAFT] Digitized prescription for appointment ${appointmentId}.\nGenerated ${new Date().toISOString()} — review and edit before publishing to the patient.`;
  const confidence = 94.2;

  await pool
    .query(
      `UPDATE prescription_scan_jobs
          SET status = 'done', draft_text = ?, confidence = ?, completed_at = UTC_TIMESTAMP(3)
        WHERE id = ?`,
      [draft, confidence, id],
    )
    .catch(async (err) => {
      console.error("OCR job completion failed:", err);
      await pool.query(
        `UPDATE prescription_scan_jobs SET status = 'failed' WHERE id = ?`,
        [id],
      );
    });

  return id;
}
