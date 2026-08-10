import { pool, withTransaction, type Row } from "@/lib/db";
import {
  hashPassword,
  issueTokens,
  verifyPassword,
  generateVerificationToken,
} from "@/lib/auth";
import { conflict, forbidden, unauthorized, isUniqueViolation } from "@/lib/errors";
import { newId, type Role } from "@/lib/ids";
import { sendEmail } from "@/lib/notifications";

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

async function sendVerificationEmail(userId: string, email: string, name: string): Promise<void> {
  const { raw, hash } = generateVerificationToken();
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  await pool.query(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    [newId(), userId, hash, expiresAt],
  );

  const verifyUrl = process.env.VERIFY_EMAIL_URL ?? "https://medinexa-clinic.onrender.com";
  const link = `${verifyUrl}/verify_email?token=${raw}`;

  await sendEmail(
    email,
    "Welcome to MediNexa — verify your email",
    verificationEmailHtml(link, name),
  );
}

function verificationEmailHtml(link: string, name: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Email</title>
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f7f6; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <h2 style="color: #2c3e50; margin-top: 0;">Verify Your Email Address</h2>
    <p style="color: #555555; line-height: 1.5;">Hi ${name},  Thanks for signing up! Please confirm your email address by clicking the button below.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="${link}" style="background-color: #007bff; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 5px; font-weight: bold; display: inline-block;">Verify Email Address</a>
    </div>
    <p style="color: #777777; font-size: 13px; line-height: 1.5;">If you did not create an account, no further action is required.</p>
    <hr style="border: none; border-top: 1px solid #eeeeee; margin: 20px 0;">
    <p style="color: #999999; font-size: 12px; margin-bottom: 0;">If you're having trouble clicking the button, copy and paste the URL below into your browser:<br><a href="${link}" style="color: #007bff;">${link}</a></p>
  </div>
</body>
</html>`;
}

export interface PublicUser {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  role: Role;
}

export interface PublicClinic {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
}

interface RegisterInput {
  name: string;
  email: string;
  phone?: string | null;
  password: string;
  role: "patient" | "clinic_owner";
}

export async function registerUser(input: RegisterInput) {
  const passwordHash = await hashPassword(input.password);
  const id = newId();
  const status = input.role === "clinic_owner" ? "pending" : "active";
  let clinic: PublicClinic | null = null;
  try {
    await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO users (id, name, email, phone, password_hash, role, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, input.name, input.email, input.phone ?? null, passwordHash, input.role, status],
      );
      if (input.role === "clinic_owner") {
        const clinicId = newId();
        await conn.query(
          `INSERT INTO clinics (id, name, description, owner_user_id)
           VALUES (?, ?, NULL, ?)`,
          [clinicId, input.name, id],
        );
        clinic = {
          id: clinicId,
          name: input.name,
          description: null,
          owner_id: id,
          created_at: new Date().toISOString(),
        };
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("EMAIL_ALREADY_REGISTERED", "An account with this email already exists.");
    }
    throw err;
  }
  const user: PublicUser = {
    id,
    name: input.name,
    email: input.email,
    phone: input.phone ?? null,
    role: input.role,
  };

  if (input.role === "clinic_owner") {
    await sendVerificationEmail(id, input.email, input.name);
    return {
      user,
      access_token: null,
      refresh_token: null,
      clinic,
      message: "Registration successful. Check your email to verify your account before logging in.",
    };
  }

  const { access_token, refresh_token } = await issueTokens({
    id,
    role: input.role,
    branchId: null,
    doctorId: null,
  });
  return { user, access_token, refresh_token, clinic, message: null };
}

export async function loadRoleBindings(userId: string, role: Role): Promise<{
  branchId: string | null;
  doctorId: string | null;
}> {
  let branchId: string | null = null;
  let doctorId: string | null = null;
  if (role === "branch_staff") {
    const [rows] = await pool.query<Row[]>(
      `SELECT branch_id FROM branch_staff WHERE user_id = ?`,
      [userId],
    );
    branchId = rows[0]?.branch_id ?? null;
  }
  if (role === "doctor") {
    const [rows] = await pool.query<Row[]>(
      `SELECT id FROM doctors WHERE user_id = ? AND deleted_at IS NULL`,
      [userId],
    );
    doctorId = rows[0]?.id ?? null;
  }
  return { branchId, doctorId };
}

export async function loginWithPassword(
  email: string,
  password: string,
  role: Role,
): Promise<{ user: PublicUser; access_token: string; refresh_token: string }> {
  const [rows] = await pool.query<Row[]>(`SELECT * FROM users WHERE email = ?`, [email]);
  const user = rows[0];
  if (!user || user.role !== role) {
    throw unauthorized("INVALID_CREDENTIALS", "Invalid email or password.");
  }
  if (user.status === "pending") {
    if (role === "clinic_owner") {
      throw forbidden(
        "EMAIL_NOT_VERIFIED",
        "Please verify your email before logging in. Check your inbox for the verification link.",
      );
    }
    throw forbidden("INVITE_NOT_ACCEPTED", "Your invite has not been accepted yet.");
  }
  if (user.status !== "active") {
    throw unauthorized("ACCOUNT_DISABLED", "This account is disabled.");
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) throw unauthorized("INVALID_CREDENTIALS", "Invalid email or password.");

  const { branchId, doctorId } = await loadRoleBindings(user.id, role);
  const { access_token, refresh_token } = await issueTokens({
    id: user.id,
    role,
    branchId,
    doctorId,
  });
  const pub: PublicUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    role: user.role,
  };
  return { user: pub, access_token, refresh_token };
}
