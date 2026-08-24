import { z } from "zod";
import { api, json, readJson, clientIp } from "@/lib/http";
import { pool, withTransaction } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireSuperAdmin, logSuperAdminAction } from "@/lib/super-admin";
import { notFound, conflict, isUniqueViolation } from "@/lib/errors";
import { emailSchema } from "@/lib/validators";
import type { Row } from "@/lib/db";

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const [rows] = await pool.query<Row[]>(
    `SELECT u.id, u.email, u.name, u.status, sa.created_at AS granted_at, sa.revoked_at,
            gu.email AS granted_by_email
       FROM super_admins sa
       JOIN users u ON u.id = sa.user_id
       LEFT JOIN users gu ON gu.id = sa.granted_by
      ORDER BY sa.revoked_at IS NOT NULL ASC, sa.created_at ASC`,
  );
  return json({
    items: rows.map((r) => ({
      user_id: r.id,
      email: r.email,
      name: r.name,
      account_status: r.status,
      revoked: Boolean(r.revoked_at),
      granted_by_email: r.granted_by_email ?? null,
      granted_at: r.granted_at,
    })),
  });
});

const grantSchema = z.object({ email: emailSchema });

/** Grants Super Admin to an existing sys_admin-role user. */
export const POST = api({ rateLimit: 20 }, async (ctx) => {
  const admin = await requireSuperAdmin(ctx.auth);
  const body = parseBody(grantSchema, await readJson(ctx.request));

  const [users] = await pool.query<Row[]>(`SELECT id, role, status FROM users WHERE email = ?`, [body.email]);
  const user = users[0];
  if (!user) throw notFound("USER_NOT_FOUND", "No account exists with that email.");
  if (user.role !== "sys_admin") {
    throw conflict("NOT_SYS_ADMIN", "Only users with the sys_admin role can become a platform Super Admin.");
  }

  try {
    await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO super_admins (user_id, granted_by) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE revoked_at = NULL, granted_by = VALUES(granted_by)`,
        [user.id, admin.userId],
      );
      await logSuperAdminAction(conn, {
        actorUserId: admin.userId,
        action: "super_admin.granted",
        resourceType: "super_admin",
        resourceId: String(user.id),
        changes: { email: body.email },
        ipAddress: clientIp(ctx.request),
      });
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  return json({ message: "Super Admin granted.", user_id: user.id, email: body.email }, 201);
});
