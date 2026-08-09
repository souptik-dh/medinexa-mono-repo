import { pool, withTransaction, type Row } from "@/lib/db";
import {
  hashPassword,
  issueTokens,
  verifyPassword,
} from "@/lib/auth";
import { conflict, forbidden, unauthorized, isUniqueViolation } from "@/lib/errors";
import { newId, type Role } from "@/lib/ids";

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
  let clinic: PublicClinic | null = null;
  try {
    await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO users (id, name, email, phone, password_hash, role)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, input.name, input.email, input.phone ?? null, passwordHash, input.role],
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
  const { access_token, refresh_token } = await issueTokens({
    id,
    role: input.role,
    branchId: null,
    doctorId: null,
  });
  const user: PublicUser = {
    id,
    name: input.name,
    email: input.email,
    phone: input.phone ?? null,
    role: input.role,
  };
  return { user, access_token, refresh_token, clinic };
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
