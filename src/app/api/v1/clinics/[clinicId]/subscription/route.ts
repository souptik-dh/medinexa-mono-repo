import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedClinic } from "@/lib/scope";
import {
  ensureClinicSubscription,
  computeLiveState,
  serializeSubscription,
  getActivePlan,
  getPlatformSettings,
} from "@/lib/subscriptions";
import { getActiveOfferForClinic, renderOfferMessage } from "@/lib/offers";

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  // Reachable even while inactive — this is how the owner sees what they owe.
  const clinic = await getOwnedClinic(pool, ctx.params.clinicId, auth.userId, { skipSubscriptionGate: true });

  const sub = await ensureClinicSubscription(pool, ctx.params.clinicId);
  const settings = await getPlatformSettings(pool);
  const live = computeLiveState(sub, settings.expiring_warning_days);
  const plan = await getActivePlan(pool);
  const offer = await getActiveOfferForClinic(pool, ctx.params.clinicId);

  return json({
    subscription: serializeSubscription(sub, live),
    current_plan: {
      id: plan.id,
      name: plan.name,
      monthly_amount: plan.amount,
      currency: plan.currency,
      trial_months: plan.trial_months,
    },
    settings: {
      expiring_warning_days: settings.expiring_warning_days,
      max_months_per_payment: settings.max_months_per_payment,
    },
    active_offer: offer
      ? {
          offer_id: offer.offerId,
          title: offer.title,
          message: renderOfferMessage(offer.messageTemplate, {
            clinicName: String(clinic.name),
            regularAmount: plan.amount,
            offerAmount: offer.discountedAmount,
            currency: offer.currency,
            durationMonths: offer.durationMonths,
            validUntil: offer.validUntil,
          }),
          discounted_amount: offer.discountedAmount,
          currency: offer.currency,
          duration_months: offer.durationMonths,
          valid_until: offer.validUntil.toISOString(),
          months_remaining: offer.monthsRemaining,
        }
      : null,
  });
});
