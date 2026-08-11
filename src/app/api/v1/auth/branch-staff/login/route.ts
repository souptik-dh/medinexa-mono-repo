import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, emailSchema } from "@/lib/validators";
import { pool, type Row } from "@/lib/db";
import { generateOtp, hashToken } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { sendEmail } from "@/lib/notifications";
import { forbidden } from "@/lib/errors";

const schema = z.object({ email: emailSchema });

export const POST = api({ rateLimit: 10, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));

  const [users] = await pool.query<Row[]>(
    `SELECT u.id, u.email
       FROM users u
       JOIN branch_staff bs ON bs.user_id = u.id
      WHERE u.email = ? AND u.role = 'branch_staff' AND u.status = 'active'`,
    [body.email],
  );

  if (!users[0]) {
    throw forbidden(
      "NOT_BRANCH_STAFF",
      "Access Denied: This email address is not registered as Branch Staff.",
    );
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    `INSERT INTO otp_codes (id, email, purpose, code_hash, expires_at)
     VALUES (?, ?, 'branch_staff_login', ?, ?)`,
    [newId(), body.email, hashToken(`${body.email}:${otp}`), expiresAt],
  );
  await sendEmail(
    body.email,
    "Your MediBook login code",
    `Your one-time login code is ${otp}. It expires in 10 minutes.`,
  );

  return json({ message: "If an account exists for this email, an OTP has been sent." });
});
