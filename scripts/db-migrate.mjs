import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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

  const [inviteRegNoCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_invites' AND COLUMN_NAME = 'reg_no'`,
  );
  if (Number(inviteRegNoCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE doctor_invites ADD COLUMN reg_no VARCHAR(64) NULL AFTER invite_code_hash`,
    );
    console.log('Applied migration: doctor_invites.reg_no');
  }

  const [doctorSmcCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctors' AND COLUMN_NAME = 'smc_name'`,
  );
  if (Number(doctorSmcCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE doctors
         ADD COLUMN smc_name VARCHAR(255) NULL AFTER reg_no,
         ADD COLUMN doctor_degree VARCHAR(100) NULL AFTER smc_name`,
    );
    console.log('Applied migration: doctors.smc_name, doctors.doctor_degree');
  }

  const [inviteSmcCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_invites' AND COLUMN_NAME = 'smc_name'`,
  );
  if (Number(inviteSmcCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE doctor_invites
         ADD COLUMN smc_name VARCHAR(255) NULL AFTER reg_no,
         ADD COLUMN doctor_degree VARCHAR(100) NULL AFTER smc_name`,
    );
    console.log('Applied migration: doctor_invites.smc_name, doctor_invites.doctor_degree');
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

  const [tradeLicenseValidationCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinics' AND COLUMN_NAME = 'trade_license_validated'`,
  );
  if (Number(tradeLicenseValidationCols[0].cnt) === 0) {
    await conn.query(`
      ALTER TABLE clinics
        ADD COLUMN trade_license_validated TINYINT(1) NOT NULL DEFAULT 0 AFTER trade_license_url,
        ADD COLUMN trade_license_validation_status ENUM('PENDING','VALID','INVALID') NOT NULL DEFAULT 'PENDING' AFTER trade_license_validated,
        ADD COLUMN trade_license_validated_at DATETIME(3) NULL AFTER trade_license_validation_status
    `);
    console.log('Applied migration: clinics.trade_license_validated/validation_status/validated_at');
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

  const [userLocationCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'nearby_location'`,
  );
  if (Number(userLocationCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE users
         ADD COLUMN nearby_location VARCHAR(500) NULL AFTER address,
         ADD COLUMN city VARCHAR(255) NULL AFTER nearby_location,
         ADD COLUMN district VARCHAR(255) NULL AFTER city,
         ADD COLUMN pin_code VARCHAR(20) NULL AFTER district,
         ADD COLUMN state VARCHAR(255) NULL AFTER pin_code,
         ADD COLUMN post_office VARCHAR(255) NULL AFTER state`,
    );
    console.log('Applied migration: users nearby_location/city/district/pin_code/state/post_office');
  }

  const [resetTokenTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_reset_tokens'`,
  );
  if (Number(resetTokenTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE password_reset_tokens (
        id CHAR(36) NOT NULL,
        user_id CHAR(36) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        used_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_reset_token_hash (token_hash),
        KEY idx_reset_user (user_id),
        CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: password_reset_tokens table');
  }

  const [verifyTokenTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_verification_tokens'`,
  );
  if (Number(verifyTokenTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE email_verification_tokens (
        id CHAR(36) NOT NULL,
        user_id CHAR(36) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        used_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_verify_token_hash (token_hash),
        KEY idx_verify_user (user_id),
        CONSTRAINT fk_verify_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: email_verification_tokens table');
  }

  const [ledgerTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinic_payment_ledger'`,
  );
  if (Number(ledgerTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE clinic_payment_ledger (
        id CHAR(36) NOT NULL,
        clinic_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        period_month CHAR(7) NOT NULL,
        currency CHAR(3) NOT NULL,
        total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        payment_count INT NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_ledger_period (clinic_id, branch_id, period_month, currency),
        KEY idx_ledger_clinic_period (clinic_id, period_month),
        CONSTRAINT fk_ledger_clinic FOREIGN KEY (clinic_id) REFERENCES clinics(id),
        CONSTRAINT fk_ledger_branch FOREIGN KEY (branch_id) REFERENCES branches(id)
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: clinic_payment_ledger table');
  }

  const [timeOffTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_time_offs'`,
  );
  if (Number(timeOffTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE doctor_time_offs (
        id CHAR(36) NOT NULL,
        doctor_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        reason VARCHAR(255) NULL,
        starts_at DATETIME(3) NOT NULL,
        ends_at DATETIME(3) NOT NULL,
        created_by CHAR(36) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_timeoff_doctor (doctor_id, starts_at),
        KEY idx_timeoff_branch (branch_id),
        CONSTRAINT fk_timeoff_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
        CONSTRAINT fk_timeoff_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
        CONSTRAINT fk_timeoff_created_by FOREIGN KEY (created_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: doctor_time_offs table');
  }

  const [waitlistTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'appointment_waitlist'`,
  );
  if (Number(waitlistTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE appointment_waitlist (
        id CHAR(36) NOT NULL,
        patient_id CHAR(36) NOT NULL,
        doctor_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        scheduled_date DATE NOT NULL,
        preferred_time VARCHAR(5) NULL,
        status ENUM('waiting','notified','booked','cancelled','expired') NOT NULL DEFAULT 'waiting',
        notified_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_waitlist_pending (patient_id, doctor_id, scheduled_date, status),
        KEY idx_waitlist_doctor_date (doctor_id, scheduled_date),
        KEY idx_waitlist_branch (branch_id),
        CONSTRAINT fk_waitlist_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_waitlist_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
        CONSTRAINT fk_waitlist_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: appointment_waitlist table');
  }

  const [refundTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refunds'`,
  );
  if (Number(refundTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE refunds (
        id CHAR(36) NOT NULL,
        appointment_id CHAR(36) NOT NULL,
        payment_id CHAR(36) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency CHAR(3) NOT NULL DEFAULT 'INR',
        reason VARCHAR(500) NULL,
        status ENUM('pending','processed','failed') NOT NULL DEFAULT 'pending',
        processed_by CHAR(36) NULL,
        processed_at DATETIME(3) NULL,
        reference_no VARCHAR(255) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_refund_appt (appointment_id),
        KEY idx_refund_payment (payment_id),
        CONSTRAINT fk_refund_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
        CONSTRAINT fk_refund_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
        CONSTRAINT fk_refund_processed_by FOREIGN KEY (processed_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: refunds table');
  }

  const [reviewTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reviews'`,
  );
  if (Number(reviewTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE reviews (
        id CHAR(36) NOT NULL,
        patient_id CHAR(36) NOT NULL,
        doctor_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        appointment_id CHAR(36) NULL,
        rating TINYINT NOT NULL,
        comment TEXT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_review_patient_doctor (patient_id, doctor_id),
        KEY idx_review_doctor (doctor_id),
        KEY idx_review_branch (branch_id),
        CONSTRAINT fk_review_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_review_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
        CONSTRAINT fk_review_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
        CONSTRAINT fk_review_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
        CONSTRAINT chk_review_rating CHECK (rating BETWEEN 1 AND 5)
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: reviews table');
  }

  const [auditLogTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs'`,
  );
  if (Number(auditLogTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE audit_logs (
        id CHAR(36) NOT NULL,
        actor_user_id CHAR(36) NULL,
        action VARCHAR(100) NOT NULL,
        resource_type VARCHAR(50) NOT NULL,
        resource_id CHAR(36) NULL,
        changes_json JSON NULL,
        ip_address VARCHAR(45) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_audit_actor (actor_user_id, created_at),
        KEY idx_audit_resource (resource_type, resource_id),
        CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: audit_logs table');
  }

  const [deviceTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_devices'`,
  );
  if (Number(deviceTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE patient_devices (
        id CHAR(36) NOT NULL,
        patient_id CHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(40) NOT NULL,
        brand VARCHAR(100) NULL,
        model VARCHAR(100) NULL,
        serial_number VARCHAR(100) NULL,
        notes VARCHAR(1000) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_patient_devices_patient (patient_id),
        CONSTRAINT fk_patient_devices_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: patient_devices table');
  }

  const [userNameCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'first_name'`,
  );
  if (Number(userNameCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE users
         ADD COLUMN first_name VARCHAR(150) NULL AFTER name,
         ADD COLUMN last_name VARCHAR(150) NULL AFTER first_name,
         ADD COLUMN date_of_birth DATE NULL AFTER phone,
         ADD COLUMN gender ENUM('male','female','other','prefer_not_to_say') NULL AFTER date_of_birth`,
    );
    console.log('Applied migration: users first_name/last_name/date_of_birth/gender');
  }

  const [userPreferredCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'preferred_clinic_id'`,
  );
  if (Number(userPreferredCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE users
         ADD COLUMN preferred_clinic_id CHAR(36) NULL AFTER push_topic,
         ADD COLUMN preferred_branch_id CHAR(36) NULL AFTER preferred_clinic_id,
         ADD KEY idx_users_preferred_clinic (preferred_clinic_id),
         ADD KEY idx_users_preferred_branch (preferred_branch_id)`,
    );
    console.log('Applied migration: users preferred_clinic_id/preferred_branch_id');
  }

  const [userPreferredClinicFk] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND CONSTRAINT_NAME = 'fk_users_preferred_clinic'`,
  );
  if (Number(userPreferredClinicFk[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE users
         ADD CONSTRAINT fk_users_preferred_clinic FOREIGN KEY (preferred_clinic_id) REFERENCES clinics(id) ON DELETE SET NULL,
         ADD CONSTRAINT fk_users_preferred_branch FOREIGN KEY (preferred_branch_id) REFERENCES branches(id) ON DELETE SET NULL`,
    );
    console.log('Applied migration: users preferred_clinic/branch foreign keys');
  }

  const [meddocCategoryCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medical_documents' AND COLUMN_NAME = 'category'`,
  );
  if (Number(meddocCategoryCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE medical_documents
         ADD COLUMN category ENUM('prescription','lab_report','doctor_note','other') NOT NULL DEFAULT 'other' AFTER patient_id,
         ADD KEY idx_meddoc_patient_category (patient_id, category)`,
    );
    console.log('Applied migration: medical_documents.category');
  }

  const [verifyNewEmailCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_verification_tokens' AND COLUMN_NAME = 'new_email'`,
  );
  if (Number(verifyNewEmailCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE email_verification_tokens ADD COLUMN new_email VARCHAR(255) NULL AFTER token_hash`,
    );
    console.log('Applied migration: email_verification_tokens.new_email');
  }

  const [medicalProfileTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_medical_profile'`,
  );
  if (Number(medicalProfileTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE patient_medical_profile (
        patient_id CHAR(36) NOT NULL,
        blood_group ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown') NULL,
        allergies TEXT NULL,
        medical_conditions TEXT NULL,
        current_medications TEXT NULL,
        previous_surgeries TEXT NULL,
        medical_notes TEXT NULL,
        emergency_contact_name VARCHAR(255) NULL,
        emergency_contact_relationship VARCHAR(100) NULL,
        emergency_contact_phone VARCHAR(32) NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (patient_id),
        CONSTRAINT fk_patient_medical_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: patient_medical_profile table');
  }

  const [assignmentSlotTypeCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_branch_assignments' AND COLUMN_NAME = 'slot_type'`,
  );
  if (Number(assignmentSlotTypeCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE doctor_branch_assignments
         ADD COLUMN slot_type ENUM('fixed','sequential') NOT NULL DEFAULT 'fixed' AFTER is_active`,
    );
    console.log('Applied migration: doctor_branch_assignments.slot_type');
  }

  const [inviteSlotTypeCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_invites' AND COLUMN_NAME = 'slot_type'`,
  );
  if (Number(inviteSlotTypeCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE doctor_invites
         ADD COLUMN slot_type ENUM('fixed','sequential') NOT NULL DEFAULT 'fixed' AFTER slot_template`,
    );
    console.log('Applied migration: doctor_invites.slot_type');
  }

  const [slotStartDateCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_slot_templates' AND COLUMN_NAME = 'start_date'`,
  );
  if (Number(slotStartDateCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE doctor_slot_templates
         CHANGE COLUMN effective_from start_date DATE NOT NULL,
         CHANGE COLUMN effective_to end_date DATE NULL`,
    );
    console.log('Applied migration: doctor_slot_templates.effective_from/to -> start_date/end_date');
  }

  const [exceptionTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_slot_exceptions'`,
  );
  if (Number(exceptionTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE doctor_slot_exceptions (
        id CHAR(36) NOT NULL,
        doctor_branch_assignment_id CHAR(36) NOT NULL,
        excluded_date DATE NOT NULL,
        reason VARCHAR(255) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_exception_assignment_date (doctor_branch_assignment_id, excluded_date),
        CONSTRAINT fk_exception_assignment FOREIGN KEY (doctor_branch_assignment_id)
          REFERENCES doctor_branch_assignments(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: doctor_slot_exceptions table');
  }

  const [assignmentDateCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_branch_assignments' AND COLUMN_NAME = 'start_date'`,
  );
  if (Number(assignmentDateCols[0].cnt) > 0) {
    await conn.query(
      `ALTER TABLE doctor_branch_assignments DROP COLUMN start_date, DROP COLUMN end_date`,
    );
    console.log('Applied migration: doctor_branch_assignments dropped start_date/end_date (derived from doctor_slot_templates instead)');
  }

  const [exceptionEndDateCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_slot_exceptions' AND COLUMN_NAME = 'end_date'`,
  );
  if (Number(exceptionEndDateCols[0].cnt) === 0) {
    await conn.query(
      `ALTER TABLE doctor_slot_exceptions
         ADD COLUMN end_date DATE NULL AFTER excluded_date,
         ADD COLUMN status ENUM('active','cancelled') NOT NULL DEFAULT 'active' AFTER reason`,
    );
    // The old (assignment, excluded_date) unique key can't coexist with cancel-and-recreate
    // semantics for the same start date, so it's replaced with a plain lookup index.
    await conn.query(
      `ALTER TABLE doctor_slot_exceptions
         DROP INDEX uniq_exception_assignment_date,
         ADD INDEX idx_exception_assignment_range (doctor_branch_assignment_id, status, excluded_date)`,
    );
    console.log('Applied migration: doctor_slot_exceptions.end_date/status (leave ranges)');
  }

  const [operatingDaysTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branch_operating_days'`,
  );
  if (Number(operatingDaysTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE branch_operating_days (
        id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        weekday TINYINT NOT NULL,
        is_open TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_branch_weekday (branch_id, weekday),
        CONSTRAINT fk_operating_day_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: branch_operating_days table');
  }

  const [closureTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branch_closures'`,
  );
  if (Number(closureTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE branch_closures (
        id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        reason VARCHAR(255) NULL,
        status ENUM('active','cancelled') NOT NULL DEFAULT 'active',
        created_by CHAR(36) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_closure_branch_range (branch_id, status, start_date),
        CONSTRAINT fk_closure_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
        CONSTRAINT fk_closure_created_by FOREIGN KEY (created_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: branch_closures table');
  }

  const [apptPatientTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'appointment_patients'`,
  );
  if (Number(apptPatientTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE appointment_patients (
        id CHAR(36) NOT NULL,
        appointment_id CHAR(36) NOT NULL,
        relationship ENUM('self','spouse','child','parent','sibling','friend','other') NOT NULL DEFAULT 'self',
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(32) NULL,
        age TINYINT UNSIGNED NULL,
        gender ENUM('male','female','other','prefer_not_to_say') NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_appointment_patient (appointment_id),
        CONSTRAINT fk_appt_patient_details_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: appointment_patients table');
  }

  const [specMapRows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM doctor_specialization_map`,
  );
  if (Number(specMapRows[0].cnt) === 0) {
    const [legacyValues] = await conn.query(`
      SELECT specialization FROM doctors WHERE specialization IS NOT NULL AND specialization != ''
      UNION
      SELECT specialization FROM doctor_invites WHERE specialization IS NOT NULL AND specialization != ''
    `);
    const slugToId = new Map();
    for (const { specialization } of legacyValues) {
      const slug = slugify(specialization);
      if (!slug || slugToId.has(slug)) continue;
      const [existing] = await conn.query(
        `SELECT id FROM doctor_specializations WHERE slug = ?`,
        [slug],
      );
      if (existing[0]) {
        slugToId.set(slug, existing[0].id);
      } else {
        const id = randomUUID();
        await conn.query(
          `INSERT INTO doctor_specializations (id, name, slug, status) VALUES (?, ?, ?, 'active')`,
          [id, specialization.trim(), slug],
        );
        slugToId.set(slug, id);
      }
    }

    const [doctorRows] = await conn.query(
      `SELECT id, specialization FROM doctors WHERE specialization IS NOT NULL AND specialization != ''`,
    );
    for (const d of doctorRows) {
      const specializationId = slugToId.get(slugify(d.specialization));
      if (!specializationId) continue;
      await conn.query(
        `INSERT IGNORE INTO doctor_specialization_map (id, doctor_id, specialization_id) VALUES (?, ?, ?)`,
        [randomUUID(), d.id, specializationId],
      );
    }

    const [inviteRows] = await conn.query(
      `SELECT id, specialization FROM doctor_invites WHERE specialization IS NOT NULL AND specialization != ''`,
    );
    for (const i of inviteRows) {
      const specializationId = slugToId.get(slugify(i.specialization));
      if (!specializationId) continue;
      await conn.query(
        `INSERT IGNORE INTO doctor_invite_specializations (id, doctor_invite_id, specialization_id) VALUES (?, ?, ?)`,
        [randomUUID(), i.id, specializationId],
      );
    }

    console.log(`Applied migration: doctor_specializations backfill (${slugToId.size} specializations)`);
  }

  const [deviceTokenTables] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_tokens'`,
  );
  if (Number(deviceTokenTables[0].cnt) === 0) {
    await conn.query(`
      CREATE TABLE device_tokens (
        id CHAR(36) NOT NULL,
        user_id CHAR(36) NOT NULL,
        token VARCHAR(255) NOT NULL,
        platform ENUM('android','ios') NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uniq_device_token (token),
        KEY idx_device_tokens_user (user_id),
        CONSTRAINT fk_device_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    console.log('Applied migration: device_tokens table');
  }

  const [userPushTopicDropCols] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'push_topic'`,
  );
  if (Number(userPushTopicDropCols[0].cnt) > 0) {
    await conn.query(`ALTER TABLE users DROP INDEX uniq_users_push_topic, DROP COLUMN push_topic`);
    console.log('Applied migration: dropped users.push_topic (replaced by device_tokens/FCM)');
  }

  console.log('Schema applied successfully.');
} finally {
  await conn.end();
}
