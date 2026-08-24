import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/super-admin";
import { notFound } from "@/lib/errors";
import {
  ensureClinicSubscription,
  computeLiveState,
  serializeSubscription,
  getActivePlan,
  getPlatformSettings,
} from "@/lib/subscriptions";

/** Full subscription view for one clinic (admin perspective). */
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const { clinicId } = ctx.params;

  const [exists] = await pool.query(`SELECT id FROM clinics WHERE id = ? AND deleted_at IS NULL`, [clinicId]);
  if (!Array.isArray(exists) || exists.length === 0) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");

  const sub = await ensureClinicSubscription(pool, clinicId);
  const settings = await getPlatformSettings(pool);
  const live = computeLiveState(sub, settings.expiring_warning_days);
  const plan = await getActivePlan(pool);

  const [totals] = await pool.query<Row[]>(
    `SELECT
        (SELECT COALESCE(SUM(amount), 0) FROM subscription_payments WHERE clinic_id = ? AND status = 'PAID') AS total_paid,
        (SELECT COUNT(*) FROM subscription_payments WHERE clinic_id = ? AND status = 'PAID') AS paid_count`,
    [clinicId, clinicId],
  );
  const t = totals[0] ?? {};

  return json({
    subscription: serializeSubscription(sub, live),
    current_plan: {
      id: plan.id,
      name: plan.name,
      monthly_amount: plan.amount,
      currency: plan.currency,
      trial_months: plan.trial_months,
    },
    lifetime: {
      total_paid: Number(t?.total_paid ?? 0),
      paid_payment_count: Number(t?.paid_count ?? 0),
    },
  });
});
