import { createHmac, timingSafeEqual } from "node:crypto";
import { api, json } from "@/lib/http";
import { withTransaction } from "@/lib/db";
import { applyPaidPayment, serializeSubscriptionPayment } from "@/lib/subscriptions";
import { unauthorized, notFound, conflict, ApiError } from "@/lib/errors";
import type { Row } from "@/lib/db";

/**
 * Gateway webhook for subscription payments. The raw request body is verified
 * against the `x-webhook-signature` header — an HMAC-SHA256 of the exact bytes
 * using the shared webhook secret. No JWT; the signature IS the authentication.
 * Idempotent: replays and already-applied payments are acknowledged harmlessly.
 */
export const POST = api({ rateLimit: 120 }, async (ctx) => {
  const secret = process.env.WEBHOOK_SECRET ?? process.env.SUBSCRIPTION_PAYMENT_SECRET;
  if (!secret) {
    // Fail closed — never accept unverified webhook payloads.
    return json(
      {
        error: {
          code: "WEBHOOK_NOT_CONFIGURED",
          message: "Webhook verification secret is not configured on the server.",
          field: null,
        },
      },
      503,
    );
  }

  const raw = await ctx.request.text();
  const headerSig = ctx.request.headers.get("x-webhook-signature") ?? "";
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(headerSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw unauthorized("INVALID_WEBHOOK_SIGNATURE", "Webhook signature verification failed.");
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json({ received: true, handled: false, reason: "invalid_json" });
  }

  // Razorpay-style envelope: { event, payload: { payment: { entity: {...} } } }
  const payload = body.payload as Record<string, Record<string, Record<string, unknown>>> | undefined;
  const entity = payload?.payment?.entity;
  const orderId = typeof entity?.order_id === "string" ? entity.order_id : null;
  const providerPaymentId = typeof entity?.id === "string" ? entity.id : null;

  if (!orderId) return json({ received: true, handled: false, reason: "missing_order_id" });

  try {
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.query<Row[]>(
        `SELECT * FROM subscription_payments WHERE provider_order_id = ? FOR UPDATE`,
        [orderId],
      );
      const payment = rows[0];
      if (!payment) throw notFound("PAYMENT_NOT_FOUND", "No subscription payment for this order.");
      if (payment.status === "PAID") return { duplicate: true as const, payment };
      if (payment.status === "FAILED") {
        throw conflict("PAYMENT_FAILED", "This payment attempt failed and cannot be applied.");
      }
      const applied = await applyPaidPayment(conn, payment, {
        verificationMethod: "webhook",
        verifiedBy: providerPaymentId,
        source: "webhook",
      });
      return { duplicate: false as const, ...applied };
    });

    return json({
      received: true,
      handled: true,
      duplicate: result.duplicate,
      payment: serializeSubscriptionPayment(result.payment),
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === "PAYMENT_NOT_FOUND") {
      // Unknown orders are acked so the gateway stops retrying.
      return json({ received: true, handled: false, reason: "unknown_order" });
    }
    throw err;
  }
});
