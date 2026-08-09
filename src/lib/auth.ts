import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { pool, type Row } from "@/lib/db";
import { ApiError, unauthorized } from "@/lib/errors";
import { newId, type Role } from "@/lib/ids";
import type { NextRequest } from "next/server";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "dev-only-secret-change-me",
);

export interface AuthContext {
  userId: string;
  role: Role;
  email: string;
  branchId: string | null;
  doctorId: string | null;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

export function verifyPassword(pw: string, hash: string | null): Promise<boolean> {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(pw, hash);
}

export function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function generateInviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(48).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

interface TokenUser {
  id: string;
  role: Role;
  branchId: string | null;
  doctorId: string | null;
}

export async function signAccessToken(user: TokenUser): Promise<string> {
  const jwt = await new SignJWT({ role: user.role, typ: "access", bid: user.branchId, did: user.doctorId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(JWT_SECRET);
  return jwt;
}

export async function verifyAccessToken(token: string): Promise<{ sub: string; role: Role } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if (payload.typ !== "access") return null;
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    const role = payload.role as Role;
    if (!sub || !role) return null;
    return { sub, role };
  } catch {
    return null;
  }
}

async function loadUser(userId: string): Promise<(AuthContext & { status: string }) | null> {
  const [rows] = await pool.query<Row[]>(
    `SELECT u.id, u.email, u.role, u.status, bs.branch_id, d.id AS doctor_id
       FROM users u
       LEFT JOIN branch_staff bs ON bs.user_id = u.id
       LEFT JOIN doctors d ON d.user_id = u.id AND d.deleted_at IS NULL
      WHERE u.id = ?`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    branchId: row.branch_id ?? null,
    doctorId: row.doctor_id ?? null,
  };
}

export async function createRefreshTokenRow(
  userId: string,
): Promise<{ refresh_token: string }> {
  const { raw, hash } = generateRefreshToken();
  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND))`,
    [newId(), userId, hash, REFRESH_TTL_SECONDS],
  );
  return { refresh_token: raw };
}

export async function rotateRefreshToken(raw: string): Promise<{ access_token: string; refresh_token: string }> {
  const hash = hashToken(raw);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<Row[]>(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at
         FROM refresh_tokens rt WHERE rt.token_hash = ? FOR UPDATE`,
      [hash],
    );
    const row = rows[0];
    if (!row) throw unauthorized("REFRESH_TOKEN_INVALID", "Refresh token is invalid.");
    if (row.revoked_at) throw unauthorized("REFRESH_TOKEN_INVALID", "Refresh token has been revoked.");
    if (new Date(row.expires_at).getTime() <= Date.now())
      throw unauthorized("REFRESH_TOKEN_INVALID", "Refresh token has expired.");

    const user = await loadUser(row.user_id);
    if (!user || user.status !== "active")
      throw unauthorized("REFRESH_TOKEN_INVALID", "Account is no longer active.");

    const access_token = await signAccessToken({
      id: user.userId,
      role: user.role,
      branchId: user.branchId,
      doctorId: user.doctorId,
    });

    const { raw: newRaw, hash: newHash } = generateRefreshToken();
    const newTokenId = newId();
    await conn.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND))`,
      [newTokenId, row.user_id, newHash, REFRESH_TTL_SECONDS],
    );
    await conn.query(
      `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3), replaced_by = ? WHERE id = ?`,
      [newTokenId, row.id],
    );
    await conn.commit();
    return { access_token, refresh_token: newRaw };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  const hash = hashToken(raw);
  await pool.query(`UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ?`, [hash]);
}

export async function issueTokens(
  user: TokenUser,
): Promise<{ access_token: string; refresh_token: string }> {
  const access_token = await signAccessToken(user);
  const { refresh_token } = await createRefreshTokenRow(user.id);
  return { access_token, refresh_token };
}

export async function parseAuthContext(request: NextRequest): Promise<AuthContext | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  const payload = await verifyAccessToken(token);
  if (!payload) return null;
  const user = await loadUser(payload.sub);
  if (!user || user.status !== "active") return null;
  return {
    userId: user.userId,
    role: user.role,
    email: user.email,
    branchId: user.branchId,
    doctorId: user.doctorId,
  };
}

export function requireRoles(auth: AuthContext | null, roles: Role[]): AuthContext {
  if (!auth) throw unauthorized();
  if (!roles.includes(auth.role)) {
    if (auth.role === "sys_admin") return auth;
    throw new ApiError(403, "INSUFFICIENT_ROLE", "You do not have permission to perform this action.");
  }
  return auth;
}
