/**
 * Next.js instrumentation hook — runs once per server process start.
 * Starts the hourly subscription cron (expiry sweep + expiring warnings) and the
 * 15-minute overdue-appointment auto-cancel sweep. Guarded to the Node.js runtime only.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startSubscriptionCron } = await import("@/lib/subscriptions");
    startSubscriptionCron();
  } catch (err) {
    console.error("[instrumentation] Failed to start subscription cron:", err);
  }
  try {
    const { startAppointmentExpiryCron } = await import("@/lib/appointment-expiry");
    startAppointmentExpiryCron();
  } catch (err) {
    console.error("[instrumentation] Failed to start appointment expiry cron:", err);
  }
}
