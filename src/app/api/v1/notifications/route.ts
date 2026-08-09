import { api, json, decodeCursor } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parsePagination } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { fetchPage } from "@/lib/pagination";

function notifScope(auth: { role: string; userId: string; branchId: string | null }): {
  where: string;
  params: unknown[];
} {
  if (auth.role === "branch_staff") {
    return { where: "(n.user_id = ? OR n.branch_id = ?)", params: [auth.userId, auth.branchId] };
  }
  return { where: "n.user_id = ?", params: [auth.userId] };
}

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  const sp = ctx.request.nextUrl.searchParams;
  const { limit, cursor } = parsePagination(sp);
  const unreadOnly = sp.get("unread_only") === "true";

  const scope = notifScope(auth);
  const whereParts = [scope.where];
  const params = [...scope.params];
  if (unreadOnly) {
    whereParts.push("n.read_at IS NULL");
  }

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: "SELECT n.*",
    from: "FROM notifications n",
    where: whereParts.join(" AND "),
    params,
    cursor: decodeCursor(cursor),
    limit,
  });

  const [countRows] = await pool.query<Row[]>(
    `SELECT COUNT(*) AS cnt FROM notifications n WHERE ${scope.where} AND n.read_at IS NULL`,
    scope.params,
  );

  return json({
    items: rows.map((n) => ({
      id: n.id,
      user_id: n.user_id,
      branch_id: n.branch_id,
      type: n.type,
      payload: n.payload_json,
      read_at: n.read_at,
      created_at: n.created_at,
    })),
    unread_count: Number(countRows[0].cnt),
    next_cursor: nextCursor,
  });
});
