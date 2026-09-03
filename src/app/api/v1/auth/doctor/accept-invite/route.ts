import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, optionalEmailSchema, otpSchema, passwordSchema } from "@/lib/validators";
import { pool, withTransaction, parseDbTimestamp, type Row } from "@/lib/db";
import { hashPassword, hashToken, issueTokens } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { ApiError, conflict, notFound, isUniqueViolation, badRequest } from "@/lib/errors";
import { createNotification, sendEmail, emailHtml, sendSmsIfPhone } from "@/lib/notifications";
import { getInviteSpecializations } from "@/lib/specializations";
import { assertClinicOperational, resolveClinicIdByBranch } from "@/lib/subscriptions";
import type { ResultSetHeader } from "mysql2/promise";

const schema = z.object({
  phone: phoneSchema,
  email: optionalEmailSchema,
  invite_code: z.string().min(1).max(32),
  otp: otpSchema,
  password: passwordSchema.optional().nullable(),
  reg_no: z.string().trim().max(64).optional().nullable(),
  smc_name: z.string().trim().max(255).optional().nullable(),
  doctor_degree: z.string().trim().max(100).optional().nullable(),
}).refine(
  (body) => !body.password || body.password.length >= 8,
  "Password must be at least 8 characters.",
);

/**
 * Verifies the doctor's phone OTP (purpose phone_verification) is valid before
 * accepting the invite.
 */
