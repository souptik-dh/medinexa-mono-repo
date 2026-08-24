import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedClinic } from "@/lib/scope";
import {
  ensureClinicSubscription,
  computeLiveState,
  getPlatformSettings,
} from "@/lib/subscriptions";

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  await getOwnedClinic(pool, ctx.params.clinicId, auth.userId, { skipSubscriptionGate: true });

  const sub = await ensureClinicSubscription(pool, ctx.params.clinicId);
  const settings = await getPlatformSettings(pool);
  const live = computeLiveState(sub, settings.expiring_warning_days);

  return json({
    clinic_id: ctx.params.clinicId,
    trial: {
      is_trial: Boolean(sub.is_trial),
      status: live.status === "EXPIRING" && sub.is_trial ? "EXPIRING" : sub.is_trial ? live.status : "CONCLUDED",
      started_at: serializeDate(sub.trial_started_at),
      ends_at: serializeDate(sub.trial_ends_at),
      days_remaining: sub.is_trial ? live.daysRemaining : 0,
      expiring_soon: sub.is_trial && (live.expiringSoon || live.status === "EXPIRING"),
      expired: sub.is_trial ? live.effectiveEndMs <= Date.now() : true,
    },
    subscription_status: live.status,
    monthly_amount: Number(sub.monthly_amount),
    currency: sub.currency,
    blocked: live.blocked,
    blocked_reason: live.blockedReason,
  });
});

function serializeDate(v: unknown): string | null {
  return typeof v === "string" ? `${v.replace(" ", "T")}Z` : null;
}
