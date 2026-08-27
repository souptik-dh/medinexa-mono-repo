import { api, json, clientIp } from "@/lib/http";
import { requireSuperAdmin, logSuperAdminAction } from "@/lib/super-admin";
import { processOverdueAppointments, startAppointmentExpiryCron } from "@/lib/appointment-expiry";
import { withTransaction } from "@/lib/db";

/**
 * Scheduled-processing trigger. Callable two ways:
 *  1. By a Super Admin (Bearer token), or
 *  2. By an external scheduler sending the `x-cron-secret` header matching CRON_SECRET.
 * Idempotent — cancels doctor/lab-test appointments still pending/unconfirmed once their
 * scheduled date+time has passed. Also runs every 15 minutes in-process via instrumentation.
 */
export const POST = api({ rateLimit: 30 }, async (ctx) => {
  const cronSecret = process.env.CRON_SECRET;
  const headerSecret = ctx.request.headers.get("x-cron-secret");

  if (!(headerSecret && cronSecret && headerSecret === cronSecret)) {
    const admin = await requireSuperAdmin(ctx.auth);
    await withTransaction(async (conn) => {
      await logSuperAdminAction(conn, {
        actorUserId: admin.userId,
        action: "appointments.overdue_sweep_triggered",
        resourceType: "appointment",
        resourceId: null,
        ipAddress: clientIp(ctx.request),
      });
    });
  }

  startAppointmentExpiryCron();
  const result = await processOverdueAppointments();
  return json({ message: "Overdue appointment sweep complete.", result });
});
