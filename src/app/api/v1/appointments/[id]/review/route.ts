import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope } from "@/lib/appointments";
import { conflict, isUniqueViolation } from "@/lib/errors";
import { newId } from "@/lib/ids";

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional().nullable(),
});

function serializeReview(r: Row) {
  return {
    id: r.id,
    patient_id: r.patient_id,
    doctor_id: r.doctor_id,
    branch_id: r.branch_id,
    appointment_id: r.appointment_id,
    rating: Number(r.rating),
    comment: r.comment ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// A patient rates the doctor they saw for a completed appointment. Since `reviews`
// has one row per (patient, doctor) — not per appointment — rating the same doctor
// again after a later visit updates that existing review in place (and re-points it
// at the newer appointment/branch) rather than erroring or creating a duplicate.
export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const appt = await getAppointmentInScope(pool, ctx.params.id, auth);
  if (appt.status !== "completed") {
    throw conflict(
      "APPOINTMENT_NOT_COMPLETED",
      "You can only rate a doctor after the appointment is completed.",
    );
  }
  const body = parseBody(reviewSchema, await readJson(ctx.request));

  const id = newId();
  let status = 201;
  try {
    await pool.query(
      `INSERT INTO reviews (id, patient_id, doctor_id, branch_id, appointment_id, rating, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, auth.userId, appt.doctor_id, appt.branch_id, appt.id, body.rating, body.comment ?? null],
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    status = 200;
    await pool.query(
      `UPDATE reviews SET rating = ?, comment = ?, branch_id = ?, appointment_id = ?
        WHERE patient_id = ? AND doctor_id = ?`,
      [body.rating, body.comment ?? null, appt.branch_id, appt.id, auth.userId, appt.doctor_id],
    );
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM reviews WHERE patient_id = ? AND doctor_id = ?`,
    [auth.userId, appt.doctor_id],
  );
  return json(serializeReview(rows[0]), status);
});
