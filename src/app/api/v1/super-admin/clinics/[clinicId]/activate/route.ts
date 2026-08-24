import { api, json, clientIp } from "@/lib/http";
import { pool, withTransaction } from "@/lib/db";
import { requireSuperAdmin, logSuperAdminAction } from "@/lib/super-admin";
import { notFound } from "@/lib/errors";
import {
  activateClinicManually,
  computeLiveState,
  serializeSubscription,
  getPlatformSettings,
} from "@/lib/subscriptions";

/** Manually re-enables a clinic that was deactivated by the platform. */
export const POST = api({ rateLimit: 60 }, async (ctx) => {
  const admin = await requireSuperAdmin(ctx.auth);
  const { clinicId } = ctx.params;

  const [exists] = await pool.query(`SELECT id FROM clinics WHERE id = ? AND deleted_at IS NULL`, [clinicId]);
  if (!Array.isArray(exists) || exists.length === 0) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");

  const sub = await withTransaction(async (conn) => {
    const row = await activateClinicManually(conn, clinicId, admin.userId);
    await logSuperAdminAction(conn, {
      actorUserId: admin.userId,
      action: "clinic.activated",
      resourceType: "clinic",
      resourceId: clinicId,
      changes: { new_status: String(row.status) },
      ipAddress: clientIp(ctx.request),
    });
    return row;
  });

  const settings = await getPlatformSettings(pool);
  return json({
    message: "Clinic activated.",
    subscription: serializeSubscription(sub, computeLiveState(sub, settings.expiring_warning_days)),
  });
});
