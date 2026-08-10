import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { forbidden, notFound } from "@/lib/errors";
import type { AuthContext } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export const BRANCH_STAFF_PERMISSIONS = [
  "appointments:confirm",
  "appointments:payment",
  "appointments:complete",
  "appointments:cancel",
  "staff:manage",
  "doctors:manage",
  "clinics:manage",
  "clinic:create",
  "clinic:delete",
  "clinic:update",
  "clinic:reports",
  "clinic:analytics",
  "branch:settings",
  "branch:reports",
  "branch:analytics",
  "branch:delete",
  "branch:create",
  "branch:update",
] as const;

export type BranchStaffPermission = (typeof BRANCH_STAFF_PERMISSIONS)[number];

export const DEFAULT_BRANCH_STAFF_PERMISSIONS: readonly BranchStaffPermission[] = [
  "appointments:confirm",
  "appointments:payment",
  "appointments:complete",
  "appointments:cancel",
];

export function isBranchStaffPermission(v: unknown): v is BranchStaffPermission {
  return (
    typeof v === "string" &&
    (BRANCH_STAFF_PERMISSIONS as readonly string[]).includes(v)
  );
}

export function parsePermissions(raw: unknown): BranchStaffPermission[] {
  if (raw == null) return [...DEFAULT_BRANCH_STAFF_PERMISSIONS];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [...DEFAULT_BRANCH_STAFF_PERMISSIONS];
    }
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_BRANCH_STAFF_PERMISSIONS];
  const perms = parsed.filter(isBranchStaffPermission);
  return [...new Set(perms)];
}

export function hasPermission(
  perms: readonly BranchStaffPermission[],
  key: BranchStaffPermission,
): boolean {
  return perms.includes(key);
}

export async function loadStaffPermissions(
  db: Db,
  branchId: string,
  userId: string,
): Promise<BranchStaffPermission[]> {
  const [rows] = await db.query<Row[]>(
    `SELECT permissions_json FROM branch_staff WHERE branch_id = ? AND user_id = ?`,
    [branchId, userId],
  );
  const row = rows[0];
  if (!row) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
  return parsePermissions(row.permissions_json);
}

/**
 * Gates an action that a `clinic_owner` may always perform but a
 * `branch_staff` may only perform when holding the given permission on the
 * branch. Ownership/scope for the owner is enforced by the caller's existing
 * query (e.g. getAppointmentInScope) — this only checks the staff permission.
 */
export async function assertBranchStaffPermission(
  db: Db,
  auth: AuthContext,
  branchId: string,
  permission: BranchStaffPermission,
): Promise<void> {
  if (auth.role === "sys_admin") return;
  if (auth.role === "clinic_owner") return;
  if (auth.role === "branch_staff") {
    if (auth.branchId !== branchId) {
      throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
    }
    const perms = await loadStaffPermissions(db, branchId, auth.userId);
    if (!hasPermission(perms, permission)) {
      throw forbidden(
        "PERMISSION_DENIED",
        "You do not have permission to perform this action.",
      );
    }
    return;
  }
  throw forbidden(
    "PERMISSION_DENIED",
    "You do not have permission to perform this action.",
  );
}

/**
 * Gates an action on a branch referenced by path param. The `clinic_owner`
 * must own the branch; a `branch_staff` must hold the given permission on it.
 */
export async function requireBranchAccess(
  db: Db,
  auth: AuthContext,
  branchId: string,
  permission: BranchStaffPermission,
): Promise<void> {
  if (auth.role === "sys_admin") return;
  if (auth.role === "clinic_owner") {
    await getOwnedBranch(db, branchId, auth.userId);
    return;
  }
  await assertBranchStaffPermission(db, auth, branchId, permission);
}
