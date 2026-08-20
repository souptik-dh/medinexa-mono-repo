import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { ApiError, badRequest, rateLimited } from "@/lib/errors";
import { parseAuthContext, type AuthContext } from "@/lib/auth";

export interface Ctx<P extends Record<string, string> = Record<string, string>> {
  request: NextRequest;
  params: P;
  reqId: string;
  auth: AuthContext | null;
}

interface ApiOptions {
  rateLimit?: number;
  rateKey?: "ip" | "user";
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

function toIsoReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.length >= 19 && DATETIME_RE.test(value)) {
    return `${value.replace(" ", "T")}Z`;
  }
  return value;
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data, toIsoReviver), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "local";
}

const hits = new Map<string, number[]>();
let lastCleanup = Date.now();

function cleanupStaleKeys(now: number): void {
  for (const [k, arr] of hits) {
    const fresh = arr.filter((t) => now - t < 60_000);
    if (fresh.length === 0) hits.delete(k);
    else hits.set(k, fresh);
  }
  lastCleanup = now;
}

export function checkRateLimit(key: string, limitPerMin: number): void {
  const now = Date.now();

  if (now - lastCleanup > 60_000) {
    cleanupStaleKeys(now);
  }

  const arr = hits.get(key) ?? [];
  if (arr.length >= limitPerMin) {
    const oldestInWindow = arr[0];
    const retryAfter = Math.max(1, Math.ceil((oldestInWindow + 60_000 - now) / 1000));
    throw rateLimited(retryAfter);
  }
  arr.push(now);
  hits.set(key, arr);
}

function errorEnvelope(err: unknown, reqId: string): Response {
  if (err instanceof ApiError) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (err.status === 429 && err.retryAfter != null) {
      headers["Retry-After"] = String(err.retryAfter);
    }
    return new Response(
      JSON.stringify({
        error: { code: err.code, message: err.message, field: err.field, request_id: reqId },
      }),
      { status: err.status, headers },
    );
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  return json(
    { error: { code: "INTERNAL_ERROR", message, field: null, request_id: reqId } },
    500,
  );
}

export function api<P extends Record<string, string> = Record<string, string>>(
  opts: ApiOptions | undefined,
  fn: (ctx: Ctx<P>) => Promise<Response> | Response,
) {
  return async (request: NextRequest, context: { params: Promise<P> }): Promise<Response> => {
    const reqId = `req_${randomUUID().slice(0, 8)}`;
    const params = await context.params;
    try {
      const auth = await parseAuthContext(request);
      if (opts?.rateLimit != null) {
        const limit = opts.rateLimit;
        const key =
          auth && opts?.rateKey !== "ip" ? `u:${auth.userId}` : `ip:${clientIp(request)}`;
        checkRateLimit(key, limit);
      } else if (auth) {
        const key = `u:${auth.userId}`;
        checkRateLimit(key, 200);
      }
      return await fn({ request, params, reqId, auth });
    } catch (err) {
      return errorEnvelope(err, reqId);
    }
  };
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await request.json();
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw badRequest("INVALID_JSON", "Request body must be a valid JSON object.");
  }
}

export function encodeCursor(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export function decodeCursor(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const data = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}
