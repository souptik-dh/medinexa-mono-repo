import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { encodeCursor } from "@/lib/http";

type Db = Pool | PoolConnection;
type Row = RowDataPacket;

export interface Cursor {
  createdAt: string;
  id: string;
}

export function cursorClause(
  cursor: Record<string, unknown> | null,
): { sql: string; params: unknown[] } {
  if (!cursor || !cursor.createdAt || !cursor.id) {
    return { sql: "", params: [] };
  }
  return {
    sql: " AND (created_at < ? OR (created_at = ? AND id < ?))",
    params: [cursor.createdAt, cursor.createdAt, cursor.id],
  };
}

export async function fetchPage(opts: {
  db: Db;
  select: string;
  from: string;
  where?: string;
  orderBy?: string;
  params: unknown[];
  cursor: Record<string, unknown> | null;
  limit: number;
}): Promise<{ rows: Row[]; nextCursor: string | null }> {
  const orderBy = (opts.orderBy ?? "created_at DESC, id DESC")
    .replace(/[^a-z0-9_,\s.]/gi, "")
    .trim() || "created_at DESC, id DESC";
  const cursor = cursorClause(opts.cursor);
  const whereSql = opts.where
    ? `WHERE ${opts.where}${cursor.sql}`
    : cursor.sql
      ? `WHERE 1=1${cursor.sql}`
      : "";
  const [rows] = await opts.db.query<Row[]>(
    `${opts.select} ${opts.from} ${whereSql} ORDER BY ${orderBy} LIMIT ${opts.limit + 1}`,
    [...opts.params, ...cursor.params],
  );
  const hasMore = rows.length > opts.limit;
  const items = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;
  return { rows: items, nextCursor };
}
