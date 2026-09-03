import { createConnection } from 'mysql2/promise';
import bcrypt from 'bcryptjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run with: node --env-file=.env scripts/set-clinic-owner-passwords.mjs');
  process.exit(1);
}

// Matches src/lib/validators.ts's passwordSchema (min 8 chars) and the same
// bcrypt cost factor as src/lib/auth.ts's hashPassword (10 rounds), so the
// result is byte-for-byte what the app itself would have produced.
const DEFAULT_PASSWORD = process.env.CLINIC_OWNER_DEFAULT_PASSWORD || 'Clinic@123';

const conn = await createConnection({ uri: url });
try {
  const [rows] = await conn.query(
    `SELECT u.id, u.name, u.phone, c.name AS clinic_name
       FROM users u
       LEFT JOIN clinics c ON c.owner_user_id = u.id AND c.deleted_at IS NULL
      WHERE u.role = 'clinic_owner' AND u.password_hash IS NULL
      ORDER BY u.created_at ASC`,
  );

  if (rows.length === 0) {
    console.log('No clinic_owner accounts without a password. Nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${rows.length} clinic_owner account(s) with no password set:\n`);
  for (const r of rows) {
    console.log(`  ${r.phone}\t${r.clinic_name ?? '(no clinic)'}\t${r.name ?? ''}`);
  }

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  const ids = rows.map((r) => r.id);
  await conn.query(
    `UPDATE users SET password_hash = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
    [passwordHash, ...ids],
  );

  console.log(
    `\nDone. The ${rows.length} account(s) above can now log in via POST /auth/clinic-owner/login-password with:\n` +
      `  password: ${DEFAULT_PASSWORD}\n\n` +
      `They should change it afterwards via POST /auth/set-password.`,
  );
} finally {
  await conn.end();
}
