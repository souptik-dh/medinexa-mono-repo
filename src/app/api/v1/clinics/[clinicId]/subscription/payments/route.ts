import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, withTransaction } from "@/lib/db";
import { parsePagination, parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getOwnedClinic } from "@/lib/scope";
import { fetchPage } from "@/lib/pagination";
import { decodeCursor } from "@/lib/http";
import {
  initiateSubscriptionPayment,
  serializeSubscriptionPayment,
  getActivePlan,
} from "@/lib/subscriptions";

const querySchema = z.object({
  status: z.enum(["PENDING", "PAID", "FAILED"]).optional(),
});

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  await getOwnedClinic(pool, ctx.params.clinicId, auth.userId, { skipSubscriptionGate: true });

  const sp = ctx.request.nextUrl.searchParams;
  const { status } = querySchema.parse(Object.fromEntries(sp.entries()));
  const { limit, cursor } = parsePagination(sp);

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: `SELECT sp.*`,
    from: `FROM subscription_payments sp`,
    where: `sp.clinic_id = ?${status ? " AND sp.status = ?" : ""}`,
    params: status ? [ctx.params.clinicId, status] : [ctx.params.clinicId],
    orderBy: "created_at DESC, id DESC",
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({ items: rows.map(serializeSubscriptionPayment), next_cursor: nextCursor });
});

const initiateSchema = z.object({
  months: z.coerce.number().int().min(1).max(12),
  method: z.enum(["upi", "card", "netbanking", "wallet"]).default("upi"),
});

/**
 * Initiates a subscription payment. The amount is computed SERVER-SIDE from the
 * active plan — the client cannot influence pricing or payment status.
 */
export const POST = api({ rateLimit: 20 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  await getOwnedClinic(pool, ctx.params.clinicId, auth.userId, { skipSubscriptionGate: true });
  const body = parseBody(initiateSchema, await readJson(ctx.request));

  const plan = await getActivePlan(pool);
  const payment = await withTransaction(async (conn) =>
    initiateSubscriptionPayment(conn, ctx.params.clinicId, {
      months: body.months,
      method: body.method,
      userId: auth.userId,
    }),
  );

  return json(
    {
      payment: serializeSubscriptionPayment(payment),
      plan: {
        name: plan.name,
        monthly_amount: plan.amount,
        currency: plan.currency,
        months: body.months,
      },
      next_steps: [
        "Complete the payment on your payment gateway using provider_order_id.",
        "POST /clinics/{clinic_id}/subscription/payments/{payment_id}/verify with provider_payment_id and provider_signature (HMAC-SHA256 of `order_id|payment_id` signed with the gateway secret).",
      ],
    },
    201,
  );
});
