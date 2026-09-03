import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema } from "@/lib/validators";
import { loginWithPassword } from "@/lib/auth-flows";
import { pool, type Row } from "@/lib/db";

const schema = z.object({
  phone: phoneSchema,
  password: z.string().min(1),
});

/**
 * Alternative to the OTP flow (POST /auth/clinic-owner/login + verify-otp)
 * for an owner who has already set a password via POST /auth/set-password.
 * Also returns the owned clinic summary, mirroring verify-otp's response.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));
  const result = await loginWithPassword(body.phone, body.password, "clinic_owner");

  const [clinics] = await pool.query<Row[]>(
    `SELECT c.id, c.name, c.description
       FROM clinics c WHERE c.owner_user_id = ? AND c.deleted_at IS NULL LIMIT 1`,
    [result.user.id],
  );
  const clinic = clinics[0] ?? null;

  return json({
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    user: result.user,
    clinic: clinic
      ? { id: clinic.id, name: clinic.name, description: clinic.description }
      : null,
  });
});
