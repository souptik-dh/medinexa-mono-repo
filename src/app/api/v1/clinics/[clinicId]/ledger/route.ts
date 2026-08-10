import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedClinic } from "@/lib/scope";
import { badRequest } from "@/lib/errors";

const MONTH_RE = /^\d{4}-\d{2}$/;

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const clinic = await getOwnedClinic(pool, ctx.params.clinicId, auth.userId);

  const month = ctx.request.nextUrl.searchParams.get("month");
  if (month && !MONTH_RE.test(month)) {
    throw badRequest("VALIDATION_ERROR", "month must be YYYY-MM.");
  }

  const where = month ? "l.clinic_id = ? AND l.period_month = ?" : "l.clinic_id = ?";
  const params = month ? [clinic.id, month] : [clinic.id];

  const [rows] = await pool.query<Row[]>(
    `SELECT l.id, l.branch_id, b.name AS branch_name, l.period_month, l.currency,
            l.total_amount, l.payment_count, l.updated_at
       FROM clinic_payment_ledger l
       JOIN branches b ON b.id = l.branch_id
      WHERE ${where}
      ORDER BY l.period_month DESC, b.name ASC`,
    params,
  );

  return json({
    items: rows.map((r) => ({
      id: r.id,
      branch_id: r.branch_id,
      branch_name: r.branch_name,
      period_month: r.period_month,
      currency: r.currency,
      total_amount: Number(r.total_amount),
      payment_count: Number(r.payment_count),
      updated_at: r.updated_at,
    })),
  });
});
