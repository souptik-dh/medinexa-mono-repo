import { z } from "zod";
import { api, json, decodeCursor } from "@/lib/http";
import { pool } from "@/lib/db";
import { parsePagination } from "@/lib/validators";
import { requireSuperAdmin } from "@/lib/super-admin";
import { fetchPage } from "@/lib/pagination";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  action: z.string().trim().max(100).optional(),
  actor_user_id: z.string().uuid().optional(),
  resource_type: z.string().trim().max(50).optional(),
  resource_id: z.string().uuid().optional(),
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
});

/** Audit trail of Super Admin (and other audited) actions. */
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const sp = ctx.request.nextUrl.searchParams;
  const filters = querySchema.parse(Object.fromEntries(sp.entries()));
  const { limit, cursor } = parsePagination(sp);

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (filters.action) {
    whereParts.push("al.action LIKE ?");
    params.push(`%${filters.action}%`);
  }
  if (filters.actor_user_id) {
    whereParts.push("al.actor_user_id = ?");
    params.push(filters.actor_user_id);
  }
  if (filters.resource_type) {
    whereParts.push("al.resource_type = ?");
    params.push(filters.resource_type);
  }
  if (filters.resource_id) {
    whereParts.push("al.resource_id = ?");
    params.push(filters.resource_id);
  }
  if (filters.from) {
    whereParts.push("al.created_at >= ?");
    params.push(`${filters.from} 00:00:00`);
  }
  if (filters.to) {
    whereParts.push("al.created_at <= ?");
    params.push(`${filters.to} 23:59:59.999`);
  }

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: `SELECT al.*, u.email AS actor_email`,
    from: `FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_user_id`,
    where: whereParts.length > 0 ? whereParts.join(" AND ") : undefined,
    params,
    orderBy: "al.created_at DESC, al.id DESC",
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({
    items: rows.map((r) => ({
      id: r.id,
      actor: r.actor_email ? { user_id: r.actor_user_id, email: r.actor_email } : null,
      action: r.action,
      resource_type: r.resource_type,
      resource_id: r.resource_id,
      changes: r.changes_json ?? null,
      ip_address: r.ip_address ?? null,
      created_at: r.created_at,
    })),
    next_cursor: nextCursor,
  });
});
