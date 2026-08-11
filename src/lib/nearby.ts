import { pool, type Row } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";

const MATCH_FIELDS = ["city", "district", "pin_code", "state", "post_office"] as const;

export interface PatientLocation {
  city: string | null;
  district: string | null;
  pin_code: string | null;
  state: string | null;
  post_office: string | null;
}

export async function getPatientLocation(userId: string): Promise<PatientLocation> {
  const [rows] = await pool.query<Row[]>(
    `SELECT city, district, pin_code, state, post_office FROM users WHERE id = ?`,
    [userId],
  );
  const u = rows[0];
  if (!u) throw notFound("USER_NOT_FOUND", "User not found.");
  return {
    city: u.city ?? null,
    district: u.district ?? null,
    pin_code: u.pin_code ?? null,
    state: u.state ?? null,
    post_office: u.post_office ?? null,
  };
}

export function buildNearbyMatch(
  alias: string,
  location: PatientLocation,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts: string[] = [];
  for (const field of MATCH_FIELDS) {
    const value = location[field];
    if (value) {
      parts.push(`${alias}.${field} = ?`);
      params.push(value);
    }
  }
  if (parts.length === 0) {
    throw badRequest(
      "ADDRESS_NOT_SET",
      "Add your city, district, pin code, state, or post office to your profile before searching nearby.",
    );
  }
  return { sql: `(${parts.join(" OR ")})`, params };
}
