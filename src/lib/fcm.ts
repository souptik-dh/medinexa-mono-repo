import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { pool, type Row } from "@/lib/db";

export type PushApp = "patient" | "clinic";

/**
 * Host env var UIs (Render, etc.) store whatever was pasted verbatim — unlike a local
 * .env file, they don't strip a wrapping quote pair or expand escaped "\n" into real
 * newlines the way dotenv does. Normalize both cases so the same value works whether
 * it arrives already-parsed (local dev) or raw (deployed).
 */
function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.replace(/\\n/g, "\n");
}

/**
 * The patient app and the xclinic (clinic-side) app are separate Firebase projects
 * with their own service accounts, so each gets its own named Admin SDK app instance —
 * a device token registered against one project can only be sent through that project's
 * credentials.
 */
const ENV_PREFIX: Record<PushApp, string> = {
  patient: "FIREBASE",
  clinic: "FIREBASE_CLINIC",
};

const apps: Partial<Record<PushApp, App | null>> = {};

function app(pushApp: PushApp): App | null {
  if (pushApp in apps) return apps[pushApp] ?? null;

  const existing = getApps().find((a) => a.name === pushApp);
  if (existing) {
    apps[pushApp] = existing;
    return existing;
  }

  const prefix = ENV_PREFIX[pushApp];
  const projectId = process.env[`${prefix}_PROJECT_ID`];
  const clientEmail = process.env[`${prefix}_CLIENT_EMAIL`];
  const rawPrivateKey = process.env[`${prefix}_PRIVATE_KEY`];
  const privateKey = rawPrivateKey ? normalizePrivateKey(rawPrivateKey) : undefined;
  if (!projectId || !clientEmail || !privateKey) {
    apps[pushApp] = null;
    return null;
  }

  // A malformed credential (e.g. a private key mangled by a host env var UI —
  // see normalizePrivateKey above) makes initializeApp/cert throw synchronously.
  // sendFcmToUser's callers await this from inside a DB transaction (booking
  // creation, etc), so an uncaught throw here would roll back the triggering
  // request instead of just skipping the push. Cache the failure so we don't
  // re-throw (and re-log) on every subsequent call in this process either.
  try {
    const created = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }, pushApp);
    apps[pushApp] = created;
    return created;
  } catch (err) {
    console.error(`[push:${pushApp}] Firebase Admin init failed — check FIREBASE${pushApp === "clinic" ? "_CLINIC" : ""}_* env vars (especially PRIVATE_KEY formatting):`, err);
    apps[pushApp] = null;
    return null;
  }
}

export interface FcmMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Sends an FCM push to every device token for a user registered under the given app
 * (patient or clinic), dropping tokens FCM reports as unregistered/invalid. Never
 * throws — failures are logged so callers (notification writes) never fail on push
 * delivery.
 */
export async function sendFcmToUser(userId: string, msg: FcmMessage, pushApp: PushApp = "patient"): Promise<void> {
  const firebaseApp = app(pushApp);
  if (!firebaseApp) {
    console.error(`[push:${pushApp}] not configured (missing FIREBASE${pushApp === "clinic" ? "_CLINIC" : ""}_* env vars) — skipping send to user ${userId}.`);
    return;
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT token FROM device_tokens WHERE user_id = ? AND app = ?`,
    [userId, pushApp],
  );
  const tokens = rows.map((r) => r.token as string);
  if (tokens.length === 0) return;

  try {
    const response = await getMessaging(firebaseApp).sendEachForMulticast({
      tokens,
      notification: { title: msg.title, body: msg.body },
      data: msg.data,
    });
    if (response.failureCount > 0) {
      response.responses.forEach((r, i) => {
        if (!r.success) console.error(`[push:${pushApp}] send to token ${tokens[i]} failed:`, r.error?.code, r.error?.message);
      });
    }

    const staleTokens = response.responses
      .map((r, i) => (!r.success && isUnregistered(r.error?.code) ? tokens[i] : null))
      .filter((t): t is string => t !== null);
    if (staleTokens.length > 0) {
      await pool.query(`DELETE FROM device_tokens WHERE token IN (?)`, [staleTokens]);
    }
  } catch (err) {
    console.error(`[push:${pushApp}] FCM send failed:`, err);
  }
}

function isUnregistered(code: string | undefined): boolean {
  return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument";
}
