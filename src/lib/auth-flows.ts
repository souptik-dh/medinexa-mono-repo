import { pool, withTransaction, parseDbTimestamp, type Row } from "@/lib/db";
import {
  hashPassword,
  issueTokens,
  verifyPassword,
  generateVerificationToken,
  generateOtp,
  hashToken,
} from "@/lib/auth";
import { conflict, forbidden, unauthorized, badRequest, isUniqueViolation, ApiError } from "@/lib/errors";
import { newId, type Role } from "@/lib/ids";
import { sendEmail, emailHtml, sendOtpDual } from "@/lib/notifications";
import { ensureClinicSubscription } from "@/lib/subscriptions";

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

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

  const verifyBody = `Hi ${name},\n\nWelcome to Jido Healthcare! Please verify your email address to activate your clinic account and log in:\n\n${link}\n\nThis link expires in 24 hours. If you didn't create this account, you can safely ignore this email.`;
  await sendEmail(
    email,
    "Welcome to Jido Healthcare — verify your email",
    verifyBody,
    emailHtml(verifyBody),
  );
}

export interface PublicUser {
  id: string;
  name: string | null;
  email: string | null;
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

export type OtpPurpose =
  | "branch_staff_login"
  | "patient_login"
  | "clinic_owner_login"
  | "doctor_login"
  | "phone_verification";

export type OtpResult =
  | { ok: true; message?: string; otp?: string; expires_at?: string }
  | { ok: false; message: string };

/**
 * Generates and sends a one-time password to a user's phone (SMS) and email
 * (dual channel). Unsigned — the OTP is stored hashed and keyed by phone.
 * Returns a generic message so this cannot be used to enumerate users.
 */
export async function sendPhoneOtp(opts: {
  phone: string;
  email?: string | null;
  purpose: OtpPurpose;
}): Promise<OtpResult> {
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  await pool.query(
    `INSERT INTO otp_codes (id, phone, email, purpose, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), opts.phone, opts.email ?? null, opts.purpose, hashToken(`${opts.phone}:${otp}`), expiresAt],
  );
  await sendOtpDual({
    phone: opts.phone,
    email: opts.email,
    otp,
    expiryMinutes: OTP_TTL_MS / 60_000,
  });
  return {
    ok: true,
    message: "If an account exists for this phone number, an OTP has been sent.",
    // TEMP: exposed in the API response for local testing only — remove before production.
    otp,
    expires_at: expiresAt,
  };
}

/**
 * Loads the OTP code specifically for a phone + purpose, following the same
 * attempt/expiry semantics as the existing branch-staff flow.
 */
async function fetchPendingOtp(phone: string, purpose: string): Promise<Row | null> {
  const [codes] = await pool.query<Row[]>(
    `SELECT * FROM otp_codes
      WHERE phone = ? AND purpose = ? AND verified_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [phone, purpose],
  );
  return codes[0] ?? null;
}

/**
 * Verifies a phone+OTP pair, marks the code used, and issues tokens for the
 * matching user. Used for login across all roles.
 */
export async function verifyPhoneOtpAndLogin(opts: {
  phone: string;
  otp: string;
  role: Role;
  purpose: OtpPurpose;
}): Promise<{ user: PublicUser; access_token: string; refresh_token: string; requires_password_setup: boolean }> {
  const code = await fetchPendingOtp(opts.phone, opts.purpose);
  if (!code) throw unauthorized("INVALID_OTP", "No pending OTP found for this phone number.");

  const expired = parseDbTimestamp(code.expires_at).getTime() < Date.now();
  const attempts = Number(code.attempts);
  if (attempts >= OTP_MAX_ATTEMPTS) {
    throw unauthorized("OTP_MAX_ATTEMPTS", "Too many failed attempts. Request a new OTP.");
  }
  if (expired) {
    await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);
    throw new ApiError(410, "OTP_EXPIRED", "This OTP has expired. Request a new one.");
  }
  if (hashToken(`${opts.phone}:${opts.otp}`) !== code.code_hash) {
    await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [code.id]);
    throw unauthorized("INVALID_OTP", "Incorrect OTP. Please try again.");
  }
  await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);

  const [users] = await pool.query<Row[]>(
    `SELECT * FROM users WHERE phone = ? AND role = ? AND status = 'active'`,
    [opts.phone, opts.role],
  );
  const user = users[0];
  if (!user) throw unauthorized("ACCOUNT_NOT_FOUND", "No active account found for this phone number.");

  const { branchId, doctorId } = await loadRoleBindings(user.id, opts.role);
  const { access_token, refresh_token } = await issueTokens({
    id: user.id,
    role: opts.role,
    branchId,
    doctorId,
  });
  const pub: PublicUser = {
    id: user.id,
    name: user.name,
    email: user.email ?? null,
    phone: user.phone ?? null,
    role: user.role,
  };
  return {
    user: pub,
    access_token,
    refresh_token,
    requires_password_setup: !user.password_hash,
  };
}

/**
 * Verifies a phone+OTP pair and marks the phone as verified on the given user.
 * Used when a user adds/changes their phone number (phone_verification purpose).
 */
