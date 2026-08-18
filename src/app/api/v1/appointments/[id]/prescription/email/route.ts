import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { requireAssignedDoctor } from "@/lib/prescriptions";
import { getAppointmentInScope } from "@/lib/appointments";
import { sendEmail } from "@/lib/notifications";
import { notFound } from "@/lib/errors";

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["doctor", "patient"]);

  let appointment: Row;
  if (auth.role === "doctor") {
    appointment = await requireAssignedDoctor(pool, ctx.params.id, auth);
  } else {
    appointment = await getAppointmentInScope(pool, ctx.params.id, auth);
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT u.email, u.name FROM users u WHERE u.id = ?`,
    [appointment.patient_id],
  );
  const patient = rows[0];
  if (!patient) {
    throw notFound("PATIENT_NOT_FOUND", "Patient account not found.");
  }

  await sendEmail(
    patient.email,
    "Your prescription",
    `Your prescription for appointment ${appointment.id} is ready. Download it from the app.`,
  );

  return json({ queued: true }, 202);
});
