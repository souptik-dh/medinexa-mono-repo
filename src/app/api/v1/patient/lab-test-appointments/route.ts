import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { serializeLabTestAppointment, labApptScopeWhere } from "@/lib/lab-tests";
import { parsePagination } from "@/lib/validators";
import { encodeCursor } from "@/lib/http";
import type { RowDataPacket } from "mysql2/promise";

export const GET = api({ rateLimit: 60 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const sp = ctx.request.nextUrl.searchParams;
  const status = sp.get("status");
  const upcoming = sp.get("upcoming");
  const past = sp.get("past");
  const { limit, cursor } = parsePagination(sp);

  const conditions = ["a.patient_id = ?"];
  const params: unknown[] = [auth.userId];

  if (status) {
    conditions.push("a.status = ?");
    params.push(status.toUpperCase());
  }

  const today = new Date().toISOString().slice(0, 10);
  if (upcoming === "true") {
    conditions.push("(a.appointment_date > ? OR (a.appointment_date = ? AND a.start_time >= ?))");
    const now = new Date();
    params.push(today, today, `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`);
  }
  if (past === "true") {
    conditions.push("(a.appointment_date < ? OR (a.appointment_date = ? AND a.start_time < ?))");
    const now = new Date();
    params.push(today, today, `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`);
  }

  if (cursor) {
    conditions.push("a.created_at < ?");
    params.push(cursor);
  }

  const where = conditions.join(" AND ");

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.*, lt.name AS test_name, lt.code AS test_code, lt.category AS test_category,
            b.name AS branch_name, c.name AS clinic_name
       FROM lab_test_appointments a
       JOIN lab_tests lt ON lt.id = a.test_id
       JOIN branches b ON b.id = a.branch_id
       JOIN clinics c ON c.id = a.clinic_id
     WHERE ${where}
     ORDER BY
       CASE a.status
         WHEN 'PENDING' THEN 0
         WHEN 'APPROVED' THEN 1
         WHEN 'COMPLETED' THEN 2
         WHEN 'REJECTED' THEN 3
         WHEN 'CANCELLED' THEN 4
       END ASC,
       a.appointment_date DESC, a.start_time DESC
     LIMIT ?`,
    [...params, limit + 1],
  );

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0 ? encodeCursor({ created_at: items[items.length - 1].created_at }) : null;

  return json({
    items: items.map(serializeLabTestAppointment),
    next_cursor: nextCursor,
  });
});
