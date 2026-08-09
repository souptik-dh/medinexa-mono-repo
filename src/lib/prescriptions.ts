import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { forbidden } from "@/lib/errors";
import type { AuthContext } from "@/lib/auth";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export async function requireAssignedDoctor(
  db: Db,
  appointmentId: string,
  auth: AuthContext,
): Promise<Row> {
  const [rows] = await db.query<Row[]>(
    `SELECT * FROM appointments WHERE id = ? AND doctor_id = ?`,
    [appointmentId, auth.doctorId],
  );
  const row = rows[0];
  if (!row) {
    throw forbidden(
      "NOT_ASSIGNED_DOCTOR",
      "You are not the doctor assigned to this appointment.",
    );
  }
  return row;
}

export function serializePrescription(r: Row, redactText: boolean) {
  return {
    id: r.id,
    appointment_id: r.appointment_id,
    doctor_id: r.doctor_id,
    scan_url: r.scan_url,
    digitized_text: redactText ? null : r.digitized_text,
    ocr_confidence: r.ocr_confidence != null ? Number(r.ocr_confidence) : null,
    finalized_at: r.finalized_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
