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

  const [photoCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctors' AND COLUMN_NAME = 'photo_url'`,
  );
  if (Number(photoCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE doctors
         ADD COLUMN photo_url VARCHAR(500) NULL AFTER certificate_url`,
    );
    console.log('Applied migration: doctors.photo_url');
  }

  const [staffPermCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branch_staff' AND COLUMN_NAME = 'permissions_json'`,
  );
  if (Number(staffPermCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE branch_staff ADD COLUMN permissions_json JSON NULL AFTER added_by`,
    );
    console.log('Applied migration: branch_staff.permissions_json');
  }

  const [galleryTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branch_gallery_images'`,
  );
  if (Number(galleryTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE branch_gallery_images (
        id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        public_id VARCHAR(255) NOT NULL,
        image_url VARCHAR(500) NOT NULL,
        position INT NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_gallery_public_id (branch_id, public_id),
        KEY idx_gallery_branch (branch_id, position),
        CONSTRAINT fk_gallery_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: branch_gallery_images table');
  }

  const [clinicLicenseCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinics' AND COLUMN_NAME = 'trade_license_number'`,
  );
  if (Number(clinicLicenseCols[0].cnt) === 0) {
    await conn.query(`
      ALTER TABLE clinics
        ADD COLUMN trade_license_number VARCHAR(100) NULL AFTER owner_user_id,
        ADD COLUMN trade_license_url VARCHAR(500) NULL AFTER trade_license_number,
        ADD COLUMN drug_license_number VARCHAR(100) NULL AFTER trade_license_url,
        ADD COLUMN drug_license_url VARCHAR(500) NULL AFTER drug_license_number,
        ADD COLUMN clinical_establishment_reg_number VARCHAR(100) NULL AFTER drug_license_url,
        ADD COLUMN clinical_establishment_reg_url VARCHAR(500) NULL AFTER clinical_establishment_reg_number
    `);
    console.log('Applied migration: clinics licenses');
  }

  const [branchLicenseCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND COLUMN_NAME = 'trade_license_number'`,
  );
  if (Number(branchLicenseCols[0].cnt) === 0) {
    await conn.query(`
      ALTER TABLE branches
        ADD COLUMN trade_license_number VARCHAR(100) NULL AFTER photo_url,
        ADD COLUMN trade_license_url VARCHAR(500) NULL AFTER trade_license_number,
        ADD COLUMN drug_license_number VARCHAR(100) NULL AFTER trade_license_url,
        ADD COLUMN drug_license_url VARCHAR(500) NULL AFTER drug_license_number,
        ADD COLUMN clinical_establishment_reg_number VARCHAR(100) NULL AFTER drug_license_url,
        ADD COLUMN clinical_establishment_reg_url VARCHAR(500) NULL AFTER clinical_establishment_reg_number
    `);
    console.log('Applied migration: branches licenses');
  }

  const [userAddressCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'address'`,
  );
  if (Number(userAddressCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE users
         ADD COLUMN address VARCHAR(500) NULL AFTER phone,
         ADD COLUMN photo_url VARCHAR(500) NULL AFTER address`,
    );
    console.log('Applied migration: users address/photo_url');
  }

  console.log('Schema applied successfully.');
} finally {
  await conn.end();
}
