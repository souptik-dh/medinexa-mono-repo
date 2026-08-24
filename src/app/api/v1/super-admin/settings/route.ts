import { z } from "zod";
import { api, json, readJson, clientIp } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireSuperAdmin, logSuperAdminAction } from "@/lib/super-admin";
import { badRequest } from "@/lib/errors";

const ALLOWED_KEYS: Record<string, string> = {
  "subscription.expiring_warning_days": "Days before expiry when a subscription is flagged EXPIRING",
  "subscription.max_months_per_payment": "Maximum months payable in a single subscription payment",
  "subscription.currency": "Default subscription currency (ISO 4217)",
};

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const [rows] = await pool.query<Row[]>(`SELECT * FROM platform_settings ORDER BY setting_key`);
  return json({
    items: rows.map((r) => ({
      key: r.setting_key,
      value: r.setting_value,
      description: r.description ?? null,
      updated_at: r.updated_at,
    })),
    editable_keys: Object.entries(ALLOWED_KEYS).map(([key, description]) => ({ key, description })),
  });
});

const patchSchema = z.object({
  key: z.string().trim().min(1),
  value: z.string().trim().min(1).max(255),
});

export const PATCH = api({ rateLimit: 30 }, async (ctx) => {
  const admin = await requireSuperAdmin(ctx.auth);
  const body = parseBody(patchSchema, await readJson(ctx.request));

  if (!ALLOWED_KEYS[body.key]) {
    throw badRequest("SETTING_NOT_EDITABLE", `Setting '${body.key}' is not editable.`, "key");
  }
  if (body.key !== "subscription.currency" && !/^\d+$/.test(body.value)) {
    throw badRequest("VALIDATION_ERROR", "Value must be a non-negative integer.", "value");
  }

  await withTransaction(async (conn) => {
    const [existing] = await conn.query<Row[]>(`SELECT setting_value FROM platform_settings WHERE setting_key = ?`, [
      body.key,
    ]);
    await conn.query(
      `INSERT INTO platform_settings (setting_key, setting_value, updated_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [body.key, body.value, admin.userId],
    );
    await logSuperAdminAction(conn, {
      actorUserId: admin.userId,
      action: "platform_setting.updated",
      resourceType: "platform_setting",
      resourceId: body.key,
      changes: { from: existing[0]?.setting_value ?? null, to: body.value },
      ipAddress: clientIp(ctx.request),
    });
  });

  return json({ message: "Setting updated.", key: body.key, value: body.value });
});
