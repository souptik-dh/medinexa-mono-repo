import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, otpSchema } from "@/lib/validators";
import { pool, parseDbTimestamp, type Row } from "@/lib/db";
import { hashToken, issueTokens } from "@/lib/auth";
import { loadRoleBindings } from "@/lib/auth-flows";
import { loadStaffPermissions } from "@/lib/permissions";
import { ApiError, forbidden, unauthorized } from "@/lib/errors";

const MAX_ATTEMPTS = 5;

const schema = z.object({
  phone: phoneSchema,
  otp: otpSchema,
});

export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  const [codes] = await pool.query<Row[]>(
    `SELECT * FROM otp_codes
      WHERE phone = ? AND purpose = 'branch_staff_login' AND verified_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [body.phone],
  );
  const code = codes[0];
  if (!code) throw unauthorized("INVALID_OTP", "No pending OTP found for this phone number.");

  const expired = parseDbTimestamp(code.expires_at).getTime() < Date.now();
  const attemptCount = Number(code.attempts);

  if (attemptCount >= MAX_ATTEMPTS) {
    throw unauthorized("OTP_MAX_ATTEMPTS", "Too many failed attempts. Request a new OTP.");
  }
  if (expired) {
    await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);
    throw new ApiError(410, "OTP_EXPIRED", "This OTP has expired. Request a new one.");
  }

  if (hashToken(`${body.phone}:${body.otp}`) !== code.code_hash) {
    await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [code.id]);
    throw unauthorized("INVALID_OTP", "Incorrect OTP. Please try again.");
  }

  await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);

  const [users] = await pool.query<Row[]>(
    `SELECT u.* FROM users u JOIN branch_staff bs ON bs.user_id = u.id
      WHERE u.phone = ? AND u.role = 'branch_staff' AND u.status = 'active'`,
    [body.phone],
  );
  const user = users[0];
  if (!user) throw forbidden("ACCOUNT_DISABLED", "This staff account is no longer active.");

  const { branchId, doctorId } = await loadRoleBindings(user.id, "branch_staff");
  const permissions = branchId
    ? await loadStaffPermissions(pool, branchId, user.id)
    : [];
  const { access_token, refresh_token } = await issueTokens({
    id: user.id,
    role: "branch_staff",
    branchId,
    doctorId,
  });
  return json({
    access_token,
    refresh_token,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email ?? null,
      role: user.role,
      branch_id: branchId,
      permissions,
    },
  });
});
