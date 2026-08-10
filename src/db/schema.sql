-- MediBook schema (MySQL 8, utf8mb4, all timestamps UTC)
-- Mirrors the resource contract in clinic-booking-tech-spec.md §6.

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL,
  name VARCHAR(255) NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(32) NULL,
  password_hash VARCHAR(255) NULL,
  role ENUM('patient','clinic_owner','branch_staff','doctor','sys_admin') NOT NULL,
  status ENUM('active','pending','disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  replaced_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_refresh_token_hash (token_hash),
  KEY idx_refresh_user (user_id),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS otp_codes (
  id CHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  purpose ENUM('branch_staff_login') NOT NULL,
  code_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  attempts TINYINT NOT NULL DEFAULT 0,
  verified_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_otp_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope VARCHAR(255) NOT NULL,
  `key` VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status INT NOT NULL,
  response_json MEDIUMTEXT NULL,
  done_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (scope, `key`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS clinics (
  id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  nearby_location VARCHAR(500) NULL,
  city VARCHAR(255) NULL,
  district VARCHAR(255) NULL,
  pin_code VARCHAR(20) NULL,
  state VARCHAR(255) NULL,
  post_office VARCHAR(255) NULL,
  owner_user_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_clinics_owner (owner_user_id),
  CONSTRAINT fk_clinics_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS branches (
  id CHAR(36) NOT NULL,
  clinic_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  address VARCHAR(500) NOT NULL,
  nearby_location VARCHAR(500) NULL,
  city VARCHAR(255) NULL,
  district VARCHAR(255) NULL,
  pin_code VARCHAR(20) NULL,
  state VARCHAR(255) NULL,
  post_office VARCHAR(255) NULL,
  phone VARCHAR(32) NOT NULL,
  lat DECIMAL(10,7) NULL,
  lng DECIMAL(10,7) NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  photo_url VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_branches_clinic (clinic_id),
  CONSTRAINT fk_branches_clinic FOREIGN KEY (clinic_id) REFERENCES clinics(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS branch_staff (
  id CHAR(36) NOT NULL,
  branch_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  added_by CHAR(36) NOT NULL,
  permissions_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_staff_branch_user (branch_id, user_id),
  KEY idx_staff_user (user_id),
  CONSTRAINT fk_staff_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
  CONSTRAINT fk_staff_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS branch_gallery_images (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_invites (
  id CHAR(36) NOT NULL,
  branch_id CHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  specialization VARCHAR(255) NULL,
  phone VARCHAR(32) NULL,
  fee_amount DECIMAL(10,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  certificate_url VARCHAR(500) NULL,
  slot_template JSON NULL,
  invite_code_hash CHAR(64) NOT NULL,
  status ENUM('pending','accepted','expired','revoked') NOT NULL DEFAULT 'pending',
  invited_by CHAR(36) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_invite_pending (branch_id, email, status),
  KEY idx_invite_email (email),
  CONSTRAINT fk_invite_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctors (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  specialization VARCHAR(255) NULL,
  reg_no VARCHAR(64) NULL,
  phone VARCHAR(32) NULL,
  certificate_url VARCHAR(500) NULL,
  photo_url VARCHAR(500) NULL,
  bio TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_doctors_user (user_id),
  UNIQUE KEY uniq_doctors_reg_no (reg_no),
  CONSTRAINT fk_doctors_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_branch_assignments (
  id CHAR(36) NOT NULL,
  doctor_id CHAR(36) NOT NULL,
  branch_id CHAR(36) NOT NULL,
  fee_amount DECIMAL(10,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_assignment (doctor_id, branch_id),
  KEY idx_assignment_branch (branch_id),
  CONSTRAINT fk_assignment_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_slot_templates (
  id CHAR(36) NOT NULL,
  doctor_branch_assignment_id CHAR(36) NOT NULL,
  weekday TINYINT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  slot_duration_minutes SMALLINT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_slot_assignment (doctor_branch_assignment_id),
  CONSTRAINT fk_slot_assignment FOREIGN KEY (doctor_branch_assignment_id)
    REFERENCES doctor_branch_assignments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS appointments (
  id CHAR(36) NOT NULL,
  patient_id CHAR(36) NOT NULL,
  clinic_id CHAR(36) NOT NULL,
  branch_id CHAR(36) NOT NULL,
  doctor_id CHAR(36) NOT NULL,
  scheduled_date DATE NOT NULL,
  scheduled_time VARCHAR(5) NOT NULL,
  duration_minutes SMALLINT NOT NULL DEFAULT 20,
  status ENUM('pending','confirmed','paid','completed','cancelled','no_show') NOT NULL DEFAULT 'pending',
  fee_amount DECIMAL(10,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  payment_method VARCHAR(16) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  -- Partial unique constraint: a slot is unique per (doctor, date) while NOT cancelled.
  slot_key VARCHAR(5) GENERATED ALWAYS AS (IF(status = 'cancelled', NULL, scheduled_time)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_doctor_date_slot (doctor_id, scheduled_date, slot_key),
  KEY idx_appt_branch_status (branch_id, status),
  KEY idx_appt_patient (patient_id),
  KEY idx_appt_doctor_date (doctor_id, scheduled_date),
  CONSTRAINT fk_appt_patient FOREIGN KEY (patient_id) REFERENCES users(id),
  CONSTRAINT fk_appt_clinic FOREIGN KEY (clinic_id) REFERENCES clinics(id),
  CONSTRAINT fk_appt_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_appt_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS appointment_status_log (
  id CHAR(36) NOT NULL,
  appointment_id CHAR(36) NOT NULL,
  from_status VARCHAR(16) NULL,
  to_status VARCHAR(16) NOT NULL,
  changed_by CHAR(36) NOT NULL,
  changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  note VARCHAR(500) NULL,
  PRIMARY KEY (id),
  KEY idx_status_log_appt (appointment_id),
  CONSTRAINT fk_status_log_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) NOT NULL,
  appointment_id CHAR(36) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  method ENUM('cash','upi') NOT NULL,
  collected_by CHAR(36) NOT NULL,
  collected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reference_no VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_payments_appt (appointment_id),
  CONSTRAINT fk_payments_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS medical_documents (
  id CHAR(36) NOT NULL,
  patient_id CHAR(36) NOT NULL,
  file_url VARCHAR(500) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  uploaded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_meddoc_patient (patient_id),
  CONSTRAINT fk_meddoc_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS prescriptions (
  id CHAR(36) NOT NULL,
  appointment_id CHAR(36) NOT NULL,
  doctor_id CHAR(36) NOT NULL,
  scan_url VARCHAR(500) NULL,
  digitized_text MEDIUMTEXT NULL,
  ocr_confidence DECIMAL(5,2) NULL,
  finalized_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_prescription_appt (appointment_id),
  CONSTRAINT fk_prescription_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT fk_prescription_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS prescription_scan_jobs (
  id CHAR(36) NOT NULL,
  appointment_id CHAR(36) NOT NULL,
  doctor_id CHAR(36) NOT NULL,
  status ENUM('processing','done','failed') NOT NULL DEFAULT 'processing',
  draft_text MEDIUMTEXT NULL,
  confidence DECIMAL(5,2) NULL,
  scan_url VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_scan_jobs_appt (appointment_id),
  CONSTRAINT fk_scan_jobs_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notifications (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  branch_id CHAR(36) NULL,
  type VARCHAR(40) NOT NULL,
  payload_json JSON NULL,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_notif_user (user_id, created_at),
  KEY idx_notif_branch (branch_id),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
