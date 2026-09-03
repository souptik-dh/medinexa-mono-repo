import { createPool, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set in .env");

export const pool: Pool = createPool({
  uri: url,
  connectionLimit: 20,
  charset: "utf8mb4",
  dateStrings: true,
  timezone: "Z",
});

export type Row = RowDataPacket;

/**
 * Parses a MySQL DATETIME string (returned as "YYYY-MM-DD HH:mm:ss[.SSS]" by
 * this pool's dateStrings:true + timezone:"Z" config) as UTC. A plain
 * `new Date(value)` on a space-separated string is parsed as local time by
 * V8, which silently corrupts expiry comparisons on any non-UTC host.
 */
export function parseDbTimestamp(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function ping(): Promise<void> {
  await pool.query("SELECT 1");
}
