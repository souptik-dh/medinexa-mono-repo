import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, emailSchema, passwordSchema } from "@/lib/validators";
import { pool, withTransaction, type Row } from "@/lib/db";
import { hashPassword, hashToken, issueTokens } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { ApiError, conflict, notFound, isUniqueViolation } from "@/lib/errors";
import { createNotification, sendEmail } from "@/lib/notifications";
import type { ResultSetHeader } from "mysql2/promise";

const schema = z.object({
  email: emailSchema,
  invite_code: z.string().min(1).max(32),
  password: passwordSchema,
  reg_no: z.string().trim().max(64).optional().nullable(),
});

export const POST = api({ rateLimit: 10, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  const [invites] = await pool.query<Row[]>(
    `SELECT * FROM doctor_invites WHERE email = ? AND status = 'pending'`,
    [body.email],
  );
  const invite = invites[0];
  if (!invite || hashToken(body.invite_code) !== invite.invite_code_hash) {
    throw notFound("INVITE_NOT_FOUND", "Invite not found or invite code is invalid.");
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    await pool.query(`UPDATE doctor_invites SET status = 'expired' WHERE id = ?`, [invite.id]);
    throw new ApiError(410, "INVITE_EXPIRED", "This invite has expired. Contact the clinic for a new one.");
  }

  const doctorId = newId();
  const userId = newId();
  const assignmentId = newId();
  const passwordHash = await hashPassword(body.password);
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

  await withTransaction(async (conn) => {
    const [claim] = await conn.query<ResultSetHeader>(
      `UPDATE doctor_invites SET status = 'accepted'
        WHERE id = ? AND status = 'pending'`,
      [invite.id],
    );
    if (claim.affectedRows !== 1) {
      throw conflict("INVITE_ALREADY_ACCEPTED", "This invite has already been accepted.");
    }

    await conn.query(
      `INSERT INTO users (id, name, email, phone, password_hash, role, status)
       VALUES (?, ?, ?, ?, ?, 'doctor', 'active')`,
      [userId, invite.name, body.email, invite.phone ?? null, passwordHash],
    );
    await conn.query(
      `INSERT INTO doctors (id, user_id, name, specialization, reg_no, phone, certificate_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [doctorId, userId, invite.name, invite.specialization ?? null, body.reg_no ?? null, invite.phone ?? null, invite.certificate_url ?? null],
    );
    await conn.query(
      `INSERT INTO doctor_branch_assignments (id, doctor_id, branch_id, fee_amount, currency, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [assignmentId, doctorId, invite.branch_id, invite.fee_amount, invite.currency],
    );
    for (const t of slotTemplates) {
      const [h, m] = String(t.start_time).split(":");
      const [eh, em] = String(t.end_time).split(":");
      await conn.query(
        `INSERT INTO doctor_slot_templates
           (id, doctor_branch_assignment_id, weekday, start_time, end_time, slot_duration_minutes, effective_from)
         VALUES (?, ?, ?, ?, ?, ?, CURDATE())`,
        [
          newId(),
          assignmentId,
          t.weekday,
          `${h}:${m}:00`,
          `${eh}:${em}:00`,
          t.slot_duration_minutes,
        ],
      );
    }
    await createNotification(conn, invite.invited_by, "doctor_invite_accepted", {
      doctor_id: doctorId,
      branch_id: invite.branch_id,
      email: body.email,
    });
    if (owner && owner.owner_user_id !== invite.invited_by) {
      await createNotification(conn, owner.owner_user_id, "doctor_invite_accepted", {
        doctor_id: doctorId,
        branch_id: invite.branch_id,
        email: body.email,
      });
    }
  }).catch((err) => {
    if (isUniqueViolation(err)) {
      const msg = String((err as { message?: string }).message ?? "");
      if (msg.includes("uniq_doctors_reg_no")) {
        throw conflict("REG_NO_ALREADY_REGISTERED", "A doctor with this registration number already exists.");
      }
      throw conflict("EMAIL_ALREADY_REGISTERED", "An account with this email already exists.");
    }
    throw err;
  });

  if (owner) {
    await sendEmail(
      owner.owner_email,
      "Doctor invite accepted",
      `Dr. ${invite.name} (${body.email}) has accepted your invitation and joined your branch.`,
    );
  }

  const { access_token, refresh_token } = await issueTokens({
    id: userId,
    role: "doctor",
    branchId: null,
    doctorId,
  });

  return json({
    access_token,
    refresh_token,
    doctor: {
      id: doctorId,
      name: invite.name,
      specialization: invite.specialization ?? null,
      reg_no: body.reg_no ?? null,
      phone: invite.phone ?? null,
      certificate_url: invite.certificate_url ?? null,
      photo_url: null,
      bio: null,
    },
  });
});
