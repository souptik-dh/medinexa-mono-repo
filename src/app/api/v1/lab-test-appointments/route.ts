import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool, withTransaction } from "@/lib/db";
import { newId } from "@/lib/ids";
import { parseBody } from "@/lib/validators";
import {
  generateAppointmentNumber,
  serializeLabTestAppointment,
  auditLabAction,
} from "@/lib/lab-tests";
import { generateLabTestSlots } from "@/lib/lab-test-availability";
import {
  notifyBranchStaff,
  createNotification,
  branchContactEmails,
  sendEmail,
  detailsEmailHtml,
} from "@/lib/notifications";
import { runIdempotent } from "@/lib/idempotency";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

const createSchema = z.object({
  branch_id: z.string().uuid(),
  branch_lab_test_id: z.string().uuid(),
  service_mode: z.enum(["CLINIC", "HOME"]),
  appointment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}$/),
  prescription_id: z.string().uuid().optional(),
  patient_notes: z.string().max(1000).optional(),
  payment_method: z.enum(["PAY_AT_CLINIC", "ONLINE"]).default("PAY_AT_CLINIC"),
  home_address: z.string().max(1000).optional(),
  home_lat: z.number().optional(),
  home_lng: z.number().optional(),
  home_contact_phone: z.string().max(32).optional(),
  home_notes: z.string().max(500).optional(),
});

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const idemKey = ctx.request.headers.get("idempotency-key");
  if (!idemKey) {
    throw badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key header is required for this endpoint.",
    );
  }

  const rawBody = await ctx.request.text();
  let parsedJson: Record<string, unknown>;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    throw badRequest("INVALID_JSON", "Request body must be a valid JSON object.");
  }
  const body = parseBody(createSchema, parsedJson);

  const result = await runIdempotent("lab-test-appointments:create", idemKey, rawBody, async () => {
    const [branchRows] = await pool.query<RowDataPacket[]>(
      `SELECT b.*, c.owner_user_id FROM branches b JOIN clinics c ON c.id = b.clinic_id
       WHERE b.id = ? AND b.deleted_at IS NULL AND c.deleted_at IS NULL`,
      [body.branch_id],
    );
    if (branchRows.length === 0) {
      throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
    }
    const branch = branchRows[0];

    const [bltRows] = await pool.query<RowDataPacket[]>(
      `SELECT blt.*, lt.name AS test_name, lt.status AS test_status
         FROM branch_lab_tests blt JOIN lab_tests lt ON lt.id = blt.test_id
       WHERE blt.id = ? AND blt.branch_id = ? AND blt.status = 'active' AND lt.status = 'active'`,
      [body.branch_lab_test_id, body.branch_id],
    );
    if (bltRows.length === 0) {
      throw notFound("BRANCH_TEST_NOT_FOUND", "Lab test not found or inactive at this branch.");
    }
    const blt = bltRows[0];

    if (body.service_mode === "HOME" && !blt.home_collection_available) {
      throw badRequest("SERVICE_MODE_NOT_SUPPORTED", "Home collection is not available for this test.");
    }
    if (body.service_mode === "CLINIC" && !blt.clinic_available) {
      throw badRequest("SERVICE_MODE_NOT_SUPPORTED", "Clinic visit is not available for this test.");
    }

    if (blt.prescription_required && !body.prescription_id) {
      throw badRequest("PRESCRIPTION_REQUIRED", "Prescription is required for this test.");
    }

    if (body.service_mode === "HOME") {
      if (!body.home_address) {
        throw badRequest("VALIDATION_ERROR", "Home address is required for home collection.");
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    if (body.appointment_date < today) {
      throw badRequest("VALIDATION_ERROR", "Cannot book for a past date.");
    }

    const slots = await generateLabTestSlots(
      pool,
      body.branch_id,
      body.branch_lab_test_id,
      body.appointment_date,
      Number(blt.duration_minutes),
    );
    const requestedSlot = slots.find((s) => s.start === body.start_time);
    if (!requestedSlot || !requestedSlot.available) {
      throw conflict("SLOT_NOT_AVAILABLE", "The selected time slot is not available.");
    }

    const [existingAppt] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM lab_test_appointments
       WHERE patient_id = ? AND branch_lab_test_id = ? AND appointment_date = ? AND start_time = ?
         AND status NOT IN ('CANCELLED', 'REJECTED')`,
      [auth.userId, body.branch_lab_test_id, body.appointment_date, body.start_time],
    );
    if (existingAppt.length > 0) {
      throw conflict("DUPLICATE_BOOKING", "You already have a booking for this slot.");
    }

    const appointmentId = newId();
    const appointmentNumber = generateAppointmentNumber();
    const durationMinutes = Number(blt.duration_minutes);
    const endMinutes =
      parseInt(body.start_time.split(":")[0]) * 60 +
      parseInt(body.start_time.split(":")[1]) +
      durationMinutes;
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;

    await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO lab_test_appointments (
          id, appointment_number, patient_id, clinic_id, branch_id, branch_lab_test_id, test_id,
          service_mode, appointment_date, start_time, end_time, duration_minutes,
          price, currency, payment_method, payment_status,
          prescription_required, prescription_id,
          patient_notes, home_address, home_lat, home_lng, home_contact_phone, home_notes,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
        [
          appointmentId,
          appointmentNumber,
          auth.userId,
          branch.clinic_id,
          body.branch_id,
          body.branch_lab_test_id,
          blt.test_id,
          body.service_mode,
          body.appointment_date,
          body.start_time,
          endTime,
          durationMinutes,
          blt.price,
          blt.currency,
          body.payment_method,
          body.payment_method === "ONLINE" ? "PENDING" : "UNPAID",
          blt.prescription_required ? 1 : 0,
          body.prescription_id ?? null,
          body.patient_notes ?? null,
          body.home_address ?? null,
          body.home_lat ?? null,
          body.home_lng ?? null,
          body.home_contact_phone ?? null,
          body.home_notes ?? null,
        ],
      );

      if (body.prescription_id) {
        await conn.query(
          `INSERT INTO lab_test_prescriptions (id, patient_id, appointment_id, file_name, file_url, mime_type, file_size, uploaded_at)
           SELECT id, patient_id, ?, file_name, file_url, mime_type, size_bytes, uploaded_at
           FROM medical_documents WHERE id = ? AND patient_id = ?`,
          [appointmentId, body.prescription_id, auth.userId],
        );
      }

      await conn.query(
        `INSERT INTO lab_test_payments (id, appointment_id, patient_id, amount, currency, payment_method, payment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId(), appointmentId, auth.userId, blt.price, blt.currency, body.payment_method, body.payment_method === "ONLINE" ? "PENDING" : "UNPAID"],
      );

      const notifyPayload = {
        appointment_id: appointmentId,
        appointment_number: appointmentNumber,
        test_name: blt.test_name,
        date: body.appointment_date,
        time: body.start_time,
        branch_name: branch.name,
      };
      await notifyBranchStaff(conn, body.branch_id, "lab_test_booked", notifyPayload);
      await createNotification(conn, branch.owner_user_id, "lab_test_booked", notifyPayload, body.branch_id);

      await auditLabAction(conn, auth.userId, "appointment_created", appointmentId, {
        branch_id: body.branch_id,
        branch_lab_test_id: body.branch_lab_test_id,
        appointment_date: body.appointment_date,
        start_time: body.start_time,
        service_mode: body.service_mode,
      });
    });

    const [saved] = await pool.query<RowDataPacket[]>(
      `SELECT a.*, lt.name AS test_name, lt.code AS test_code, lt.category AS test_category,
              b.name AS branch_name, c.name AS clinic_name,
              u.name AS patient_name, u.email AS patient_email, u.phone AS patient_phone
         FROM lab_test_appointments a
         JOIN lab_tests lt ON lt.id = a.test_id
         JOIN branches b ON b.id = a.branch_id
         JOIN clinics c ON c.id = a.clinic_id
         JOIN users u ON u.id = a.patient_id
       WHERE a.id = ?`,
      [appointmentId],
    );

    const appointment = saved[0];

    const staffEmails = await branchContactEmails(pool, body.branch_id);
    const [patientRows] = await pool.query<RowDataPacket[]>(
      `SELECT name, email FROM users WHERE id = ?`,
      [auth.userId],
    );
    const patient = patientRows[0];

    const emailSubject = `New Lab Test Booking — ${appointmentNumber}`;
    const emailBody = detailsEmailHtml({
      heading: "New Lab Test Booking",
      intro: `A patient has submitted a lab test booking for your review.`,
      rows: [
        { label: "Appointment Number", value: appointmentNumber },
        { label: "Patient", value: patient?.name ?? "Unknown", sub: patient?.email ?? "" },
        { label: "Test", value: blt.test_name },
        { label: "Branch", value: branch.name },
        { label: "Date & Time", value: `${body.appointment_date} at ${body.start_time}`, sub: body.service_mode === "HOME" ? "Home Collection" : "Clinic Visit" },
        { label: "Payment", value: body.payment_method === "ONLINE" ? "Online (Pending)" : "Pay at Clinic" },
      ],
      note: "Please review the prescription (if uploaded) and approve or reject this booking.",
    });

    for (const email of staffEmails) {
      await sendEmail(email, emailSubject, "", emailBody);
    }

    return { status: 201, body: serializeLabTestAppointment(appointment) };
  });

  return json(result.body, result.status);
});
