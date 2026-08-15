import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export interface SpecializationRef {
  id: string;
  name: string;
}

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function getInviteSpecializations(
  db: Db,
  inviteIds: string[],
): Promise<Map<string, SpecializationRef[]>> {
  const result = new Map<string, SpecializationRef[]>();
  if (inviteIds.length === 0) return result;
  const [rows] = await db.query<Row[]>(
    `SELECT dis.doctor_invite_id, ds.id, ds.name
       FROM doctor_invite_specializations dis
       JOIN doctor_specializations ds ON ds.id = dis.specialization_id
      WHERE dis.doctor_invite_id IN (?)
      ORDER BY ds.name ASC`,
    [inviteIds],
  );
  for (const r of rows) {
    const list = result.get(r.doctor_invite_id) ?? [];
    list.push({ id: r.id, name: r.name });
    result.set(r.doctor_invite_id, list);
  }
  return result;
}

export async function getDoctorSpecializations(
  db: Db,
  doctorIds: string[],
): Promise<Map<string, SpecializationRef[]>> {
  const result = new Map<string, SpecializationRef[]>();
  if (doctorIds.length === 0) return result;
  const [rows] = await db.query<Row[]>(
    `SELECT dsm.doctor_id, ds.id, ds.name
       FROM doctor_specialization_map dsm
       JOIN doctor_specializations ds ON ds.id = dsm.specialization_id
      WHERE dsm.doctor_id IN (?)
      ORDER BY ds.name ASC`,
    [doctorIds],
  );
  for (const r of rows) {
    const list = result.get(r.doctor_id) ?? [];
    list.push({ id: r.id, name: r.name });
    result.set(r.doctor_id, list);
  }
  return result;
}

export function specializationDisplayName(list: SpecializationRef[] | undefined): string | null {
  if (!list || list.length === 0) return null;
  return list.map((s) => s.name).join(", ");
}
