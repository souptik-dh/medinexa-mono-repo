import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody, emailSchema, idSchema } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { badRequest, conflict, isUniqueViolation, notFound, unprocessable } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { generateInviteCode, hashToken } from "@/lib/auth";
import { sendEmail, inviteEmailHtml, branchAccessEmailHtml } from "@/lib/notifications";
import { requireBranchAccess } from "@/lib/permissions";
import { getInviteSpecializations } from "@/lib/specializations";

const slotTemplateSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
    slot_duration_minutes: z.number().int().min(5).max(240),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .array()
  .min(1)
  .refine(
    (arr) => arr.every((s) => s.start_time < s.end_time),
    "start_time must be earlier than end_time.",
  )
  .refine(
    (arr) => arr.every((s) => !s.end_date || s.start_date <= s.end_date),
    "start_date must not be after end_date.",
  );

const createSchema = z
  .object({
    // Picking an existing clinic doctor (see GET /clinics/:clinicId/doctors)
    // identifies them by id and skips the invite process entirely - see the
    // "doctor_id fast-track" below. Otherwise `name`/`email` describe who to
    // invite (or, if they already exist elsewhere in this clinic, who to
    // fast-track by email - see "Same-clinic, different-branch fast-track").
    doctor_id: idSchema.optional(),
    name: z.string().trim().min(1).max(255).optional(),
    specialization_ids: z.array(idSchema).min(1).max(10),
    email: emailSchema.optional(),
    phone: z.string().trim().max(32).optional().nullable(),
    reg_no: z.string().trim().max(64).optional().nullable(),
    smc_name: z.string().trim().max(255).optional().nullable(),
    doctor_degree: z.string().trim().max(100).optional().nullable(),
    fee_amount: z.coerce.number().positive().max(1_000_000),
    currency: z.string().trim().toUpperCase().length(3),
    certificate: z.string().trim().max(500).optional().nullable(),
    slot_type: z.enum(["fixed", "sequential"]).default("fixed"),
    slot_template: slotTemplateSchema,
  })
  .refine((body) => body.doctor_id || (body.name && body.email), {
    message: "Either doctor_id, or both name and email, are required.",
  });

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const branchId = ctx.params.id;
  await requireBranchAccess(pool, auth, branchId, "doctors:manage");
  const [branchRows] = await pool.query<Row[]>(
    `SELECT * FROM branches WHERE id = ? AND deleted_at IS NULL`,
    [branchId],
  );
  const branch = branchRows[0];
  if (!branch) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
  const body = parseBody(createSchema, await readJson(ctx.request));

  const [specializationRows] = await pool.query<Row[]>(
    `SELECT id, name FROM doctor_specializations WHERE id IN (?) AND status = 'active'`,
    [body.specialization_ids],
  );
  if (specializationRows.length !== body.specialization_ids.length) {
    throw unprocessable(
      "SPECIALIZATION_NOT_FOUND",
      "One or more specializations were not found or inactive.",
    );
  }

  // ── Same-clinic, different-branch fast-track ──────────────────────────
  // If the doctor already has an active assignment at any branch of the
  // same clinic - identified either directly by doctor_id (the "add
  // existing doctor" picker, GET /clinics/:clinicId/doctors) or by email
  // match (typed into the regular invite form) - skip the invitation
  // process entirely: create the new branch assignment directly and send
  // an acknowledgement email instead of an invite.
  const clinicId = String(branch.clinic_id);

  const directAssign = async (doctorId: string, doctorName: string, doctorEmail: string) => {
    const [alreadyAssignedToTarget] = await pool.query<Row[]>(
      `SELECT dba.id FROM doctor_branch_assignments dba
        WHERE dba.branch_id = ? AND dba.doctor_id = ? AND dba.is_active = 1`,
      [branchId, doctorId],
    );
    if (alreadyAssignedToTarget[0]) {
      throw conflict("DOCTOR_ALREADY_ASSIGNED", "This doctor is already assigned to this branch.");
    }

    const assignmentId = newId();
    await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO doctor_branch_assignments
           (id, doctor_id, branch_id, fee_amount, currency, is_active, slot_type)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [assignmentId, doctorId, branchId, body.fee_amount, body.currency, body.slot_type],
      );
      for (const slot of body.slot_template) {
        await conn.query(
          `INSERT INTO doctor_slot_templates
             (id, doctor_branch_assignment_id, weekday, start_time, end_time, slot_duration_minutes, start_date, end_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId(), assignmentId, slot.weekday, slot.start_time, slot.end_time, slot.slot_duration_minutes, slot.start_date, slot.end_date ?? null],
        );
      }
    });

    const [clinicRow] = await pool.query<Row[]>(
      `SELECT name FROM clinics WHERE id = ?`,
      [clinicId],
    );
    const clinicName = String(clinicRow[0]?.name ?? "the clinic");

    await sendEmail(
      doctorEmail,
      `Dr. ${doctorName}, you've been added to ${branch.name}`,
      `You have been added to ${branch.name} under ${clinicName}. You can now manage your schedule and appointments at this branch using your existing MediBook account.`,
      branchAccessEmailHtml({
        doctorName,
        branchName: branch.name,
        clinicName,
      }),
    );

    return json(
      {
        type: "direct_assignment" as const,
        id: assignmentId,
        branch_id: branchId,
        email: doctorEmail,
        doctor_id: doctorId,
        specializations: specializationRows.map((r) => ({ id: r.id, name: r.name })),
        status: "active",
      },
      201,
    );
  };

  if (body.doctor_id) {
    const [existingClinicAssignment] = await pool.query<Row[]>(
      `SELECT d.id AS doctor_id, d.name AS doctor_name, u.email
         FROM doctor_branch_assignments dba
         JOIN doctors d ON d.id = dba.doctor_id
         JOIN users u ON u.id = d.user_id
         JOIN branches b ON b.id = dba.branch_id
        WHERE b.clinic_id = ? AND dba.doctor_id = ? AND dba.is_active = 1
        LIMIT 1`,
      [clinicId, body.doctor_id],
    );
    const existingAssignment = existingClinicAssignment[0];
    if (!existingAssignment) {
      throw notFound(
        "DOCTOR_NOT_IN_CLINIC",
        "This doctor does not have an active assignment at this clinic.",
      );
    }
    return directAssign(
      String(existingAssignment.doctor_id),
      String(existingAssignment.doctor_name),
      String(existingAssignment.email),
    );
  }

  // No doctor_id: createSchema's refine guarantees name+email are present,
  // re-asserted here to narrow the types for the rest of this handler.
  if (!body.email || !body.name) {
    throw badRequest("VALIDATION_ERROR", "name and email are required.");
  }

  const [existingClinicAssignment] = await pool.query<Row[]>(
    `SELECT dba.id, dba.doctor_id, d.name AS doctor_name
       FROM doctor_branch_assignments dba
       JOIN doctors d ON d.id = dba.doctor_id
       JOIN users u ON u.id = d.user_id
       JOIN branches b ON b.id = dba.branch_id
      WHERE b.clinic_id = ? AND u.email = ? AND dba.is_active = 1 AND dba.branch_id != ?
      LIMIT 1`,
    [clinicId, body.email, branchId],
  );

  if (existingClinicAssignment[0]) {
    return directAssign(String(existingClinicAssignment[0].doctor_id), body.name, body.email);
  }
  // ── End same-clinic fast-track ────────────────────────────────────────

  const [existing] = await pool.query<Row[]>(
    `SELECT status FROM doctor_invites WHERE branch_id = ? AND email = ? ORDER BY created_at DESC LIMIT 1`,
    [branchId, body.email],
  );
  if (existing[0]) {
    if (existing[0].status === "pending") {
      throw conflict("INVITE_ALREADY_PENDING", "A pending invite already exists for this doctor.");
    }
    if (existing[0].status === "accepted") {
      throw conflict("DOCTOR_ALREADY_ASSIGNED", "This doctor is already assigned to this branch.");
    }
  }

  const [assignments] = await pool.query<Row[]>(
    `SELECT dba.id FROM doctor_branch_assignments dba
       JOIN doctors d ON d.id = dba.doctor_id
       JOIN users u ON u.id = d.user_id
      WHERE dba.branch_id = ? AND u.email = ? AND dba.is_active = 1`,
    [branchId, body.email],
  );
  if (assignments[0]) {
    throw conflict("DOCTOR_ALREADY_ASSIGNED", "This doctor is already assigned to this branch.");
  }

  const inviteCode = generateInviteCode();
  const id = newId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  try {
    await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO doctor_invites
           (id, branch_id, email, name, phone, fee_amount, currency, certificate_url, slot_template, slot_type, invite_code_hash, reg_no, smc_name, doctor_degree, status, invited_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          id,
          branchId,
          body.email,
          body.name,
          body.phone ?? null,
          body.fee_amount,
          body.currency,
          body.certificate ?? null,
          JSON.stringify(body.slot_template),
          body.slot_type,
          hashToken(inviteCode),
          body.reg_no ?? null,
          body.smc_name ?? null,
          body.doctor_degree ?? null,
          auth.userId,
          expiresAt,
        ],
      );
      for (const specializationId of body.specialization_ids) {
        await conn.query(
          `INSERT INTO doctor_invite_specializations (id, doctor_invite_id, specialization_id) VALUES (?, ?, ?)`,
          [newId(), id, specializationId],
        );
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("INVITE_ALREADY_PENDING", "A pending invite already exists for this doctor.");
    }
    throw err;
  }

  const acceptUrlParams = new URLSearchParams({ email: body.email, code: inviteCode });
  if (body.reg_no) acceptUrlParams.set("reg_no", body.reg_no);
  const acceptUrl = `${process.env.APP_URL ?? ""}/doctor/accept-invite?${acceptUrlParams.toString()}`;

  const inviteBody = `You've been invited to join ${branch.name} on MediBook.\n\nAccept your invitation here: ${acceptUrl}\n\nYour one-time invite code is: ${inviteCode}\n\nThis code expires in 7 days.`;
  await sendEmail(
    body.email,
    `Dr. ${body.name}, you've been invited to ${branch.name}`,
    inviteBody,
    inviteEmailHtml({
      heading: "Clinic Join Invitation",
      intro: `You've been invited to join ${branch.name} on MediBook. Use the details below to accept your invitation and complete setup.`,
      code: inviteCode,
      codeLabel: "Your One-Time Invite Code",
      ctaLabel: "Accept Invitation",
      ctaUrl: acceptUrl,
      note: "This invite code and link expire in 7 days.",
    }),
  );

  return json(
    {
      type: "invite" as const,
      id,
      branch_id: branchId,
      email: body.email,
      reg_no: body.reg_no ?? null,
      smc_name: body.smc_name ?? null,
      doctor_degree: body.doctor_degree ?? null,
      specializations: specializationRows.map((r) => ({ id: r.id, name: r.name })),
      status: "pending",
      expires_at: `${expiresAt}Z`.replace(" ", "T"),
    },
    201,
  );
});

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const branchId = ctx.params.id;
  await requireBranchAccess(pool, auth, branchId, "doctors:manage");

  const [rows] = await pool.query<Row[]>(
    `SELECT id, name, email, reg_no, smc_name, doctor_degree, status, expires_at, created_at
       FROM doctor_invites WHERE branch_id = ? ORDER BY created_at DESC`,
    [branchId],
  );
  const specializationsByInvite = await getInviteSpecializations(pool, rows.map((r) => String(r.id)));
  return json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      reg_no: r.reg_no,
      specializations: specializationsByInvite.get(String(r.id)) ?? [],
      smc_name: r.smc_name,
      doctor_degree: r.doctor_degree,
      status: r.status,
      expires_at: r.expires_at,
      created_at: r.created_at,
    })),
  });
});
