#!/usr/bin/env node
/**
 * Bootstrap script: creates (or promotes) a Super Admin account.
 *
 *   node scripts/create-super-admin.mjs <phone> <password> [--name "Name"] [--email admin@example.com]
 *
 * - Identified by PHONE, not email — POST /auth/super-admin/login authenticates
 *   with { phone, password } (see loginWithPassword in src/lib/auth-flows.ts),
 *   so the account must have a phone number set to ever be able to log in.
 * - If the user does not exist, a new sys_admin user is created.
 * - If the user exists with a different role, the script aborts (safety).
 * - Grants/refreshes an active row in super_admins either way.
 * Credentials come from .env (DATABASE_URL / JWT_SECRET etc.) via dotenv-style
 * parsing identical to scripts/db-migrate.mjs.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- env loading (same approach as db-migrate.mjs) -------------------------
for (const p of [resolve(__dirname, "../.env.local"), resolve(__dirname, "../.env")]) {
  try {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* file may not exist */
  }
}

// Same normalization POST /auth/*/login endpoints apply via phoneSchema
// (src/lib/validators.ts) — accepts a bare 10-digit mobile or a +91-prefixed
// one, always stores/matches as +91XXXXXXXXXX.
function normalizePhone(raw) {
  const trimmed = (raw ?? "").trim();
  if (!/^(\+91)?[6-9]\d{9}$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  const local = digits.length === 12 ? digits.slice(2) : digits.slice(-10);
  if (!/^[6-9]/.test(local)) return null;
  return `+91${local}`;
}

const [phoneArg, passwordArg] = process.argv.slice(2);
const nameFlagIdx = process.argv.indexOf("--name");
const name = nameFlagIdx > -1 ? process.argv[nameFlagIdx + 1] : "Platform Admin";
const emailFlagIdx = process.argv.indexOf("--email");
const email = emailFlagIdx > -1 ? process.argv[emailFlagIdx + 1].trim().toLowerCase() : null;

if (!phoneArg || !passwordArg || passwordArg.length < 8) {
  console.error(
    'Usage: node scripts/create-super-admin.mjs <phone> <password> [--name "Name"] [--email admin@example.com]',
  );
  console.error("Phone must be a 10-digit Indian mobile number (e.g. 9876543210 or +919876543210).");
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const phone = normalizePhone(phoneArg);
if (!phone) {
  console.error(`Invalid phone number: '${phoneArg}'. Expected a 10-digit Indian mobile number starting 6-9.`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Add it to .env first.");
  process.exit(1);
}

const pool = mysql.createPool({
  uri: databaseUrl,
  waitForConnections: true,
  connectionLimit: 4,
  dateStrings: true,
  timezone: "Z",
  namedPlaceholders: false,
});

async function main() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [users] = await conn.query("SELECT id, role, status FROM users WHERE phone = ? LIMIT 1", [phone]);
    let userId;
    const hash = await bcrypt.hash(passwordArg, 10);

    if (users.length > 0) {
      const user = users[0];
      if (user.role !== "sys_admin") {
        throw new Error(`User with phone '${phone}' exists with role '${user.role}'. Refusing to change roles automatically.`);
      }
      userId = user.id;
      console.log(`Existing sys_admin user found: ${userId}`);
      await conn.query(
        `UPDATE users SET password_hash = ?, status = 'active', email = COALESCE(?, email), name = COALESCE(name, ?) WHERE id = ?`,
        [hash, email, name, userId],
      );
    } else {
      userId = randomUUID();
      await conn.query(
        `INSERT INTO users (id, name, email, phone, phone_verified, password_hash, role, status)
         VALUES (?, ?, ?, ?, 1, ?, 'sys_admin', 'active')`,
        [userId, name, email, phone, hash],
      );
      console.log(`Created sys_admin user: ${userId}`);
    }

    await conn.query(
      `INSERT INTO super_admins (user_id) VALUES (?)
       ON DUPLICATE KEY UPDATE revoked_at = NULL`,
      [userId],
    );

    await conn.commit();
    console.log(`\nSuper Admin ready:`);
    console.log(`  phone:    ${phone}`);
    console.log(`  password: (set)`);
    console.log(`\nLogin at POST /api/v1/auth/super-admin/login with { phone, password }.`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
