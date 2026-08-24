import { z } from "zod";
import { api, json, readJson, clientIp } from "@/lib/http";
import { pool, withTransaction } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireSuperAdmin, logSuperAdminAction } from "@/lib/super-admin";
import { notFound } from "@/lib/errors";
import {
  extendSubscription,
  computeLiveState,
  serializeSubscription,
  getPlatformSettings,
} from "@/lib/subscriptions";

const schema = z
  .object({
    months: z.coerce.number().int().min(1).max(36).optional(),
    trial_days: z.coerce.number().int().min(1).max(365).optional(),
    reason: z.string().trim().min(3, "A reason is required for audit purposes.").max(500),
  })
  .refine((v) => v.months != null || v.trial_days != null, {
    message: "Provide months or trial_days.",
    path: ["months"],
  });

/**
 * Explicitly modifies an existing subscription — extends the paid period by months
 * or grants/extends a free-trial window. This is the authorized way to change an
 * existing subscription (price changes alone never touch running subscriptions).
 */
export const POST = api({ rateLimit: 60 }, async (ctx) => {
  const admin = await requireSuperAdmin(ctx.auth);
  const { clinicId } = ctx.params;
  const body = parseBody(schema, await readJson(ctx.request));

  const [exists] = await pool.query(`SELECT id FROM clinics WHERE id = ? AND deleted_at IS NULL`, [clinicId]);
  if (!Array.isArray(exists) || exists.length === 0) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");

  const sub = await withTransaction(async (conn) => {
    const row = await extendSubscription(
      conn,
      clinicId,
      { months: body.months, trialDays: body.trial_days, reason: body.reason },
      admin.userId,
    );
    await logSuperAdminAction(conn, {
      actorUserId: admin.userId,
      action: body.months ? "subscription.extended_months" : "subscription.extended_trial",
      resourceType: "clinic_subscription",
      resourceId: clinicId,
      changes: { months: body.months ?? null, trial_days: body.trial_days ?? null, reason: body.reason },
      ipAddress: clientIp(ctx.request),
    });
    return row;
  });

  const settings = await getPlatformSettings(pool);
  return json({
    message: "Subscription updated.",
    subscription: serializeSubscription(sub, computeLiveState(sub, settings.expiring_warning_days)),
  });
});
