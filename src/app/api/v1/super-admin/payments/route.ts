import { z } from "zod";
import { api, json, decodeCursor } from "@/lib/http";
import { pool } from "@/lib/db";
import { parsePagination } from "@/lib/validators";
import { requireSuperAdmin } from "@/lib/super-admin";
import { fetchPage } from "@/lib/pagination";
import { serializeSubscriptionPayment } from "@/lib/subscriptions";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  clinic_id: z.string().uuid().optional(),
  status: z.enum(["PENDING", "PAID", "FAILED"]).optional(),
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
});

/** Platform-wide subscription payment history with filters. */
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const sp = ctx.request.nextUrl.searchParams;
  const filters = querySchema.parse(Object.fromEntries(sp.entries()));
  const { limit, cursor } = parsePagination(sp);

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (filters.clinic_id) {
    whereParts.push("sp.clinic_id = ?");
    params.push(filters.clinic_id);
  }
  if (filters.status) {
    whereParts.push("sp.status = ?");
    params.push(filters.status);
  }
  if (filters.from) {
    whereParts.push("sp.created_at >= ?");
    params.push(`${filters.from} 00:00:00`);
  }
  if (filters.to) {
    whereParts.push("sp.created_at <= ?");
    params.push(`${filters.to} 23:59:59.999`);
  }

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: `SELECT sp.*, c.name AS clinic_name`,
    from: `FROM subscription_payments sp JOIN clinics c ON c.id = sp.clinic_id`,
    where: whereParts.length > 0 ? whereParts.join(" AND ") : undefined,
    params,
    orderBy: "sp.created_at DESC, sp.id DESC",
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({
    items: rows.map((r) => ({ ...serializeSubscriptionPayment(r), clinic_name: r.clinic_name })),
    next_cursor: nextCursor,
  });
});
