import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { serializeLabTestAppointment, labApptScopeWhere } from "@/lib/lab-tests";
import { parsePagination } from "@/lib/validators";
import { encodeCursor } from "@/lib/http";
import type { RowDataPacket } from "mysql2/promise";

export const GET = api({ rateLimit: 60 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const sp = ctx.request.nextUrl.searchParams;
  const branchId = sp.get("branch_id");
  const status = sp.get("status");
  const testId = sp.get("test_id");
  const serviceMode = sp.get("service_mode");
  const paymentStatus = sp.get("payment_status");
  const patientName = sp.get("patient_name");
  const appointmentNumber = sp.get("appointment_number");
  const dateFrom = sp.get("date_from");
  const dateTo = sp.get("date_to");
  const { limit, cursor } = parsePagination(sp);

  const { where: scopeWhere, params: scopeParams } = labApptScopeWhere(ctx.auth!);
  const conditions = [scopeWhere];
  const params: unknown[] = [...scopeParams];

  if (branchId) {
    conditions.push("a.branch_id = ?");
    params.push(branchId);
  }
  if (status) {
    conditions.push("a.status = ?");
    params.push(status.toUpperCase());
  }
  if (testId) {
    conditions.push("a.test_id = ?");
    params.push(testId);
  }
  if (serviceMode) {
    conditions.push("a.service_mode = ?");
    params.push(serviceMode.toUpperCase());
  }
  if (paymentStatus) {
    conditions.push("a.payment_status = ?");
    params.push(paymentStatus.toUpperCase());
  }
  if (patientName) {
    conditions.push("u.name LIKE ?");
    params.push(`%${patientName}%`);
  }
  if (appointmentNumber) {
    conditions.push("a.appointment_number = ?");
    params.push(appointmentNumber);
  }
  if (dateFrom) {
    conditions.push("a.appointment_date >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("a.appointment_date <= ?");
    params.push(dateTo);
  }
  if (cursor) {
    conditions.push("a.created_at < ?");
    params.push(cursor);
  }

  const where = conditions.join(" AND ");

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.*, lt.name AS test_name, lt.code AS test_code, lt.category AS test_category,
            b.name AS branch_name, c.name AS clinic_name,
            u.name AS patient_name, u.email AS patient_email, u.phone AS patient_phone
       FROM lab_test_appointments a
       JOIN lab_tests lt ON lt.id = a.test_id
       JOIN branches b ON b.id = a.branch_id
       JOIN clinics c ON c.id = a.clinic_id
       JOIN users u ON u.id = a.patient_id
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

  return json({ items: items.map(serializeLabTestAppointment), next_cursor: nextCursor });
});
