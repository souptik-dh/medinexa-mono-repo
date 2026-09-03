import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody, phoneSchema, otpSchema } from "@/lib/validators";
import { verifyPhoneOtpAndLogin, loadRoleBindings } from "@/lib/auth-flows";
import { pool, type Row } from "@/lib/db";
import { getDoctorSpecializations } from "@/lib/specializations";

const schema = z.object({
  phone: phoneSchema,
  otp: otpSchema,
});

/**
 * Doctor login, step 2: verifies the OTP and returns tokens plus the doctor
 * clinical profile and specializations.
 */
export const POST = api({ rateLimit: 20, rateKey: "ip" }, async (ctx) => {
  const body = parseBody(schema, await readJson(ctx.request));
  const result = await verifyPhoneOtpAndLogin({
    phone: body.phone,
    otp: body.otp,
    role: "doctor",
    purpose: "doctor_login",
  });

  const { doctorId } = await loadRoleBindings(result.user.id, "doctor");
  const [doctors] = await pool.query<Row[]>(
    `SELECT id, name, phone, certificate_url, bio FROM doctors WHERE id = ? AND deleted_at IS NULL`,
    [doctorId],
  );
  const doc = doctors[0];
  const specializationsByDoctor = doc ? await getDoctorSpecializations(pool, [String(doc.id)]) : null;

  return json({
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    requires_password_setup: result.requires_password_setup,
    user: result.user,
    doctor: doc
      ? {
          id: doc.id,
          name: doc.name,
          specializations: specializationsByDoctor?.get(String(doc.id)) ?? [],
          phone: doc.phone,
          certificate_url: doc.certificate_url,
          bio: doc.bio,
        }
      : {
          id: result.user.id,
          name: result.user.name,
          specializations: [],
          phone: null,
          certificate_url: null,
          bio: null,
        },
  });
});