async function verifyAcceptOtp(phone: string, otp: string): Promise<void> {
  const [codes] = await pool.query<Row[]>(
    `SELECT * FROM otp_codes
      WHERE phone = ? AND purpose = 'phone_verification' AND verified_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [phone],
  );
  const code = codes[0];
  if (!code) throw notFound("INVALID_OTP", "No pending OTP found for this phone number.");
  if (parseDbTimestamp(code.expires_at).getTime() < Date.now()) {
    throw new ApiError(410, "OTP_EXPIRED", "This OTP has expired. Request a new one.");
  }
  if (hashToken(`${phone}:${otp}`) !== code.code_hash) {
    await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [code.id]);
    throw badRequest("INVALID_OTP", "Incorrect OTP. Please try again.");
  }
  await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);
}

export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  // Look up the pending invite by phone (invites have phone as primary
  // identifier); fall back to email for backward compatibility.
  const [invites] = await pool.query<Row[]>(
    `SELECT * FROM doctor_invites
      WHERE (phone = ? OR (email = ? AND phone IS NULL)) AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1`,
    [body.phone, body.email ?? null],
  );
  const invite = invites[0];
  if (!invite || hashToken(body.invite_code) !== invite.invite_code_hash) {
    throw notFound("INVITE_NOT_FOUND", "Invite not found or invite code is invalid.");
  }
  if (parseDbTimestamp(invite.expires_at).getTime() < Date.now()) {
    await pool.query(`UPDATE doctor_invites SET status = 'expired' WHERE id = ?`, [invite.id]);
    throw new ApiError(410, "INVITE_EXPIRED", "This invite has expired. Contact the clinic for a new one.");
  }

  // The doctor must have verified their phone with the OTP first.
  await verifyAcceptOtp(body.phone, body.otp);

  // Doctors cannot join a clinic whose subscription is inactive.
  const inviteClinicId = await resolveClinicIdByBranch(pool, invite.branch_id);
  if (inviteClinicId) await assertClinicOperational(pool, inviteClinicId);

  const doctorId = newId();
  const userId = newId();
  const assignmentId = newId();
  const passwordHash = body.password ? await hashPassword(body.password) : null;
  const slotTemplates = invite.slot_template as Array<Record<string, unknown>>;

  const [ownerRows] = await pool.query<Row[]>(
    `SELECT c.owner_user_id, co.email AS owner_email
       FROM branches b
       JOIN clinics c ON c.id = b.clinic_id
       JOIN users co ON co.id = c.owner_user_id
      WHERE b.id = ?`,
    [invite.branch_id],
  );
  const owner = ownerRows[0];
  const regNo = invite.reg_no ?? body.reg_no ?? null;
  const smcName = invite.smc_name ?? body.smc_name ?? null;
  const doctorDegree = invite.doctor_degree ?? body.doctor_degree ?? null;

  await withTransaction(async (conn) => {
    const [claim] = await conn.query<ResultSetHeader>(
      `UPDATE doctor_invites SET status = 'accepted', reg_no = ?, smc_name = ?, doctor_degree = ?, phone = ?
        WHERE id = ? AND status = 'pending'`,
      [regNo, smcName, doctorDegree, body.phone, invite.id],
    );
    if (claim.affectedRows !== 1) {
      throw conflict("INVITE_ALREADY_ACCEPTED", "This invite has already been accepted.");
    }

    await conn.query(
      `INSERT INTO users (id, name, email, phone, phone_verified, password_hash, role, status)
       VALUES (?, ?, ?, ?, 1, ?, 'doctor', 'active')`,
      [userId, invite.name, body.email ?? null, body.phone, passwordHash],
    );
    await conn.query(
      `INSERT INTO doctors (id, user_id, name, reg_no, smc_name, doctor_degree, phone, certificate_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [doctorId, userId, invite.name, regNo, smcName, doctorDegree, body.phone, invite.certificate_url ?? null],
    );
    const [inviteSpecializations] = await conn.query<Row[]>(
      `SELECT specialization_id FROM doctor_invite_specializations WHERE doctor_invite_id = ?`,
      [invite.id],
    );
    for (const s of inviteSpecializations) {
      await conn.query(
        `INSERT INTO doctor_specialization_map (id, doctor_id, specialization_id) VALUES (?, ?, ?)`,
        [newId(), doctorId, s.specialization_id],
      );
    }
    await conn.query(
      `INSERT INTO doctor_branch_assignments (id, doctor_id, branch_id, fee_amount, currency, is_active, slot_type)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [assignmentId, doctorId, invite.branch_id, invite.fee_amount, invite.currency, invite.slot_type],
    );
    for (const t of slotTemplates) {
      const [h, m] = String(t.start_time).split(":");
      const [eh, em] = String(t.end_time).split(":");
      await conn.query(
        `INSERT INTO doctor_slot_templates
           (id, doctor_branch_assignment_id, weekday, start_time, end_time, slot_duration_minutes, start_date, end_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          assignmentId,
          t.weekday,
          `${h}:${m}:00`,
          `${eh}:${em}:00`,
          t.slot_duration_minutes,
          t.start_date,
          t.end_date ?? null,
        ],
      );
    }
    await createNotification(conn, invite.invited_by, "doctor_invite_accepted", {
      doctor_id: doctorId,
      branch_id: invite.branch_id,
      phone: body.phone,
    });
    if (owner && owner.owner_user_id !== invite.invited_by) {
      await createNotification(conn, owner.owner_user_id, "doctor_invite_accepted", {
        doctor_id: doctorId,
        branch_id: invite.branch_id,
        phone: body.phone,
      });
    }
  }).catch((err) => {
    if (isUniqueViolation(err)) {
      const msg = String((err as { message?: string }).message ?? "");
      if (msg.includes("uniq_doctors_reg_no")) {
        throw conflict("REG_NO_ALREADY_REGISTERED", "A doctor with this registration number already exists.");
      }
      if (msg.includes("uniq_users_phone")) {
        throw conflict("PHONE_ALREADY_REGISTERED", "An account with this phone number already exists.");
      }
      throw conflict("EMAIL_ALREADY_REGISTERED", "An account with this email already exists.");
    }
    throw err;
  });

  if (owner) {
    const acceptedBody = `Dr. ${invite.name} (${body.phone}) has accepted your invitation and joined your branch.`;
    await sendEmail(
      owner.owner_email,
      "Doctor invite accepted",
      acceptedBody,
      emailHtml(acceptedBody),
    );
    await sendSmsIfPhone(pool, owner.owner_user_id, acceptedBody);
  }

  const { access_token, refresh_token } = await issueTokens({
    id: userId,
    role: "doctor",
    branchId: null,
    doctorId,
  });

  const specializationsByInvite = await getInviteSpecializations(pool, [invite.id]);

  return json({
    access_token,
    refresh_token,
    requires_password_setup: !passwordHash,
    doctor: {
      id: doctorId,
      name: invite.name,
      specializations: specializationsByInvite.get(invite.id) ?? [],
      reg_no: regNo,
      smc_name: smcName,
      doctor_degree: doctorDegree,
      phone: body.phone,
      certificate_url: invite.certificate_url ?? null,
      photo_url: null,
      bio: null,
    },
  });
});
