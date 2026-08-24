import { api, json, clientIp } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireSuperAdmin, logSuperAdminAction } from "@/lib/super-admin";
import { processExpiredSubscriptions, startSubscriptionCron } from "@/lib/subscriptions";
import { withTransaction } from "@/lib/db";

/**
 * Scheduled-processing trigger. Callable two ways:
 *  1. By a Super Admin (Bearer token), or
 *  2. By an external scheduler sending the `x-cron-secret` header matching CRON_SECRET.
 * Idempotent — expires lapsed trials/subscriptions and notifies owners in the
 * expiring-warning window. Also runs hourly in-process via instrumentation.
 */
export const POST = api({ rateLimit: 30 }, async (ctx) => {
  const cronSecret = process.env.CRON_SECRET;
  const headerSecret = ctx.request.headers.get("x-cron-secret");

  if (!(headerSecret && cronSecret && headerSecret === cronSecret)) {
    const admin = await requireSuperAdmin(ctx.auth);
    await withTransaction(async (conn) => {
      await logSuperAdminAction(conn, {
        actorUserId: admin.userId,
        action: "subscription.sweep_triggered",
        resourceType: "clinic_subscription",
        resourceId: null,
        ipAddress: clientIp(ctx.request),
      });
    });
  }

  startSubscriptionCron();
  const result = await processExpiredSubscriptions(pool);
  return json({ message: "Subscription sweep complete.", result });
});
