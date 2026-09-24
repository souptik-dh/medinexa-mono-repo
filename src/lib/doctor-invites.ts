import { parseDbTimestamp, type Row } from "@/lib/db";
import { hashToken } from "@/lib/auth";
import type { Pool, PoolConnection } from "mysql2/promise";

export type InviteStatus = "pending" | "accepted" | "expired" | "revoked";

/**
 * The status a caller should see. A lapsed invite stays 'pending' in the table
 * until someone touches it, so derive 'expired' from expires_at here.
 */
export function effectiveInviteStatus(row: Row): InviteStatus {
  const status = String(row.status) as InviteStatus;
  if (status === "pending" && parseDbTimestamp(row.expires_at).getTime() < Date.now()) {
    return "expired";
  }
  return status;
}

/**
 * Finds the invite a doctor's code belongs to, in any status, so callers can tell
 * "already accepted" / "expired" / "revoked" apart from a code that never existed.
 * Invites are identified by phone; email is the fallback for phone-less invites.
 */
export async function findInviteByCode(
  db: Pool | PoolConnection,
  code: string,
  phone: string | null,
  email: string | null,
): Promise<Row | null> {
  const [rows] = await db.query<Row[]>(
    `SELECT * FROM doctor_invites
      WHERE invite_code_hash = ? AND (phone = ? OR (email = ? AND phone IS NULL))
      ORDER BY created_at DESC LIMIT 1`,
    [hashToken(code.trim().toUpperCase()), phone, email],
  );
  return rows[0] ?? null;
}
