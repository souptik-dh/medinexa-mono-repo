import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export interface RatingSummary {
  average: number | null;
  count: number;
}

const EMPTY_RATING: RatingSummary = { average: null, count: 0 };

export async function getDoctorRatingMap(
  db: Db,
  doctorIds: string[],
): Promise<Map<string, RatingSummary>> {
  const result = new Map<string, RatingSummary>();
  const uniqueIds = [...new Set(doctorIds)];
  if (uniqueIds.length === 0) return result;
  const [rows] = await db.query<Row[]>(
    `SELECT doctor_id, AVG(rating) AS average, COUNT(*) AS count
       FROM reviews
      WHERE doctor_id IN (?)
      GROUP BY doctor_id`,
    [uniqueIds],
  );
  for (const r of rows) {
    result.set(String(r.doctor_id), {
      average: Math.round(Number(r.average) * 10) / 10,
      count: Number(r.count),
    });
  }
  return result;
}

export async function getDoctorRating(db: Db, doctorId: string): Promise<RatingSummary> {
  const map = await getDoctorRatingMap(db, [doctorId]);
  return map.get(doctorId) ?? EMPTY_RATING;
}

export async function getBranchRatingMap(
  db: Db,
  branchIds: string[],
): Promise<Map<string, RatingSummary>> {
  const result = new Map<string, RatingSummary>();
  const uniqueIds = [...new Set(branchIds)];
  if (uniqueIds.length === 0) return result;
  const [rows] = await db.query<Row[]>(
    `SELECT branch_id, AVG(rating) AS average, COUNT(*) AS count
       FROM reviews
      WHERE branch_id IN (?)
      GROUP BY branch_id`,
    [uniqueIds],
  );
  for (const r of rows) {
    result.set(String(r.branch_id), {
      average: Math.round(Number(r.average) * 10) / 10,
      count: Number(r.count),
    });
  }
  return result;
}

export async function getBranchRating(db: Db, branchId: string): Promise<RatingSummary> {
  const map = await getBranchRatingMap(db, [branchId]);
  return map.get(branchId) ?? EMPTY_RATING;
}

// Masks a patient's name for public-facing review display: first name plus the
// last name's initial (e.g. "Priya Sharma" -> "Priya S."), since GET /doctors/:id/reviews
// is unauthenticated. The clinic-side GET /branches/:id/reviews shows the full name instead,
// matching GET /branches/:id/patients (already visible to clinic staff for accountability).
export function maskPatientName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Patient";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