export async function verifyPhoneOnly(opts: {
  phone: string;
  otp: string;
  userId: string;
}): Promise<void> {
  const code = await fetchPendingOtp(opts.phone, "phone_verification");
  if (!code) throw unauthorized("INVALID_OTP", "No pending OTP found for this phone number.");
  const expired = parseDbTimestamp(code.expires_at).getTime() < Date.now();
  if (Number(code.attempts) >= OTP_MAX_ATTEMPTS) {
    throw unauthorized("OTP_MAX_ATTEMPTS", "Too many failed attempts. Request a new OTP.");
  }
  if (expired) {
    throw new ApiError(410, "OTP_EXPIRED", "This OTP has expired. Request a new one.");
  }
  if (hashToken(`${opts.phone}:${opts.otp}`) !== code.code_hash) {
    await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [code.id]);
    throw unauthorized("INVALID_OTP", "Incorrect OTP. Please try again.");
  }
  await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);
  await pool.query(
    `UPDATE users SET phone = ?, phone_verified = 1 WHERE id = ?`,
    [opts.phone, opts.userId],
  );
}

/**
 * Verifies a phone+OTP pair that was issued with any of the given purposes
 * (registration OTPs are sent via the 'phone_verification' purpose, but an
 * unused login OTP is also acceptable). Pre-registration there is no account
 * yet, so this only marks the code used — it does not issue tokens or touch
 * the users table.
 */
export async function verifyRegistrationOtp(opts: {
  phone: string;
  otp: string;
  purposes: OtpPurpose[];
}): Promise<OtpResult> {
  const [codes] = await pool.query<Row[]>(
    `SELECT * FROM otp_codes
      WHERE phone = ? AND purpose IN (?) AND verified_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [opts.phone, opts.purposes],
  );
  const code = codes[0];
  if (!code) return { ok: false, message: "No pending OTP found for this phone number." };
  if (Number(code.attempts) >= OTP_MAX_ATTEMPTS) {
    return { ok: false, message: "Too many failed attempts. Request a new OTP." };
  }
  if (parseDbTimestamp(code.expires_at).getTime() < Date.now()) {
    return { ok: false, message: "This OTP has expired. Request a new one." };
  }
  if (hashToken(`${opts.phone}:${opts.otp}`) !== code.code_hash) {
    await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [code.id]);
    return { ok: false, message: "Incorrect OTP. Please try again." };
  }
  await pool.query(`UPDATE otp_codes SET verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [code.id]);
  return { ok: true };
}

interface RegisterInput {
  name: string;
  clinicName?: string;
  email?: string | null;
  phone: string;
  address?: string | null;
  nearby_location?: string | null;
  city?: string | null;
  district?: string | null;
  pin_code?: string | null;
  state?: string | null;
  post_office?: string | null;
  password?: string | null;
  role: "patient" | "clinic_owner";
  phoneVerified?: boolean;
}

export async function registerUser(input: RegisterInput, verified: boolean) {
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const id = newId();
  const status = input.role === "clinic_owner" && !verified ? "pending" : "active";
  let clinic: PublicClinic | null = null;
  try {
    await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO users (id, name, email, phone, phone_verified, address, nearby_location, city, district, pin_code, state, post_office, photo_url, password_hash, role, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.email ?? null,
          input.phone,
          verified ? 1 : 0,
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
        // Every new clinic starts with the configured free trial (default 2 months),
        // anchored at the clinic's creation date.
        await ensureClinicSubscription(conn, clinicId);
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
      const msg = String((err as { message?: string }).message ?? "");
      if (msg.includes("uniq_users_phone")) {
        throw conflict("PHONE_ALREADY_REGISTERED", "An account with this phone number already exists.");
      }
      if (msg.includes("email")) {
        throw conflict("EMAIL_ALREADY_REGISTERED", "An account with this email already exists.");
      }
    }
    throw err;
  }
  const user: PublicUser = {
    id,
    name: input.name,
    email: input.email ?? null,
    phone: input.phone,
    address: input.address ?? null,
    nearby_location: input.nearby_location ?? null,
    city: input.city ?? null,
    district: input.district ?? null,
    pin_code: input.pin_code ?? null,
    state: input.state ?? null,
    post_office: input.post_office ?? null,
    role: input.role,
  };

  if (status === "pending") {
    if (input.email) {
      await sendVerificationEmail(id, input.email, input.name);
    }
    return {
      user,
      access_token: null,
      refresh_token: null,
      clinic,
      message: "Registration successful. Verify your phone with the OTP to activate your account.",
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
  phone: string,
  password: string,
  role: Role,
): Promise<{ user: PublicUser; access_token: string; refresh_token: string }> {
  const [rows] = await pool.query<Row[]>(`SELECT * FROM users WHERE phone = ?`, [phone]);
  const user = rows[0];
  if (!user || user.role !== role) {
    throw unauthorized("INVALID_CREDENTIALS", "Invalid phone number or password.");
  }
  if (user.status === "pending") {
    if (role === "clinic_owner") {
      throw forbidden(
        "PHONE_NOT_VERIFIED",
        "Please verify your phone number before logging in. Check your phone for the OTP.",
      );
    }
    throw forbidden("INVITE_NOT_ACCEPTED", "Your invite has not been accepted yet.");
  }
  if (user.status !== "active") {
    throw unauthorized("ACCOUNT_DISABLED", "This account is disabled.");
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) throw unauthorized("INVALID_CREDENTIALS", "Invalid phone number or password.");

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
    email: user.email ?? null,
    phone: user.phone ?? null,
    role: user.role,
  };
  return { user: pub, access_token, refresh_token };
}
