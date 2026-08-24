import { z } from "zod";
import { api, json, readJson, clientIp } from "@/lib/http";
import { pool, withTransaction } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireSuperAdmin, logSuperAdminAction } from "@/lib/super-admin";
import { notFound } from "@/lib/errors";
import {
  deactivateClinicManually,
  computeLiveState,
  serializeSubscription,
  getPlatformSettings,
} from "@/lib/subscriptions";

const schema = z.object({
  reason: z.string().trim().min(3, "A deactivation reason is required.").max(500),
});

/** Suspends clinic operations. Data is never deleted; reversible via activate. */
export const POST = api({ rateLimit: 60 }, async (ctx) => {
  const admin = await requireSuperAdmin(ctx.auth);
  const { clinicId } = ctx.params;
  const body = parseBody(schema, await readJson(ctx.request));

  const [exists] = await pool.query(`SELECT id FROM clinics WHERE id = ? AND deleted_at IS NULL`, [clinicId]);
  if (!Array.isArray(exists) || exists.length === 0) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");

  const sub = await withTransaction(async (conn) => {
    const row = await deactivateClinicManually(conn, clinicId, body.reason, admin.userId);
    await logSuperAdminAction(conn, {
      actorUserId: admin.userId,
      action: "clinic.deactivated",
      resourceType: "clinic",
      resourceId: clinicId,
      changes: { reason: body.reason },
      ipAddress: clientIp(ctx.request),
    });
    return row;
  });

  const settings = await getPlatformSettings(pool);
  return json({
    message: "Clinic deactivated. Clinic and patient data are preserved.",
    subscription: serializeSubscription(sub, computeLiveState(sub, settings.expiring_warning_days)),
  });
});
