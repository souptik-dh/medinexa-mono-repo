import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { scopeWhere, serializeAppointment } from "@/lib/appointments";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  const { where, params } = scopeWhere(auth);

  const [rows] = await pool.query<Row[]>(
    `SELECT a.*,
            d.name AS doctor_name,
            b.name AS branch_name,
            u.name AS patient_name,
            u.email AS patient_email,
            u.phone AS patient_phone,
            u.address AS patient_address,
            u.photo_url AS patient_photo_url
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN branches b ON b.id = a.branch_id
       JOIN users u ON u.id = a.patient_id
      WHERE a.id = ? AND ${where}`,
    [ctx.params.id, ...params],
  );
  const appointment = rows[0];
  if (!appointment) throw notFound("APPOINTMENT_NOT_FOUND", "Appointment not found.");
  return json(serializeAppointment(appointment));
});
