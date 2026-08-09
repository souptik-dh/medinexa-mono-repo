import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, emailSchema } from "@/lib/validators";
import { pool, type Row } from "@/lib/db";
import { hashToken, issueTokens } from "@/lib/auth";
import { loadRoleBindings } from "@/lib/auth-flows";
import { ApiError, forbidden, unauthorized } from "@/lib/errors";

const MAX_ATTEMPTS = 5;

const schema = z.object({
  email: emailSchema,
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits."),
});

export const POST = api({ rateLimit: 10, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  const [codes] = await pool.query<Row[]>(
    `SELECT * FROM otp_codes
      WHERE email = ? AND purpose = 'branch_staff_login' AND verified_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [body.email],
  );
  const code = codes[0];
  if (!code) throw unauthorized("INVALID_OTP", "No pending OTP found for this email.");

  const expired = new Date(code.expires_at).getTime() < Date.now();
  const attemptCount = Number(code.attempts);

  if (attemptCount >= MAX_ATTEMPTS) {
    throw unauthorized("OTP_MAX_ATTEMPTS", "Too many failed attempts. Request a new OTP.");
  }
  if (expired) {
    await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);
    throw new ApiError(410, "OTP_EXPIRED", "This OTP has expired. Request a new one.");
  }

  if (hashToken(`${body.email}:${body.otp}`) !== code.code_hash) {
    await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [code.id]);
    throw unauthorized("INVALID_OTP", "Incorrect OTP. Please try again.");
  }

  await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);

  const [users] = await pool.query<Row[]>(
    `SELECT u.* FROM users u JOIN branch_staff bs ON bs.user_id = u.id
      WHERE u.email = ? AND u.role = 'branch_staff' AND u.status = 'active'`,
    [body.email],
  );
  const user = users[0];
  if (!user) throw forbidden("ACCOUNT_DISABLED", "This staff account is no longer active.");

  const { branchId, doctorId } = await loadRoleBindings(user.id, "branch_staff");
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
      email: user.email,
      role: user.role,
      branch_id: branchId,
    },
  });
});
