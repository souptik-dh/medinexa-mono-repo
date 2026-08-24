import { z } from "zod";
import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { parsePagination } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getOwnedClinic } from "@/lib/scope";
import { fetchPage } from "@/lib/pagination";
import { decodeCursor } from "@/lib/http";
import { serializeHistory } from "@/lib/subscriptions";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  await getOwnedClinic(pool, ctx.params.clinicId, auth.userId, { skipSubscriptionGate: true });

  const sp = ctx.request.nextUrl.searchParams;
  querySchema.parse(Object.fromEntries(sp.entries()));
  const { limit, cursor } = parsePagination(sp);

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: `SELECT sh.*`,
    from: `FROM subscription_history sh`,
    where: `sh.clinic_id = ?`,
    params: [ctx.params.clinicId],
    orderBy: "created_at DESC, id DESC",
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({ items: rows.map(serializeHistory), next_cursor: nextCursor });
});
