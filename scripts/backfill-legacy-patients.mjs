// One-time data repair for appointment_patients/lab_test_appointment_patients rows
// that predate patient_id: resolves each row's real patient the same way a live
// booking does (phone lookup, creating a lightweight patient account if none exists),
// so historical walk-ins show up correctly in the patient-list endpoints instead of
// being excluded as "unresolvable." Safe to re-run — only touches rows still missing
// patient_id, and reuses one new account per phone number seen in a run.
import { createConnection } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run with: node --env-file=.env scripts/backfill-legacy-patients.mjs');
  process.exit(1);
}

const conn = await createConnection({ uri: url });

// Mirrors src/lib/validators.ts's phoneSchema — legacy rows predate that
// normalization, so the same raw number can appear as both "8981284366" and
// "+918981284366" and must be treated as one phone for matching purposes.
function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  const local = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(local) ? `+91${local}` : null;
}

async function resolvePatientByPhone(phoneCache, createdIds, rawPhone, name, gender) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  if (phoneCache.has(phone)) return phoneCache.get(phone);
  const [existing] = await conn.query(
    `SELECT id FROM users WHERE phone = ? AND role = 'patient' LIMIT 1`,
    [phone],
  );
  if (existing[0]) {
    phoneCache.set(phone, existing[0].id);
    return existing[0].id;
  }
  const id = randomUUID();
  try {
    await conn.query(
      `INSERT INTO users (id, name, phone, gender, role, status) VALUES (?, ?, ?, ?, 'patient', 'active')`,
      [id, name, phone, gender ?? null],
    );
    phoneCache.set(phone, id);
    createdIds.add(id);
    return id;
  } catch (err) {
    if (err?.code !== 'ER_DUP_ENTRY') throw err;
    // Raced with another row in this same run creating the same phone, or the phone
    // already belongs to a non-patient account (staff/doctor/owner) — either way,
    // re-check for a patient match; if still none, this phone can't be linked.
    const [retry] = await conn.query(
      `SELECT id FROM users WHERE phone = ? AND role = 'patient' LIMIT 1`,
      [phone],
    );
    if (retry[0]) {
      phoneCache.set(phone, retry[0].id);
      return retry[0].id;
    }
    return null;
  }
}

const TABLES = ['appointment_patients', 'lab_test_appointment_patients'];

for (const table of TABLES) {
  if (!TABLES.includes(table)) throw new Error('unreachable');
  const [rows] = await conn.query(
    `SELECT id, name, phone, gender FROM \`${table}\` WHERE patient_id IS NULL AND phone IS NOT NULL AND phone != ''`,
  );
  const phoneCache = new Map();
  const createdIds = new Set();
  const linkedIds = new Set();
  let linked = 0;
  let skipped = 0;
  for (const row of rows) {
    const patientId = await resolvePatientByPhone(phoneCache, createdIds, row.phone, row.name, row.gender);
    if (!patientId) {
      skipped++;
      const reason = normalizePhone(row.phone)
        ? "phone already registered under a non-patient account"
        : "not a valid Indian mobile number";
      console.warn(`  skipped: ${row.phone} (${row.name}) — ${reason}`);
      continue;
    }
    await conn.query(`UPDATE \`${table}\` SET patient_id = ? WHERE id = ?`, [patientId, row.id]);
    linked++;
    linkedIds.add(patientId);
  }
  console.log(
    `${table}: ${rows.length} candidate rows, ${linked} linked across ${linkedIds.size} distinct patients ` +
      `(${createdIds.size} new patient accounts created), ${skipped} skipped.`,
  );
}

await conn.end();
