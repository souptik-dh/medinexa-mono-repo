import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { newId } from "@/lib/ids";
import { notFound, isUniqueViolation } from "@/lib/errors";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export type ReceiptSourceType = "appointment" | "lab_test_appointment";
export type ReceiptEventType = "booking_confirmed" | "payment_received" | "completed";

export function generateReceiptNumber(): string {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RCT${datePart}${rand}`;
}

export interface IssueReceiptOptions {
  sourceType: ReceiptSourceType;
  sourceId: string;
  eventType: ReceiptEventType;
  patientId: string;
  clinicId: string;
  branchId: string;
  amount?: number | null;
  currency: string;
  paymentMethod?: string | null;
  referenceNo?: string | null;
  generatedBy?: string | null;
  details: Record<string, unknown>;
}

// Called from inside the same transaction as the status transition it
// documents, so the (source_type, source_id, event_type) unique key should
// never actually collide — the status guard already prevents the event from
// firing twice. Swallowing the duplicate here is just defense in depth.
export async function issueReceipt(
  db: Db,
  opts: IssueReceiptOptions,
): Promise<{ id: string; receiptNumber: string } | null> {
  const id = newId();
  const receiptNumber = generateReceiptNumber();
  try {
    await db.query(
      `INSERT INTO receipts
         (id, receipt_number, source_type, source_id, event_type, patient_id, clinic_id, branch_id,
          amount, currency, payment_method, reference_no, generated_by, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        receiptNumber,
        opts.sourceType,
        opts.sourceId,
        opts.eventType,
        opts.patientId,
        opts.clinicId,
        opts.branchId,
        opts.amount ?? null,
        opts.currency,
        opts.paymentMethod ?? null,
        opts.referenceNo ?? null,
        opts.generatedBy ?? null,
        JSON.stringify(opts.details),
      ],
    );
    return { id, receiptNumber };
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export function serializeReceipt(r: Row) {
  return {
    id: r.id,
    receipt_number: r.receipt_number,
    source_type: r.source_type,
    source_id: r.source_id,
    event_type: r.event_type,
    patient_id: r.patient_id,
    clinic_id: r.clinic_id,
    branch_id: r.branch_id,
    amount: r.amount !== null && r.amount !== undefined ? Number(r.amount) : null,
    currency: r.currency,
    payment_method: r.payment_method ?? null,
    reference_no: r.reference_no ?? null,
    details: typeof r.details_json === "string" ? JSON.parse(r.details_json) : r.details_json,
    created_at: r.created_at,
  };
}

export async function getReceiptsForSource(
  db: Db,
  sourceType: ReceiptSourceType,
  sourceId: string,
): Promise<Row[]> {
  const [rows] = await db.query<Row[]>(
    `SELECT * FROM receipts WHERE source_type = ? AND source_id = ? ORDER BY created_at ASC`,
    [sourceType, sourceId],
  );
  return rows;
}

export async function getReceiptForPdf(
  db: Db,
  sourceType: ReceiptSourceType,
  sourceId: string,
  receiptId: string,
): Promise<Row> {
  const [rows] = await db.query<Row[]>(
    `SELECT * FROM receipts WHERE id = ? AND source_type = ? AND source_id = ?`,
    [receiptId, sourceType, sourceId],
  );
  const row = rows[0];
  if (!row) throw notFound("RECEIPT_NOT_FOUND", "Receipt not found.");
  return row;
}
