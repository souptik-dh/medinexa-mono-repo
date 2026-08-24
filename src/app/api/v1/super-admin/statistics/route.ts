import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/super-admin";
import { getPlatformSettings, getActivePlan } from "@/lib/subscriptions";

/**
 * Subscription statistics and revenue summaries. Strictly aggregated — no patient
 * data participates in any of these numbers.
 */
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const settings = await getPlatformSettings(pool);

  const [statusCounts] = await pool.query<Row[]>(
    `SELECT cs.status, COUNT(*) AS cnt
       FROM clinic_subscriptions cs JOIN clinics c ON c.id = cs.clinic_id AND c.deleted_at IS NULL
      GROUP BY cs.status`,
  );
  const byStatus = Object.fromEntries(statusCounts.map((r) => [String(r.status), Number(r.cnt)]));
  const totalClinics = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const [expiringSoon] = await pool.query<Row[]>(
    `SELECT COUNT(*) AS cnt FROM clinic_subscriptions cs
       JOIN clinics c ON c.id = cs.clinic_id AND c.deleted_at IS NULL
      WHERE cs.status IN ('TRIAL','ACTIVE')
        AND LEAST(COALESCE(cs.trial_ends_at, cs.period_end), cs.period_end) > UTC_TIMESTAMP(3)
        AND LEAST(COALESCE(cs.trial_ends_at, cs.period_end), cs.period_end)
            <= DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? DAY)`,
    [settings.expiring_warning_days],
  );

  const [revenue] = await pool.query<Row[]>(
    `SELECT COALESCE(SUM(amount), 0) AS total,
            COALESCE(SUM(CASE WHEN verified_at >= DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-01') THEN amount ELSE 0 END), 0) AS this_month,
            COALESCE(SUM(CASE WHEN verified_at >= DATE_SUB(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-01'), INTERVAL 1 MONTH) AND verified_at < DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-01') THEN amount ELSE 0 END), 0) AS last_month,
            COUNT(*) AS paid_count
       FROM subscription_payments WHERE status = 'PAID'`,
  );

  const [monthly] = await pool.query<Row[]>(
    `SELECT DATE_FORMAT(verified_at, '%Y-%m') AS month, SUM(amount) AS amount, COUNT(*) AS count
       FROM subscription_payments
      WHERE status = 'PAID' AND verified_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(verified_at, '%Y-%m')
      ORDER BY month ASC`,
  );

  // MRR estimate uses each ACTIVE subscription's own price snapshot.
  const plan = await getActivePlan(pool);
  const [mrrRow] = await pool.query<Row[]>(
    `SELECT COALESCE(SUM(monthly_amount), 0) AS mrr FROM clinic_subscriptions
      WHERE status = 'ACTIVE' AND is_trial = 0`,
  );

  return json({
    clinics: {
      total: totalClinics,
      by_status: {
        TRIAL: byStatus["TRIAL"] ?? 0,
        ACTIVE: byStatus["ACTIVE"] ?? 0,
        EXPIRED: byStatus["EXPIRED"] ?? 0,
        INACTIVE: byStatus["INACTIVE"] ?? 0,
      },
      expiring_within_days: Number(expiringSoon[0]?.cnt ?? 0),
      expiring_window_days: settings.expiring_warning_days,
    },
    revenue_inr: {
      total_collected: Number(revenue[0]?.total ?? 0),
      current_month: Number(revenue[0]?.this_month ?? 0),
      previous_month: Number(revenue[0]?.last_month ?? 0),
      paid_payment_count: Number(revenue[0]?.paid_count ?? 0),
      monthly_breakdown: monthly.map((m) => ({ month: m.month, amount: Number(m.amount), count: Number(m.count) })),
    },
    mrr_estimate_inr: Number(mrrRow[0]?.mrr ?? 0),
    current_plan: { name: plan.name, monthly_amount: plan.amount, currency: plan.currency },
  });
});
