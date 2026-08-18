import { pool, withTransaction, type Row } from "@/lib/db";
import {
  hashPassword,
  issueTokens,
  verifyPassword,
  generateVerificationToken,
} from "@/lib/auth";
import { conflict, forbidden, unauthorized, badRequest, isUniqueViolation } from "@/lib/errors";
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

  const verifyUrl = process.env.VERIFY_EMAIL_URL ?? "https://healthcare.jido.co.in";
  const link = `${verifyUrl}/verify_email?token=${raw}`;

  await sendEmail(
    email,
    "Welcome to Jido Healthcare — verify your email",
    `Hi ${name},\n\nWelcome to Jido Healthcare! Please verify your email address to activate your clinic account and log in:\n\n${link}\n\nThis link expires in 24 hours. If you didn't create this account, you can safely ignore this email.`,
  );
}

export interface PublicUser {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  address?: string | null;
  nearby_location?: string | null;
  city?: string | null;
  district?: string | null;
  pin_code?: string | null;
  state?: string | null;
  post_office?: string | null;
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
  clinicName?: string;
  email: string;
  phone?: string | null;
  address?: string | null;
  nearby_location?: string | null;
  city?: string | null;
  district?: string | null;
  pin_code?: string | null;
  state?: string | null;
  post_office?: string | null;
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
        `INSERT INTO users (id, name, email, phone, address, nearby_location, city, district, pin_code, state, post_office, photo_url, password_hash, role, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.email,
          input.phone ?? null,
          input.address ?? null,
          input.nearby_location ?? null,
          input.city ?? null,
          input.district ?? null,
          input.pin_code ?? null,
          input.state ?? null,
          input.post_office ?? null,
          null,
          passwordHash,
          input.role,
          status,
        ],
      );
      if (input.role === "clinic_owner") {
        if (!input.clinicName) {
          throw badRequest("CLINIC_NAME_REQUIRED", "clinicName is required to register a clinic owner.");
        }
        const clinicId = newId();
        const clinicName = input.clinicName;
        await conn.query(
          `INSERT INTO clinics (id, name, description, owner_user_id)
           VALUES (?, ?, NULL, ?)`,
          [clinicId, clinicName, id],
        );
        clinic = {
          id: clinicId,
          name: clinicName,
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
    address: input.address ?? null,
    nearby_location: input.nearby_location ?? null,
    city: input.city ?? null,
    district: input.district ?? null,
    pin_code: input.pin_code ?? null,
    state: input.state ?? null,
    post_office: input.post_office ?? null,
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
