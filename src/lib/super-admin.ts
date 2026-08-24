import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "@/lib/db";
import { forbidden } from "@/lib/errors";
import { requireRoles, type AuthContext } from "@/lib/auth";
import { newId } from "@/lib/ids";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

/**
 * A platform Super Admin is a user with role 'sys_admin' AND an active row in
 * super_admins. Both must hold — the JWT role alone is not sufficient.
 */
export async function requireSuperAdmin(auth: AuthContext | null): Promise<AuthContext> {
  const a = requireRoles(auth, ["sys_admin"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT 1 AS ok FROM super_admins WHERE user_id = ? AND revoked_at IS NULL`,
    [a.userId],
  );
  if (rows.length === 0) {
    throw forbidden("NOT_SUPER_ADMIN", "Super Admin privileges are required for this operation.");
  }
  return a;
}

/** Audit trail for privileged actions — stored in the shared audit_logs table. */
export async function logSuperAdminAction(
  db: Db,
  opts: {
    actorUserId: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    changes?: Record<string, unknown> | null;
    ipAddress?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, changes_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      opts.actorUserId,
      opts.action,
      opts.resourceType,
      opts.resourceId ?? null,
      opts.changes ? JSON.stringify(opts.changes) : null,
      opts.ipAddress ?? null,
    ],
  );
}
