import { api, json } from "@/lib/http";
import { pool, withTransaction } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedClinic } from "@/lib/scope";
import {
  ensureClinicSubscription,
  computeLiveState,
  serializeSubscription,
  getPlatformSettings,
  reactivateWithLatestPayment,
} from "@/lib/subscriptions";

/**
 * Restores clinic operations from an already-verified payment (e.g. after a manual
 * suspension or a failed activation step). If the subscription is still blocked and
 * no verified payment exists, the client is pointed at the payment flow instead.
 */
export const POST = api({ rateLimit: 20 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  await getOwnedClinic(pool, ctx.params.clinicId, auth.userId, { skipSubscriptionGate: true });

  let applied = false;
  let reason: string | null = null;
  await withTransaction(async (conn) => {
    const result = await reactivateWithLatestPayment(conn, ctx.params.clinicId);
    applied = result.applied;
    reason = result.reason;
  });

  const sub = await ensureClinicSubscription(pool, ctx.params.clinicId);
  const settings = await getPlatformSettings(pool);
  const live = computeLiveState(sub, settings.expiring_warning_days);

  return json({
    reactivated: !live.blocked,
    payment_applied: applied,
    message:
      live.blocked
        ? (reason ?? "Clinic is still inactive. Initiate and verify a subscription payment first.")
        : "Your clinic is active.",
    subscription: serializeSubscription(sub, live),
  });
});
