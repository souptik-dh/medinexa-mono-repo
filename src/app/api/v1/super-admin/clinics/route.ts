import { z } from "zod";
import { api, json, decodeCursor } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parsePagination } from "@/lib/validators";
import { requireSuperAdmin } from "@/lib/super-admin";
import { fetchPage } from "@/lib/pagination";
import { getPlatformSettings, computeLiveState, serializeSubscription } from "@/lib/subscriptions";

const querySchema = z.object({
  q: z.string().trim().max(255).optional(),
  // TRIAL | ACTIVE | EXPIRING (derived) | EXPIRED | INACTIVE
  subscription_status: z.enum(["TRIAL", "ACTIVE", "EXPIRING", "EXPIRED", "INACTIVE"]).optional(),
});

/**
 * Lists every clinic on the platform with its subscription summary.
 * Contains only clinic/administrative data — never patient records.
 */
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const sp = ctx.request.nextUrl.searchParams;
  const filters = querySchema.parse(Object.fromEntries(sp.entries()));
  const { limit, cursor } = parsePagination(sp);

  const whereParts: string[] = ["c.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (filters.q) {
    whereParts.push("(c.name LIKE ? OR u.email LIKE ? OR u.name LIKE ? OR c.city LIKE ?)");
    const like = `%${filters.q}%`;
    params.push(like, like, like, like);
  }
  if (filters.subscription_status) {
    if (filters.subscription_status === "EXPIRING") {
      const settings = await getPlatformSettings(pool);
      whereParts.push(
        "cs.status = 'ACTIVE' AND cs.period_end > UTC_TIMESTAMP(3) AND cs.period_end <= DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? DAY)",
      );
      params.push(settings.expiring_warning_days);
    } else {
      whereParts.push("cs.status = ?");
      params.push(filters.subscription_status);
    }
  }

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: `SELECT c.id, c.name, c.city, c.district, c.created_at,
                    u.id AS owner_id, u.email AS owner_email, u.name AS owner_name, u.phone AS owner_phone,
                    cs.status AS status, cs.is_trial, cs.monthly_amount, cs.currency,
                    cs.period_start, cs.period_end, cs.trial_started_at, cs.trial_ends_at,
                    cs.deactivated_at, cs.deactivation_reason,
                    (SELECT COUNT(*) FROM branches b WHERE b.clinic_id = c.id AND b.deleted_at IS NULL) AS branch_count`,
    from: `FROM clinics c
             JOIN users u ON u.id = c.owner_user_id
             LEFT JOIN clinic_subscriptions cs ON cs.clinic_id = c.id`,
    where: whereParts.join(" AND "),
    params,
    orderBy: "c.created_at DESC, c.id DESC",
    cursor: decodeCursor(cursor),
    limit,
  });

  const settings = await getPlatformSettings(pool);
  const items = [];
  for (const r of rows) {
    let sub = null;
    if (r.status != null || r.period_end != null) {
      sub = serializeSubscription(r as Row, computeLiveState(r, settings.expiring_warning_days));
    }
    items.push({
      id: r.id,
      name: r.name,
      city: r.city,
      district: r.district,
      owner: { id: r.owner_id, email: r.owner_email, name: r.owner_name, phone: r.owner_phone },
      branch_count: Number(r.branch_count),
      subscription: sub,
      created_at: r.created_at,
    });
  }

  return json({ items, next_cursor: nextCursor });
});
