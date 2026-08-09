import { api } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { getAppointmentInScope } from "@/lib/appointments";
import { buildTextPdf } from "@/lib/pdf";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  const appointment = await getAppointmentInScope(pool, ctx.params.id, auth);

  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM prescriptions WHERE appointment_id = ?`,
    [ctx.params.id],
  );
  const prescription = rows[0];
  if (!prescription || !prescription.digitized_text) {
    throw notFound("PRESCRIPTION_NOT_FOUND", "No prescription has been issued for this appointment.");
  }

  const [meta] = await pool.query<Row[]>(
    `SELECT c.name AS clinic_name, b.name AS branch_name,
            d.name AS doctor_name, u.name AS patient_name
       FROM appointments a
       JOIN clinics c ON c.id = a.clinic_id
       JOIN branches b ON b.id = a.branch_id
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = a.patient_id
      WHERE a.id = ?`,
    [ctx.params.id],
  );
  const m = meta[0] ?? {};

  const pdf = buildTextPdf({
    title: "Prescription",
    meta: [
      `${m.clinic_name ?? "Clinic"} — ${m.branch_name ?? "Branch"}`,
      `Patient: ${m.patient_name ?? "—"}`,
      `Doctor: ${m.doctor_name ?? "—"}`,
      `Appointment: ${appointment.scheduled_date} at ${appointment.scheduled_time}`,
    ],
    body: prescription.digitized_text,
  });

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="prescription-${ctx.params.id}.pdf"`,
    },
  });
});
