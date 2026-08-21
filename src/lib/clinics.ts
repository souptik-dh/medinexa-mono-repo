import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export interface DoctorClinicRef {
  clinic_id: string;
  clinic_name: string;
  branch_id: string;
  branch_name: string;
  city: string | null;
}

// One row per active doctor<->branch assignment, grouped by doctor. `branch_id` is the
// value the client must pass back as POST /appointments' `branch_id` once a clinic is picked.
export async function getDoctorClinics(db: Db, doctorIds: string[]): Promise<Map<string, DoctorClinicRef[]>> {
  const result = new Map<string, DoctorClinicRef[]>();
  const uniqueIds = [...new Set(doctorIds)];
  if (uniqueIds.length === 0) return result;
  const [rows] = await db.query<Row[]>(
    `SELECT dba.doctor_id, c.id AS clinic_id, c.name AS clinic_name,
            b.id AS branch_id, b.name AS branch_name, b.city AS city
       FROM doctor_branch_assignments dba
       JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
       JOIN clinics c ON c.id = b.clinic_id AND c.deleted_at IS NULL
      WHERE dba.doctor_id IN (?) AND dba.is_active = 1
      ORDER BY c.name ASC, b.name ASC`,
    [uniqueIds],
  );
  for (const r of rows) {
    const list = result.get(String(r.doctor_id)) ?? [];
    list.push({
      clinic_id: r.clinic_id,
      clinic_name: r.clinic_name,
      branch_id: r.branch_id,
      branch_name: r.branch_name,
      city: r.city,
    });
    result.set(String(r.doctor_id), list);
  }
  return result;
}
