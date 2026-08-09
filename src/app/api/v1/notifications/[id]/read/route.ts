import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";

export const PATCH = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);

  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM notifications WHERE id = ? AND user_id = ?`,
    [ctx.params.id, auth.userId],
  );
  const notification = rows[0];
  if (!notification) throw notFound("NOTIFICATION_NOT_FOUND", "Notification not found.");

  if (!notification.read_at) {
    await pool.query(`UPDATE notifications SET read_at = UTC_TIMESTAMP(3) WHERE id = ?`, [ctx.params.id]);
    notification.read_at = new Date().toISOString().slice(0, 19).replace("T", " ");
  }

  return json({
    id: notification.id,
    user_id: notification.user_id,
    branch_id: notification.branch_id,
    type: notification.type,
    payload: notification.payload_json,
    read_at: notification.read_at,
    created_at: notification.created_at,
  });
});
