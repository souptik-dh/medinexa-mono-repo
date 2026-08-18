import { createHash } from "node:crypto";
import { pool, type Row } from "@/lib/db";
import { ApiError, conflict, unprocessable, isUniqueViolation } from "@/lib/errors";

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Runs a state-changing operation under an Idempotency-Key contract.
 * Keys are stored for 24h; a replay with the same key + body returns the
 * original response instead of duplicating the write.
 */
export async function runIdempotent<T>(
  scope: string,
  key: string | null,
  rawBody: string,
  run: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (!key) {
    const result = await run();
    return { ...result, replayed: false };
  }
  if (key.length > 255) {
    throw unprocessable("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key is too long.");
  }

  const requestHash = createHash("sha256").update(rawBody).digest("hex");
  let claimed = false;
  try {
    const [res] = await pool.execute(
      `INSERT IGNORE INTO idempotency_keys (scope, \`key\`, request_hash)
       VALUES (?, ?, ?)`,
      [scope, key, requestHash],
    );
    claimed = (res as { affectedRows: number }).affectedRows === 1;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    claimed = false;
  }

  if (claimed) {
    if (Math.random() < 0.01) {
      await pool.query(
        `DELETE FROM idempotency_keys WHERE created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)`,
      );
    }
    const store = async (status: number, body: unknown) => {
      await pool.execute(
        `UPDATE idempotency_keys
            SET status = ?, response_json = ?, done_at = UTC_TIMESTAMP(3)
          WHERE scope = ? AND \`key\` = ?`,
        [status, JSON.stringify(body), scope, key],
      );
    };
    try {
      const result = await run();
      await store(result.status, result.body);
      return { ...result, replayed: false };
    } catch (err) {
      if (err instanceof ApiError) {
        await store(err.status, {
          error: { code: err.code, message: err.message, field: err.field },
        });
      }
      throw err;
    }
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT request_hash, status, response_json, done_at
       FROM idempotency_keys WHERE scope = ? AND \`key\` = ?`,
    [scope, key],
  );
  const row = rows[0];
  if (!row) throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key could not be registered.");
  if (row.request_hash !== requestHash) {
    throw unprocessable(
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used with a different request body.",
    );
  }
  if (!row.done_at) {
    throw conflict(
      "IDEMPOTENCY_IN_PROGRESS",
      "A request with this Idempotency-Key is already being processed.",
    );
  }
  return { status: row.status, body: JSON.parse(row.response_json) as T, replayed: true };
}
