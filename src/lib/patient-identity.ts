import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { newId } from "@/lib/ids";
import { conflict, isUniqueViolation, notFound } from "@/lib/errors";
import type { AuthContext } from "@/lib/auth";

type Row = RowDataPacket;

export type BookingSource = "PATIENT_APP" | "RECEPTION";

export interface PatientDetailsInput {
  patient_id?: string;
  relationship: string;
  name: string;
  phone: string | null | undefined;
  age?: number | null;
  gender?: string | null;
}

export interface ResolvedServicePatient {
  patientId: string | null;
  bookingSource: BookingSource;
  bookedBy: string;
}

// Finds an existing patient by phone (the only reliable dedupe key we have —
// `uniq_users_phone` is a global unique index), or registers a lightweight,
// never-logged-in patient record (password_hash stays NULL, same convention
// `branches/[id]/patients` already uses for `is_registered`) from the walk-in/family
// member details supplied at booking time. Concurrent bookings for a brand-new phone
// number retry the lookup on a duplicate-key race instead of failing the booking.
async function findOrCreatePatientByPhone(
  conn: PoolConnection,
  details: PatientDetailsInput,
): Promise<string | null> {
  if (!details.phone) return null;

  const [existing] = await conn.query<Row[]>(
    `SELECT id FROM users WHERE phone = ? AND role = 'patient' LIMIT 1`,
    [details.phone],
  );
  if (existing[0]) return existing[0].id;

  const id = newId();
  try {
    await conn.query(
      `INSERT INTO users (id, name, phone, gender, role, status)
       VALUES (?, ?, ?, ?, 'patient', 'active')`,
      [id, details.name, details.phone, details.gender ?? null],
    );
    return id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const [retry] = await conn.query<Row[]>(
      `SELECT id FROM users WHERE phone = ? AND role = 'patient' LIMIT 1`,
      [details.phone],
    );
    if (retry[0]) return retry[0].id;
    // The phone collided with a non-patient account (staff/doctor/owner) — that
    // number can't be reused for a new patient record.
    throw conflict(
      "PHONE_ALREADY_REGISTERED",
      "This phone number is already registered under a different account.",
    );
  }
}

// Resolves the actual, resolvable patient for a booking. `appointments.patient_id` /
// `lab_test_appointments.patient_id` keeps meaning "the booking account" (auth.userId,
// unchanged) — this only resolves the appointment_patients-level `patient_id`.
export async function resolveServicePatient(
  conn: PoolConnection,
  auth: AuthContext,
  details: PatientDetailsInput,
): Promise<ResolvedServicePatient> {
  const bookedBy = auth.userId;
  const bookingSource: BookingSource = auth.role === "patient" ? "PATIENT_APP" : "RECEPTION";

  if (auth.role === "patient") {
    // A patient account can never point a booking at an arbitrary existing
    // patient_id it doesn't control — self and phone-verified family members
    // (matched/created by phone) are the only two paths available to this role.
    if (details.relationship === "self") {
      return { patientId: auth.userId, bookingSource, bookedBy };
    }
    const patientId = await findOrCreatePatientByPhone(conn, details);
    return { patientId, bookingSource, bookedBy };
  }

  // Reception (branch_staff / clinic_owner): an explicit patient_id selects an
  // existing patient (found via /api/v1/patients/lookup); otherwise fall back to
  // the same phone lookup-or-create used above for a new walk-in registration.
  if (details.patient_id) {
    const [rows] = await conn.query<Row[]>(
      `SELECT id FROM users WHERE id = ? AND role = 'patient'`,
      [details.patient_id],
    );
    if (!rows[0]) throw notFound("PATIENT_NOT_FOUND", "Selected patient was not found.");
    return { patientId: details.patient_id, bookingSource, bookedBy };
  }

  const patientId = await findOrCreatePatientByPhone(conn, details);
  return { patientId, bookingSource, bookedBy };
}
