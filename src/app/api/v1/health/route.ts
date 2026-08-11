import { api, json } from "@/lib/http";
import { ping } from "@/lib/db";

export const GET = api({ rateLimit: 60, rateKey: "ip" }, async () => {
  try {
    await ping();
  } catch {
    return json({ status: "error", db: "down" }, 503);
  }
  return json({ status: "ok", db: "up" });
});
