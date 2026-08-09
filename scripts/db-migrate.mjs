import { readFile } from 'node:fs/promises';
import { createConnection } from 'mysql2/promise';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run with: node --env-file=.env scripts/db-migrate.mjs');
  process.exit(1);
}

const schema = await readFile(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
const conn = await createConnection({ uri: url, multipleStatements: true });
try {
  await conn.query(schema);

  const [cols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctors' AND COLUMN_NAME = 'reg_no'`,
  );
  if (Number(cols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE doctors
         ADD COLUMN reg_no VARCHAR(64) NULL AFTER specialization,
         ADD UNIQUE KEY uniq_doctors_reg_no (reg_no)`,
    );
    console.log('Applied migration: doctors.reg_no');
  }

  console.log('Schema applied successfully.');
} finally {
  await conn.end();
}
