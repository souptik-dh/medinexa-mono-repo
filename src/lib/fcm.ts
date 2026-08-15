import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { pool, type Row } from "@/lib/db";

function app() {
  if (getApps().length > 0) return getApps()[0];

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) return null;

  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
}

export interface FcmMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Sends an FCM push to every device token for a user, dropping tokens FCM
 * reports as unregistered/invalid. Never throws — failures are logged so
 * callers (notification writes) never fail on push delivery.
 */
export async function sendFcmToUser(userId: string, msg: FcmMessage): Promise<void> {
  const firebaseApp = app();
  if (!firebaseApp) return;

  const [rows] = await pool.query<Row[]>(
    `SELECT token FROM device_tokens WHERE user_id = ?`,
    [userId],
  );
  const tokens = rows.map((r) => r.token as string);
  if (tokens.length === 0) return;

  try {
    const response = await getMessaging(firebaseApp).sendEachForMulticast({
      tokens,
      notification: { title: msg.title, body: msg.body },
      data: msg.data,
    });

    const staleTokens = response.responses
      .map((r, i) => (!r.success && isUnregistered(r.error?.code) ? tokens[i] : null))
      .filter((t): t is string => t !== null);
    if (staleTokens.length > 0) {
      await pool.query(`DELETE FROM device_tokens WHERE token IN (?)`, [staleTokens]);
    }
  } catch (err) {
    console.error("[push] FCM send failed:", err);
  }
}

function isUnregistered(code: string | undefined): boolean {
  return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument";
}
