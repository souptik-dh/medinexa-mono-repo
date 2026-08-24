import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { forbidden, notFound } from "@/lib/errors";
import { assertClinicOperational } from "@/lib/subscriptions";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export interface ScopeOptions {
  /**
   * Skip the clinic-subscription gate. Used by the subscription/payment endpoints
   * themselves (an inactive clinic's owner must still be able to reach them) and by
   * teardown paths such as deleting one's own clinic.
   */
  skipSubscriptionGate?: boolean;
}

export async function getOwnedClinic(
  db: Db,
  clinicId: string,
  ownerUserId: string,
  opts: ScopeOptions = {},
): Promise<Row> {
  const [rows] = await db.query<Row[]>(
    `SELECT * FROM clinics WHERE id = ? AND deleted_at IS NULL`,
    [clinicId],
  );
  const row = rows[0];
  if (!row) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");
  if (row.owner_user_id !== ownerUserId) {
    throw forbidden("NOT_CLINIC_OWNER", "You do not own this clinic.");
  }
  if (!opts.skipSubscriptionGate) {
    await assertClinicOperational(db, clinicId);
  }
  return row;
}

export async function getOwnedBranch(
  db: Db,
  branchId: string,
  ownerUserId: string,
  opts: ScopeOptions = {},
): Promise<Row> {
  const [rows] = await db.query<Row[]>(
    `SELECT b.*, c.owner_user_id
       FROM branches b
       JOIN clinics c ON c.id = b.clinic_id
      WHERE b.id = ? AND b.deleted_at IS NULL AND c.deleted_at IS NULL`,
    [branchId],
  );
  const row = rows[0];
  if (!row) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
  if (row.owner_user_id !== ownerUserId) {
    throw forbidden("NOT_CLINIC_OWNER", "You do not own the clinic for this branch.");
  }
  if (!opts.skipSubscriptionGate) {
    await assertClinicOperational(db, row.clinic_id);
  }
  return row;
}

export async function getVisibleBranch(db: Db, branchId: string, auth: {
  userId: string;
  role: string;
  branchId: string | null;
}): Promise<Row> {
  const [rows] = await db.query<Row[]>(
    `SELECT b.*, c.owner_user_id
       FROM branches b
       JOIN clinics c ON c.id = b.clinic_id
      WHERE b.id = ? AND b.deleted_at IS NULL AND c.deleted_at IS NULL`,
    [branchId],
  );
  const row = rows[0];
  if (!row) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
  if (auth.role === "clinic_owner") {
    if (row.owner_user_id !== auth.userId) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
  } else if (auth.role === "branch_staff") {
    if (row.id !== auth.branchId) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
  }
  return row;
}
