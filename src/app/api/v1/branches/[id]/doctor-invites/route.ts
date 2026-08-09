import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody, emailSchema } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { conflict, isUniqueViolation } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { generateInviteCode, hashToken } from "@/lib/auth";
import { sendEmail } from "@/lib/notifications";

const slotTemplateSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
    slot_duration_minutes: z.number().int().min(5).max(240),
  })
  .array()
  .min(1)
  .refine(
    (arr) => arr.every((s) => s.start_time < s.end_time),
    "start_time must be earlier than end_time.",
  );

const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  specialization: z.string().trim().max(255).optional().nullable(),
  email: emailSchema,
  phone: z.string().trim().max(32).optional().nullable(),
  fee_amount: z.coerce.number().positive().max(1_000_000),
  currency: z.string().trim().toUpperCase().length(3),
  certificate: z.string().trim().max(500).optional().nullable(),
  slot_template: slotTemplateSchema,
});

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const branchId = ctx.params.id;
  const branch = await getOwnedBranch(pool, branchId, auth.userId);
  const body = parseBody(createSchema, await readJson(ctx.request));

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
    await pool.query(
      `INSERT INTO doctor_invites
         (id, branch_id, email, name, specialization, phone, fee_amount, currency, certificate_url, slot_template, invite_code_hash, status, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        id,
        branchId,
        body.email,
        body.name,
        body.specialization ?? null,
        body.phone ?? null,
        body.fee_amount,
        body.currency,
        body.certificate ?? null,
        JSON.stringify(body.slot_template),
        hashToken(inviteCode),
        auth.userId,
        expiresAt,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("INVITE_ALREADY_PENDING", "A pending invite already exists for this doctor.");
    }
    throw err;
  }

  const acceptUrl = `${process.env.APP_URL ?? ""}/api/v1/auth/doctor/accept-invite`;

  await sendEmail(
    body.email,
    `Dr. ${body.name}, you've been invited to ${branch.name}`,
    `Use this one-time invite code to set up your MediBook account: ${inviteCode}\n\nAccept your invitation here: ${acceptUrl}\n\nSend a POST request to ${acceptUrl} with your email, this code, and a password. The code expires in 7 days.`,
  );

  return json(
    {
      id,
      branch_id: branchId,
      email: body.email,
      status: "pending",
      expires_at: `${expiresAt}Z`.replace(" ", "T"),
    },
    201,
  );
});

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const branchId = ctx.params.id;
  await getOwnedBranch(pool, branchId, auth.userId);

  const [rows] = await pool.query<Row[]>(
    `SELECT id, name, email, status, expires_at, created_at
       FROM doctor_invites WHERE branch_id = ? ORDER BY created_at DESC`,
    [branchId],
  );
  return json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      status: r.status,
      expires_at: r.expires_at,
      created_at: r.created_at,
    })),
  });
});
