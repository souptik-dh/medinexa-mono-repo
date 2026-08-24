import { z } from "zod";
import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { parsePagination } from "@/lib/validators";
import { requireSuperAdmin } from "@/lib/super-admin";
import { fetchPage } from "@/lib/pagination";
import { decodeCursor } from "@/lib/http";
import { serializeSubscriptionPayment } from "@/lib/subscriptions";
import { notFound } from "@/lib/errors";

const querySchema = z.object({ status: z.enum(["PENDING", "PAID", "FAILED"]).optional() });

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const { clinicId } = ctx.params;
  const sp = ctx.request.nextUrl.searchParams;
  const { status } = querySchema.parse(Object.fromEntries(sp.entries()));
  const { limit, cursor } = parsePagination(sp);

  const [exists] = await pool.query(`SELECT id FROM clinics WHERE id = ?`, [clinicId]);
  if (!Array.isArray(exists) || exists.length === 0) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: `SELECT sp.*`,
    from: `FROM subscription_payments sp`,
    where: `sp.clinic_id = ?${status ? " AND sp.status = ?" : ""}`,
    params: status ? [clinicId, status] : [clinicId],
    orderBy: "created_at DESC, id DESC",
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({ items: rows.map(serializeSubscriptionPayment), next_cursor: nextCursor });
});
