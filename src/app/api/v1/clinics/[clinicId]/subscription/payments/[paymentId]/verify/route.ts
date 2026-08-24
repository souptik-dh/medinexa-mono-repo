import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getOwnedClinic } from "@/lib/scope";
import {
  verifySubscriptionPaymentByClient,
  serializeSubscriptionPayment,
  computeLiveState,
  serializeSubscription,
  getPlatformSettings,
} from "@/lib/subscriptions";

const verifySchema = z.object({
  provider_payment_id: z.string().trim().min(1).max(100),
  provider_signature: z.string().trim().min(16).max(255),
  reference_no: z.string().trim().max(255).optional().nullable(),
});

/**
 * Verifies a subscription payment. The signature is an HMAC-SHA256 over
 * `<provider_order_id>|<provider_payment_id>` using the server-side gateway secret —
 * a frontend claim of "paid" without it is rejected and the attempt is marked FAILED.
 * On success the paid period is applied and the clinic is reactivated automatically.
 */
export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  await getOwnedClinic(pool, ctx.params.clinicId, auth.userId, { skipSubscriptionGate: true });
  const body = parseBody(verifySchema, await readJson(ctx.request));

  const result = await verifySubscriptionPaymentByClient(pool, ctx.params.paymentId, {
    providerPaymentId: body.provider_payment_id,
    providerSignature: body.provider_signature,
    referenceNo: body.reference_no ?? null,
  });

  const settings = await getPlatformSettings(pool);
  const live = computeLiveState(result.subscription, settings.expiring_warning_days);

  return json({
    message: "Payment verified. Your clinic subscription is active.",
    payment: serializeSubscriptionPayment(result.payment),
    subscription: serializeSubscription(result.subscription, live),
  });
});
