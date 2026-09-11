import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { forbidden, notFound } from "@/lib/errors";
import type { AuthContext } from "@/lib/auth";
import { getOwnedBranch, getOwnedClinic } from "@/lib/scope";
import { assertBranchStaffPermission, type BranchStaffPermission } from "@/lib/permissions";
import { signFileUrl } from "@/lib/upload";
import { newId } from "@/lib/ids";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export const DOCUMENT_TYPES = ["LAB_REPORT", "PRESCRIPTION", "OTHER"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DELIVERY_METHODS = ["APP", "EMAIL", "PRINT"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const DELIVERY_STATUSES = ["PENDING", "DELIVERED", "NOT_DELIVERED"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DOCUMENT_MIMES = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Joined SELECT used everywhere a document is returned with display-friendly names. */
export const DOCUMENT_SELECT_JOIN = `
  SELECT pd.*, c.name AS clinic_name, b.name AS branch_name,
         p.name AS patient_name, u.name AS uploaded_by_name
    FROM patient_documents pd
    JOIN clinics c ON c.id = pd.clinic_id
    JOIN branches b ON b.id = pd.branch_id
    JOIN users p ON p.id = pd.patient_id
    JOIN users u ON u.id = pd.uploaded_by
`;

/**
 * Resolves and validates the (clinic_id, branch_id) a new document should be attributed
 * to — never trusts a client-supplied value directly. `branch_staff` is always pinned to
 * their own assigned branch (any `requestedBranchId` from the client is ignored). A
 * `clinic_owner` may issue documents at any branch they own, but the requested branch is
 * verified via `getOwnedBranch` (throws if not actually theirs) rather than trusted as-is.
 */
export async function resolveDocumentBranch(
  db: Db,
  auth: AuthContext,
  requestedBranchId: string | null,
): Promise<{ branchId: string; clinicId: string }> {
  if (auth.role === "branch_staff") {
    if (!auth.branchId) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
    const [rows] = await db.query<Row[]>(
      `SELECT clinic_id FROM branches WHERE id = ? AND deleted_at IS NULL`,
      [auth.branchId],
    );
    if (!rows[0]) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
    return { branchId: auth.branchId, clinicId: rows[0].clinic_id };
  }
  if (!requestedBranchId) {
    throw notFound("BRANCH_NOT_FOUND", "branch_id is required.");
  }
  const branch = await getOwnedBranch(db, requestedBranchId, auth.userId);
  return { branchId: branch.id, clinicId: branch.clinic_id };
}

/** Confirms the target user is an active patient account — never assumed from the client. */
export async function assertPatientExists(db: Db, patientId: string): Promise<void> {
  const [rows] = await db.query<Row[]>(
    `SELECT id FROM users WHERE id = ? AND role = 'patient' AND status = 'active'`,
    [patientId],
  );
  if (!rows[0]) throw notFound("PATIENT_NOT_FOUND", "Patient not found.");
}

/**
 * Loads a document for a clinic_owner/branch_staff caller, scoped to their own
 * clinic/branch — a document belonging to a different clinic 404s exactly like an
 * unrelated resource would, rather than revealing it exists via a 403.
 */
export async function getClinicVisibleDocument(
  db: Db,
  documentId: string,
  auth: AuthContext,
): Promise<Row> {
  const [rows] = await db.query<Row[]>(
    `${DOCUMENT_SELECT_JOIN} WHERE pd.id = ? AND pd.deleted_at IS NULL`,
    [documentId],
  );
  const doc = rows[0];
  if (!doc) throw notFound("PATIENT_DOCUMENT_NOT_FOUND", "Document not found.");
  if (auth.role === "clinic_owner") {
    await getOwnedClinic(db, doc.clinic_id, auth.userId, { skipSubscriptionGate: true });
  } else if (auth.role === "branch_staff") {
    if (auth.branchId !== doc.branch_id) {
      throw notFound("PATIENT_DOCUMENT_NOT_FOUND", "Document not found.");
    }
  } else if (auth.role !== "sys_admin") {
    throw forbidden("PERMISSION_DENIED", "You do not have permission to access this document.");
  }
  return doc;
}

/** Loads a document for the owning patient only — 404s for anyone else's document. */
export async function getOwnDocument(db: Db, documentId: string, patientId: string): Promise<Row> {
  const [rows] = await db.query<Row[]>(
    `${DOCUMENT_SELECT_JOIN} WHERE pd.id = ? AND pd.patient_id = ? AND pd.deleted_at IS NULL`,
    [documentId, patientId],
  );
  const doc = rows[0];
  if (!doc) throw notFound("PATIENT_DOCUMENT_NOT_FOUND", "Document not found.");
  return doc;
}

/** Gate for a clinic-side mutating action: owner always allowed, staff needs the permission on the document's branch. */
export async function assertDocumentActionPermission(
  db: Db,
  auth: AuthContext,
  doc: Row,
  permission: BranchStaffPermission,
): Promise<void> {
  if (auth.role === "sys_admin" || auth.role === "clinic_owner") return;
  await assertBranchStaffPermission(db, auth, doc.branch_id, permission);
}

export function serializeDocument(r: Row): Record<string, unknown> {
  return {
    id: r.id,
    patient_id: r.patient_id,
    clinic_id: r.clinic_id,
    branch_id: r.branch_id,
    clinic_name: r.clinic_name ?? undefined,
    branch_name: r.branch_name ?? undefined,
    patient_name: r.patient_name ?? undefined,
    uploaded_by_name: r.uploaded_by_name ?? undefined,
    document_type: r.document_type,
    title: r.title,
    description: r.description ?? null,
    file_name: r.file_name,
    file_size: Number(r.file_size),
    mime_type: r.mime_type,
    file_url: signFileUrl(r.file_key),
    uploaded_by: r.uploaded_by,
    uploaded_at: r.uploaded_at,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function serializeDelivery(r: Row): Record<string, unknown> {
  return {
    id: r.id,
    document_id: r.document_id,
    delivery_method: r.delivery_method,
    status: r.status,
    recipient_email: r.recipient_email ?? null,
    delivered_at: r.delivered_at ?? null,
    attempted_by: r.attempted_by ?? null,
    attempted_by_name: r.attempted_by_name ?? undefined,
    attempted_at: r.attempted_at,
    error_message: r.error_message ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** The latest row per channel — this is what a compact "combined delivery state" UI reads. */
export function latestByChannel(deliveries: Row[]): Record<DeliveryMethod, Row | null> {
  const out: Record<DeliveryMethod, Row | null> = { APP: null, EMAIL: null, PRINT: null };
  for (const d of deliveries) {
    const method = d.delivery_method as DeliveryMethod;
    const current = out[method];
    if (!current || new Date(d.created_at).getTime() > new Date(current.created_at).getTime()) {
      out[method] = d;
    }
  }
  return out;
}

export async function recordDelivery(
  db: Db,
  params: {
    documentId: string;
    method: DeliveryMethod;
    status: DeliveryStatus;
    recipientEmail?: string | null;
    deliveredAt?: Date | null;
    attemptedBy?: string | null;
    errorMessage?: string | null;
  },
): Promise<string> {
  const id = newId();
  await db.query(
    `INSERT INTO patient_document_deliveries
       (id, document_id, delivery_method, status, recipient_email, delivered_at, attempted_by, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.documentId,
      params.method,
      params.status,
      params.recipientEmail ?? null,
      params.deliveredAt ?? null,
      params.attemptedBy ?? null,
      params.errorMessage ?? null,
    ],
  );
  return id;
}

export async function auditPatientDocumentAction(
  db: Pick<PoolConnection, "query"> | Pool,
  actorUserId: string,
  action: string,
  resourceId: string,
  changes: Record<string, unknown> | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, changes_json)
     VALUES (?, ?, ?, 'patient_document', ?, ?)`,
    [newId(), actorUserId, action, resourceId, changes ? JSON.stringify(changes) : null],
  );
}
