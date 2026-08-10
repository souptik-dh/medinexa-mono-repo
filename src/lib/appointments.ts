import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { conflict, notFound } from "@/lib/errors";
import { newId } from "@/lib/ids";
import type { AuthContext } from "@/lib/auth";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export const APPT_STATUSES = [
  "pending",
  "confirmed",
  "paid",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type ApptStatus = (typeof APPT_STATUSES)[number];

export const NON_TERMINAL = ["pending", "confirmed", "paid"];

export function serializeAppointment(r: Row) {
  const base = {
    id: r.id,
    patient_id: r.patient_id,
    clinic_id: r.clinic_id,
    branch_id: r.branch_id,
    doctor_id: r.doctor_id,
    scheduled_date: r.scheduled_date,
    scheduled_time: r.scheduled_time,
    duration_minutes: Number(r.duration_minutes),
    status: r.status,
    fee_amount: Number(r.fee_amount),
    currency: r.currency,
    payment_method: r.payment_method,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  if (r.doctor_name === undefined && r.branch_name === undefined) return base;
  return {
    ...base,
    doctor_name: r.doctor_name ?? null,
    branch_name: r.branch_name ?? null,
    ...(r.patient_name !== undefined
      ? {
          patient: {
            id: r.patient_id,
            name: r.patient_name ?? null,
            email: r.patient_email ?? null,
            phone: r.patient_phone ?? null,
            address: r.patient_address ?? null,
            photo_url: r.patient_photo_url ?? null,
          },
        }
      : {}),
  };
}

export function scopeWhere(auth: AuthContext): { where: string; params: unknown[] } {
  switch (auth.role) {
    case "patient":
      return { where: "a.patient_id = ?", params: [auth.userId] };
    case "branch_staff":
      return { where: "a.branch_id = ?", params: [auth.branchId ?? "__none__"] };
    case "doctor":
      return { where: "a.doctor_id = ?", params: [auth.doctorId ?? "__none__"] };
    case "clinic_owner":
      return {
        where: "a.clinic_id IN (SELECT id FROM clinics WHERE owner_user_id = ?)",
        params: [auth.userId],
      };
    default:
      return { where: "1 = 1", params: [] };
  }
}

export async function getAppointmentInScope(
  db: Db,
  id: string,
  auth: AuthContext,
): Promise<Row> {
  const { where, params } = scopeWhere(auth);
  const [rows] = await db.query<Row[]>(
    `SELECT a.* FROM appointments a WHERE a.id = ? AND ${where} FOR UPDATE`,
    [id, ...params],
  );
  const row = rows[0];
  if (!row) throw notFound("APPOINTMENT_NOT_FOUND", "Appointment not found.");
  return row;
}

export async function writeStatusLog(
  conn: PoolConnection,
  appointmentId: string,
  from: string | null,
  to: string,
  changedBy: string,
  note: string | null,
): Promise<void> {
  await conn.query(
    `INSERT INTO appointment_status_log (id, appointment_id, from_status, to_status, changed_by, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), appointmentId, from, to, changedBy, note ?? null],
  );
}

export async function transition(
  conn: PoolConnection,
  appointment: Row,
  toStatus: ApptStatus,
  changedBy: string,
  allowedFrom: string[],
  note: string | null = null,
): Promise<void> {
  if (!allowedFrom.includes(appointment.status)) {
    throw conflict(
      "INVALID_STATUS_TRANSITION",
      `Cannot transition appointment from '${appointment.status}' to '${toStatus}'.`,
    );
  }
  await conn.query(`UPDATE appointments SET status = ? WHERE id = ?`, [toStatus, appointment.id]);
  await writeStatusLog(conn, appointment.id, appointment.status, toStatus, changedBy, note);
}
