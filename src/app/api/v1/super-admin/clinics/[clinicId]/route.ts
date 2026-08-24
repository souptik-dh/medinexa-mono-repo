import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/super-admin";
import { notFound } from "@/lib/errors";
import {
  ensureClinicSubscription,
  computeLiveState,
  serializeSubscription,
  getPlatformSettings,
} from "@/lib/subscriptions";

/**
 * Full administrative view of a clinic: owner contact, branches, staff, doctors,
 * lab configuration and AGGREGATE appointment volumes. Patient identities, medical
 * records, documents and prescriptions are intentionally excluded — the Super Admin
 * platform role never touches patient data.
 */
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const { clinicId } = ctx.params;

  const [clinics] = await pool.query<Row[]>(
    `SELECT c.*, u.email AS owner_email, u.name AS owner_name, u.phone AS owner_phone, u.status AS owner_status
       FROM clinics c JOIN users u ON u.id = c.owner_user_id
      WHERE c.id = ? AND c.deleted_at IS NULL`,
    [clinicId],
  );
  const clinic = clinics[0];
  if (!clinic) throw notFound("CLINIC_NOT_FOUND", "Clinic not found.");

  const [branches] = await pool.query<Row[]>(
    `SELECT id, name, address, city, district, pin_code, state, phone, timezone,
            trade_license_validation_status, created_at
       FROM branches WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    [clinicId],
  );
  const [staff] = await pool.query<Row[]>(
    `SELECT u.id, u.name, u.email, u.phone, u.status, bs.branch_id, b.name AS branch_name, bs.created_at
       FROM branch_staff bs
       JOIN users u ON u.id = bs.user_id
       JOIN branches b ON b.id = bs.branch_id
      WHERE b.clinic_id = ? AND b.deleted_at IS NULL
      ORDER BY bs.created_at ASC`,
    [clinicId],
  );
  const [doctors] = await pool.query<Row[]>(
    `SELECT DISTINCT d.id, d.name, d.specialization, d.reg_no, d.smc_name, d.doctor_degree, dba.branch_id, dba.fee_amount, dba.currency
       FROM doctor_branch_assignments dba
       JOIN branches b ON b.id = dba.branch_id
       JOIN doctors d ON d.id = dba.doctor_id AND d.deleted_at IS NULL
      WHERE b.clinic_id = ?
      ORDER BY d.name ASC`,
    [clinicId],
  );
  const [labConfig] = await pool.query<Row[]>(
    `SELECT
        (SELECT COUNT(*) FROM lab_tests lt WHERE lt.clinic_id = ? AND lt.status = 'active') AS active_tests,
        (SELECT COUNT(*) FROM lab_test_categories ltc WHERE ltc.clinic_id = ?) AS categories,
        (SELECT COUNT(*) FROM branch_lab_tests blt JOIN branches b ON b.id = blt.branch_id WHERE b.clinic_id = ? AND blt.status = 'active') AS branch_test_links
       FROM DUAL`,
    [clinicId, clinicId, clinicId],
  );
  // Appointments as aggregates only — no patient-level rows are returned.
  const [appointmentStats] = await pool.query<Row[]>(
    `SELECT status, COUNT(*) AS cnt FROM appointments WHERE clinic_id = ? GROUP BY status`,
    [clinicId],
  );
  const [labApptStats] = await pool.query<Row[]>(
    `SELECT status, COUNT(*) AS cnt FROM lab_test_appointments WHERE clinic_id = ? GROUP BY status`,
    [clinicId],
  );
  const [volume] = await pool.query<Row[]>(
    `SELECT
        (SELECT COUNT(*) FROM appointments WHERE clinic_id = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)) AS appointments_last_30d,
        (SELECT COUNT(DISTINCT doctor_id) FROM appointments WHERE clinic_id = ?) AS distinct_doctors_booked,
        (SELECT COALESCE(SUM(fee_amount * (status IN ('paid','completed'))), 0) FROM appointments WHERE clinic_id = ?) AS collected_estimate_inr`,
    [clinicId, clinicId, clinicId],
  );

  const sub = await ensureClinicSubscription(pool, clinicId);
  const settings = await getPlatformSettings(pool);
  const live = computeLiveState(sub, settings.expiring_warning_days);

  const byStatus = (rows: Row[]): Record<string, number> =>
    Object.fromEntries(rows.map((r) => [String(r.status), Number(r.cnt)]));

  return json({
    id: clinic.id,
    name: clinic.name,
    description: clinic.description,
    location: {
      nearby_location: clinic.nearby_location,
      city: clinic.city,
      district: clinic.district,
      pin_code: clinic.pin_code,
      state: clinic.state,
    },
    owner: {
      id: clinic.owner_user_id,
      name: clinic.owner_name,
      email: clinic.owner_email,
      phone: clinic.owner_phone,
      account_status: clinic.owner_status,
      created_at: clinic.owner_created_at ?? null,
    },
    licenses: {
      trade_license_number: clinic.trade_license_number,
      trade_license_validation_status: clinic.trade_license_validation_status,
      drug_license_number: clinic.drug_license_number,
      clinical_establishment_reg_number: clinic.clinical_establishment_reg_number,
    },
    subscription: serializeSubscription(sub, live),
    branches: branches.map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address,
      city: b.city,
      district: b.district,
      pin_code: b.pin_code,
      state: b.state,
      phone: b.phone,
      timezone: b.timezone,
      trade_license_validation_status: b.trade_license_validation_status,
      created_at: b.created_at,
    })),
    staff: staff.map((s) => ({
      user_id: s.user_id,
      name: s.name,
      email: s.email,
      phone: s.phone,
      account_status: s.status,
      branch_id: s.branch_id,
      branch_name: s.branch_name,
      added_at: s.created_at,
    })),
    doctors: doctors.map((d) => ({
      id: d.id,
      name: d.name,
      specialization: d.specialization,
      reg_no: d.reg_no,
      smc_name: d.smc_name,
      degree: d.doctor_degree,
      branch_id: d.branch_id,
      fee_amount: Number(d.fee_amount),
      currency: d.currency,
    })),
    lab_configuration: {
      active_tests: Number(labConfig[0]?.active_tests ?? 0),
      categories: Number(labConfig[0]?.categories ?? 0),
      branch_test_links: Number(labConfig[0]?.branch_test_links ?? 0),
    },
    appointment_summary: {
      by_status: byStatus(appointmentStats),
      lab_tests_by_status: byStatus(labApptStats),
      appointments_last_30d: Number(volume[0]?.appointments_last_30d ?? 0),
      collected_estimate_inr: Number(volume[0]?.collected_estimate_inr ?? 0),
    },
    created_at: clinic.created_at,
  });
});
