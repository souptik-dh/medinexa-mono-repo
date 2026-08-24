import { z } from "zod";
import { api, json, readJson, clientIp } from "@/lib/http";
import { pool, withTransaction } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireSuperAdmin, logSuperAdminAction } from "@/lib/super-admin";
import { newId } from "@/lib/ids";
import type { Row } from "@/lib/db";

/**
 * GET — plan version history (newest first).
 * POST — change the subscription price by publishing a NEW active plan version.
 * Existing subscriptions and already-created payments keep their own amount
 * snapshots; only payments initiated after the change use the new price.
 */
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const [plans] = await pool.query<Row[]>(
    `SELECT p.id, p.name, p.billing_period, p.amount, p.currency, p.trial_months,
            p.is_active, p.effective_from, p.created_at,
            u.email AS created_by_email
       FROM subscription_plans p LEFT JOIN users u ON u.id = p.created_by
      ORDER BY p.effective_from DESC`,
  );
  return json({
    items: plans.map((p) => ({
      id: p.id,
      name: p.name,
      billing_period: p.billing_period,
      monthly_amount: Number(p.amount),
      currency: p.currency,
      trial_months: Number(p.trial_months),
      is_active: Boolean(p.is_active),
      effective_from: p.effective_from,
      created_by_email: p.created_by_email ?? null,
      created_at: p.created_at,
    })),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(100).default("Clinic Monthly"),
  monthly_amount: z.coerce.number().positive("Amount must be greater than zero.").max(1_000_000),
  currency: z.string().trim().toUpperCase().length(3).default("INR"),
  trial_months: z.coerce.number().int().min(0).max(12).default(2),
});

export const POST = api({ rateLimit: 30 }, async (ctx) => {
  const admin = await requireSuperAdmin(ctx.auth);
  const body = parseBody(createSchema, await readJson(ctx.request));

  const planId = await withTransaction(async (conn) => {
    // Deactivate all current versions, then publish the new one.
    await conn.query(`UPDATE subscription_plans SET is_active = 0 WHERE is_active = 1`);
    const id = newId();
    await conn.query(
      `INSERT INTO subscription_plans
         (id, name, billing_period, amount, currency, trial_months, is_active, effective_from, created_by)
       VALUES (?, ?, 'monthly', ?, ?, ?, 1, UTC_TIMESTAMP(3), ?)`,
      [id, body.name, body.monthly_amount.toFixed(2), body.currency, body.trial_months, admin.userId],
    );
    await logSuperAdminAction(conn, {
      actorUserId: admin.userId,
      action: "subscription_plan.price_changed",
      resourceType: "subscription_plan",
      resourceId: id,
      changes: {
        monthly_amount: body.monthly_amount,
        currency: body.currency,
        trial_months: body.trial_months,
        name: body.name,
      },
      ipAddress: clientIp(ctx.request),
    });
    return id;
  });

  return json(
    {
      message:
        "New plan version published. It applies to payments initiated from now on; existing subscriptions are unaffected.",
      plan_id: planId,
      monthly_amount: body.monthly_amount,
      currency: body.currency,
      trial_months: body.trial_months,
    },
    201,
  );
});
