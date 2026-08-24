#!/usr/bin/env node
/**
 * Bootstrap script: creates (or promotes) a Super Admin account.
 *
 *   node scripts/create-super-admin.mjs <email> <password> [--name "Name"]
 *
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

const [emailArg, passwordArg] = process.argv.slice(2);
const nameFlagIdx = process.argv.indexOf("--name");
const name = nameFlagIdx > -1 ? process.argv[nameFlagIdx + 1] : "Platform Admin";

if (!emailArg || !passwordArg || passwordArg.length < 8) {
  console.error("Usage: node scripts/create-super-admin.mjs <email> <password> [--name \"Name\"]");
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();

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

    const [users] = await conn.query("SELECT id, role, status FROM users WHERE email = ? LIMIT 1", [email]);
    let userId;
    if (users.length > 0) {
      const user = users[0];
      if (user.role !== "sys_admin") {
        throw new Error(`User '${email}' exists with role '${user.role}'. Refusing to change roles automatically.`);
      }
      userId = user.id;
      console.log(`Existing sys_admin user found: ${userId}`);
    } else {
      userId = randomUUID();
      const hash = await bcrypt.hash(passwordArg, 10);
      await conn.query(
        `INSERT INTO users (id, name, email, phone, password_hash, role, status)
         VALUES (?, ?, ?, NULL, ?, 'sys_admin', 'active')`,
        [userId, name, email, hash],
      );
      console.log(`Created sys_admin user: ${userId}`);
    }

    await conn.query(
      `INSERT INTO super_admins (user_id) VALUES (?)
       ON DUPLICATE KEY UPDATE revoked_at = NULL`,
      [userId],
    );

    // Keep the password in sync when the account already existed.
    if (users.length > 0) {
      const hash = await bcrypt.hash(passwordArg, 10);
      await conn.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, userId]);
    }

    await conn.commit();
    console.log(`\nSuper Admin ready:`);
    console.log(`  email:    ${email}`);
    console.log(`  password: ${passwordArg.length >= 8 ? "(set)" : "(too short!)"}`);
    console.log(`\nLogin at POST /api/v1/auth/super-admin/login`);
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
