import { json } from "@/lib/http";
import { pool } from "@/lib/db";

export async function GET(): Promise<Response> {
  try {
    await pool.query("SELECT 1");
    return json({ status: "ok", db: "up", time: new Date().toISOString() });
  } catch {
    return json({ status: "error", db: "down", time: new Date().toISOString() }, 503);
  }
}
