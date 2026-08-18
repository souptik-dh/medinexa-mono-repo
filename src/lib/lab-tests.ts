import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { conflict, notFound } from "@/lib/errors";
import { newId } from "@/lib/ids";
import type { AuthContext } from "@/lib/auth";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export const LAB_TEST_CATEGORIES = [
  "blood_test",
  "cardiology",
  "diabetes",
  "urine_test",
  "imaging",
  "general_diagnostics",
  "health_check",
  "other",
] as const;
export type LabTestCategory = (typeof LAB_TEST_CATEGORIES)[number];

export const LAB_TEST_STATUSES = ["active", "inactive"] as const;
export type LabTestStatus = (typeof LAB_TEST_STATUSES)[number];

export const LAB_APT_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "COMPLETED"] as const;
export type LabAptStatus = (typeof LAB_APT_STATUSES)[number];

export const LAB_APT_TRANSITIONS: Record<LabAptStatus, readonly LabAptStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["COMPLETED", "CANCELLED"],
  REJECTED: [],
  CANCELLED: [],
  COMPLETED: [],
};

export const PAYMENT_STATUSES = ["UNPAID", "PENDING", "PAID", "FAILED", "REFUNDED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SERVICE_MODES = ["CLINIC", "HOME"] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export function serializeLabTest(r: Row) {
  return {
    id: r.id,
    clinic_id: r.clinic_id,
    name: r.name,
    code: r.code,
    description: r.description ?? null,
    category: r.category,
    instructions: r.instructions ?? null,
    default_precautions: r.default_precautions ? JSON.parse(r.default_precautions) : [],
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function serializeBranchLabTest(r: Row) {
  return {
    id: r.id,
    clinic_id: r.clinic_id,
    branch_id: r.branch_id,
    test_id: r.test_id,
    test_name: r.test_name ?? null,
    test_code: r.test_code ?? null,
    test_category: r.test_category ?? null,
    test_description: r.test_description ?? null,
    price: Number(r.price),
    currency: r.currency,
    duration_minutes: Number(r.duration_minutes),
    clinic_available: Boolean(r.clinic_available),
    home_collection_available: Boolean(r.home_collection_available),
    prescription_required: Boolean(r.prescription_required),
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function serializeLabTestAppointment(r: Row) {
  const base: Record<string, unknown> = {
    id: r.id,
    appointment_number: r.appointment_number,
    patient_id: r.patient_id,
    clinic_id: r.clinic_id,
    branch_id: r.branch_id,
    branch_lab_test_id: r.branch_lab_test_id,
    test_id: r.test_id,
    service_mode: r.service_mode,
    appointment_date: r.appointment_date,
    start_time: r.start_time,
    end_time: r.end_time,
    duration_minutes: Number(r.duration_minutes),
    price: Number(r.price),
    currency: r.currency,
    payment_method: r.payment_method ?? null,
    payment_status: r.payment_status,
    prescription_required: Boolean(r.prescription_required),
    prescription_id: r.prescription_id ?? null,
    patient_notes: r.patient_notes ?? null,
    clinic_notes: r.clinic_notes ?? null,
    precautions: r.precautions ? (typeof r.precautions === "string" ? JSON.parse(r.precautions) : r.precautions) : null,
    status: r.status,
    approved_by: r.approved_by ?? null,
    approved_at: r.approved_at ?? null,
    rejected_by: r.rejected_by ?? null,
    rejected_at: r.rejected_at ?? null,
    rejection_reason: r.rejection_reason ?? null,
    completed_at: r.completed_at ?? null,
    cancelled_at: r.cancelled_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };

  if (r.service_mode === "HOME") {
    base.home_address = r.home_address ?? null;
    base.home_lat = r.home_lat !== null && r.home_lat !== undefined ? Number(r.home_lat) : null;
    base.home_lng = r.home_lng !== null && r.home_lng !== undefined ? Number(r.home_lng) : null;
    base.home_contact_phone = r.home_contact_phone ?? null;
    base.home_notes = r.home_notes ?? null;
  }

  if (r.test_name !== undefined) {
    base.test = {
      id: r.test_id,
      name: r.test_name,
      code: r.test_code ?? null,
      category: r.test_category ?? null,
      description: r.test_description ?? null,
    };
  }

  if (r.branch_name !== undefined) {
    base.branch = {
      id: r.branch_id,
      name: r.branch_name ?? null,
    };
  }

  if (r.patient_name !== undefined) {
    base.patient = {
      id: r.patient_id,
      name: r.patient_name ?? null,
      email: r.patient_email ?? null,
      phone: r.patient_phone ?? null,
      date_of_birth: r.patient_dob ?? null,
      gender: r.patient_gender ?? null,
    };
  }

  if (r.clinic_name !== undefined) {
    base.clinic = {
      id: r.clinic_id,
      name: r.clinic_name ?? null,
    };
  }

  return base;
}

export function labTestScopeWhere(auth: AuthContext): { where: string; params: unknown[] } {
  switch (auth.role) {
    case "patient":
      return { where: "1 = 1", params: [] };
    case "branch_staff":
      return { where: "b.branch_id = ?", params: [auth.branchId ?? "__none__"] };
    case "clinic_owner":
      return {
        where: "b.clinic_id IN (SELECT id FROM clinics WHERE owner_user_id = ?)",
        params: [auth.userId],
      };
    case "sys_admin":
      return { where: "1 = 1", params: [] };
    default:
      return { where: "1 = 0", params: [] };
  }
}

export function labApptScopeWhere(auth: AuthContext): { where: string; params: unknown[] } {
  switch (auth.role) {
    case "patient":
      return { where: "a.patient_id = ?", params: [auth.userId] };
    case "branch_staff":
      return { where: "a.branch_id = ?", params: [auth.branchId ?? "__none__"] };
    case "clinic_owner":
      return {
        where: "a.clinic_id IN (SELECT id FROM clinics WHERE owner_user_id = ?)",
        params: [auth.userId],
      };
    case "sys_admin":
      return { where: "1 = 1", params: [] };
    default:
      return { where: "1 = 0", params: [] };
  }
}

export async function getLabTestInScope(
  db: Db,
  id: string,
  auth: AuthContext,
): Promise<Row> {
  const { where, params } = labTestScopeWhere(auth);
  const [rows] = await db.query<Row[]>(
    `SELECT lt.* FROM lab_tests lt
       JOIN clinics c ON c.id = lt.clinic_id
     WHERE lt.id = ? AND ${where} AND lt.deleted_at IS NULL`,
    [id, ...params],
  );
  const row = rows[0];
  if (!row) throw notFound("LAB_TEST_NOT_FOUND", "Lab test not found.");
  return row;
}

export async function getBranchLabTestInScope(
  db: Db,
  id: string,
  auth: AuthContext,
): Promise<Row> {
  const { where, params } = labTestScopeWhere(auth);
  const [rows] = await db.query<Row[]>(
    `SELECT blt.*, lt.name AS test_name, lt.code AS test_code, lt.category AS test_category,
            lt.description AS test_description, lt.default_precautions
       FROM branch_lab_tests blt
       JOIN lab_tests lt ON lt.id = blt.test_id
       JOIN branches b ON b.id = blt.branch_id
       JOIN clinics c ON c.id = blt.clinic_id
     WHERE blt.id = ? AND ${where} AND blt.status = 'active' AND lt.status = 'active'`,
    [id, ...params],
  );
  const row = rows[0];
  if (!row) throw notFound("BRANCH_TEST_NOT_FOUND", "Branch lab test not found.");
  return row;
}

// Same scope check as getBranchLabTestInScope but without the active-only
// filter, for clinic-management routes that must be able to look up (and
// therefore reactivate) a branch lab test that's currently inactive. The
// active-only variant is for patient-facing routes where an inactive test
// should behave as if it doesn't exist.
export async function getBranchLabTestForManagement(
  db: Db,
  id: string,
  auth: AuthContext,
): Promise<Row> {
  const { where, params } = labTestScopeWhere(auth);
  const [rows] = await db.query<Row[]>(
    `SELECT blt.*, lt.name AS test_name, lt.code AS test_code, lt.category AS test_category,
            lt.description AS test_description, lt.default_precautions
       FROM branch_lab_tests blt
       JOIN lab_tests lt ON lt.id = blt.test_id
       JOIN branches b ON b.id = blt.branch_id
       JOIN clinics c ON c.id = blt.clinic_id
     WHERE blt.id = ? AND ${where}`,
    [id, ...params],
  );
  const row = rows[0];
  if (!row) throw notFound("BRANCH_TEST_NOT_FOUND", "Branch lab test not found.");
  return row;
}

export async function getLabTestAppointmentInScope(
  db: Db,
  id: string,
  auth: AuthContext,
): Promise<Row> {
  const { where, params } = labApptScopeWhere(auth);
  const [rows] = await db.query<Row[]>(
    `SELECT a.*,
            lt.name AS test_name, lt.code AS test_code, lt.category AS test_category,
            lt.description AS test_description,
            b.name AS branch_name, b.phone AS branch_phone,
            c.name AS clinic_name,
            u.name AS patient_name, u.email AS patient_email, u.phone AS patient_phone,
            u.date_of_birth AS patient_dob, u.gender AS patient_gender
       FROM lab_test_appointments a
       JOIN lab_tests lt ON lt.id = a.test_id
       JOIN branches b ON b.id = a.branch_id
       JOIN clinics c ON c.id = a.clinic_id
       JOIN users u ON u.id = a.patient_id
     WHERE a.id = ? AND ${where} FOR UPDATE`,
    [id, ...params],
  );
  const row = rows[0];
  if (!row) throw notFound("APPOINTMENT_NOT_FOUND", "Lab test appointment not found.");
  return row;
}

export async function writeLabTestStatusLog(
  conn: PoolConnection,
  appointmentId: string,
  from: string | null,
  to: string,
  changedBy: string,
  note: string | null,
): Promise<void> {
  const logId = newId();
  await conn.query(
    `INSERT INTO appointment_status_log (id, appointment_id, from_status, to_status, changed_by, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [logId, appointmentId, from, to, changedBy, note ?? null],
  );
}

export async function transitionLabAppointment(
  conn: PoolConnection,
  appointment: Row,
  toStatus: LabAptStatus,
  changedBy: string,
  note: string | null = null,
): Promise<void> {
  const allowedFrom = LAB_APT_TRANSITIONS[appointment.status as LabAptStatus];
  if (!allowedFrom || !allowedFrom.includes(toStatus)) {
    throw conflict(
      "INVALID_APPOINTMENT_STATUS",
      `Cannot transition lab appointment from '${appointment.status}' to '${toStatus}'.`,
    );
  }
  await conn.query(`UPDATE lab_test_appointments SET status = ? WHERE id = ?`, [toStatus, appointment.id]);
  await writeLabTestStatusLog(conn, appointment.id, appointment.status, toStatus, changedBy, note);
}

export function generateAppointmentNumber(): string {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LAB${datePart}${rand}`;
}

export async function auditLabAction(
  db: Pick<PoolConnection, "query">,
  actorUserId: string,
  action: string,
  resourceId: string,
  changes: Record<string, unknown> | null = null,
  ipAddress: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, changes_json, ip_address)
     VALUES (?, ?, ?, 'lab_test_appointment', ?, ?, ?)`,
    [newId(), actorUserId, action, resourceId, changes ? JSON.stringify(changes) : null, ipAddress],
  );
}
