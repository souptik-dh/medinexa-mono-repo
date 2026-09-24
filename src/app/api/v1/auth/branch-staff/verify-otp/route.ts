import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, otpSchema } from "@/lib/validators";
import { pool, parseDbTimestamp, type Row } from "@/lib/db";
import { hashToken, issueTokens } from "@/lib/auth";
import { loadRoleBindings } from "@/lib/auth-flows";
import { loadStaffPermissions } from "@/lib/permissions";
import { ApiError, forbidden, unauthorized } from "@/lib/errors";
import { createClinicUserNotification } from "@/lib/notifications";
import type { ResultSetHeader } from "mysql2/promise";

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

  // First successful login for this staff member = "joining" the clinic. The atomic
  // UPDATE ... WHERE joined_at IS NULL both records it and doubles as the guard: only
  // the login that actually flips it from NULL fires the notification, so a retried
  // verify-otp call (or any later login) never notifies the owner again.
  if (branchId) {
    const [claim] = await pool.query<ResultSetHeader>(
      `UPDATE branch_staff SET joined_at = UTC_TIMESTAMP(3) WHERE branch_id = ? AND user_id = ? AND joined_at IS NULL`,
      [branchId, user.id],
    );
    if (claim.affectedRows === 1) {
      const [ownerRows] = await pool.query<Row[]>(
        `SELECT c.owner_user_id, b.name AS branch_name, c.name AS clinic_name
           FROM branches b JOIN clinics c ON c.id = b.clinic_id
          WHERE b.id = ?`,
        [branchId],
      );
      const owner = ownerRows[0];
      if (owner) {
        // Best-effort: a notification failure must never block the staff member's
        // login, which is the actual critical path here.
        try {
          await createClinicUserNotification(pool, owner.owner_user_id, "staff_joined", {
            staff_user_id: user.id,
            staff_name: user.name,
            branch_id: branchId,
            branch_name: owner.branch_name,
            clinic_name: owner.clinic_name,
          }, branchId);
        } catch (err) {
          console.error("[staff_joined] failed to notify clinic owner:", err);
        }
      }
    }
  }

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
