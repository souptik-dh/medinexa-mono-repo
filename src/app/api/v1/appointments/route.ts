import { z } from "zod";
import { api, json, decodeCursor } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody, idSchema, timeSchema, parsePagination } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { badRequest, conflict, notFound, unprocessable, isUniqueViolation } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { runIdempotent } from "@/lib/idempotency";
import { scopeWhere, serializeAppointment, APPT_STATUSES } from "@/lib/appointments";
import { notifyBranchStaff, createNotification, branchContactEmails, sendEmail, detailsEmailHtml } from "@/lib/notifications";
import {
  todayInTz,
  weekdayInTz,
  currentTimeKeyInTz,
  generateSlotTimes,
  findNextSequentialSlot,
  getBranchSchedule,
  isWeekdayOpen,
  findCoveringLeave,
} from "@/lib/availability";
import { fetchPage } from "@/lib/pagination";
import { assertClinicOperational } from "@/lib/subscriptions";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  const sp = ctx.request.nextUrl.searchParams;
  const { limit, cursor } = parsePagination(sp);

  const whereParts: string[] = [];
  const params: unknown[] = [];
  const scope = scopeWhere(auth);
  whereParts.push(scope.where);
  params.push(...scope.params);

  const clinicId = sp.get("clinic_id");
  if (clinicId) {
    whereParts.push("a.clinic_id = ?");
    params.push(clinicId);
  }
  const status = sp.get("status");
  if (status) {
    if (!(APPT_STATUSES as readonly string[]).includes(status)) {
      throw badRequest("VALIDATION_ERROR", "Invalid appointment status filter.");
    }
    whereParts.push("a.status = ?");
    params.push(status);
  }
  const dateFrom = sp.get("date_from");
  if (dateFrom) {
    if (!DATE_RE.test(dateFrom)) throw badRequest("VALIDATION_ERROR", "date_from must be YYYY-MM-DD.");
    whereParts.push("a.scheduled_date >= ?");
    params.push(dateFrom);
  }
  const dateTo = sp.get("date_to");
  if (dateTo) {
    if (!DATE_RE.test(dateTo)) throw badRequest("VALIDATION_ERROR", "date_to must be YYYY-MM-DD.");
    whereParts.push("a.scheduled_date <= ?");
    params.push(dateTo);
  }

  // Filters live inside the derived table (rather than as fetchPage's `where`) so the
  // outer query only ever sees one set of `created_at`/`id` columns — appointment_patients
  // has its own `id`/`created_at`, which would otherwise make the cursor clause ambiguous.
  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: "SELECT *",
    from: `FROM (
        SELECT a.*,
               (SELECT d.name FROM doctors d WHERE d.id = a.doctor_id) AS doctor_name,
               (SELECT d.photo_url FROM doctors d WHERE d.id = a.doctor_id) AS doctor_photo_url,
               (SELECT b.name FROM branches b WHERE b.id = a.branch_id) AS branch_name,
               ap.relationship AS visitor_relationship, ap.name AS visitor_name,
               ap.phone AS visitor_phone, ap.age AS visitor_age, ap.gender AS visitor_gender
          FROM appointments a
          LEFT JOIN appointment_patients ap ON ap.appointment_id = a.id
         WHERE ${whereParts.join(" AND ")}
      ) t`,
    params,
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({
    items: rows.map(serializeAppointment),
    next_cursor: nextCursor,
  });
});

const patientDetailsSchema = z.object({
  relationship: z.enum(["self", "spouse", "child", "parent", "sibling", "friend", "other"]).default("self"),
  name: z.string().trim().min(1).max(255),
  phone: z.string().trim().max(32).optional().nullable(),
  age: z.number().int().min(0).max(150).optional().nullable(),
  gender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional().nullable(),
});

const schema = z.object({
  doctor_id: idSchema,
  branch_id: idSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  time: timeSchema.optional(),
  // Omit entirely to book for the account holder — defaults to their own name/phone below.
  patient_details: patientDetailsSchema.optional(),
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
  const body = parseBody(schema, parsedJson);

  const result = await runIdempotent("appointments:create", idemKey, rawBody, async () => {
    const [branches] = await pool.query<Row[]>(
      `SELECT b.id, b.timezone, b.clinic_id, c.owner_user_id
         FROM branches b
         JOIN clinics c ON c.id = b.clinic_id
        WHERE b.id = ? AND b.deleted_at IS NULL AND c.deleted_at IS NULL`,
      [body.branch_id],
    );
    const branch = branches[0];
    if (!branch) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");

    // New bookings are rejected while the clinic's subscription is inactive.
    await assertClinicOperational(pool, branch.clinic_id);

    const tz = branch.timezone as string;
    const today = todayInTz(tz);
    if (body.date < today) {
      throw unprocessable("DATE_IN_PAST", "The appointment date is in the past.");
    }
    const branchWeekday = weekdayInTz(body.date, tz);

    // None of these reads depends on another's result (all key off doctor_id/branch_id/
    // date, known already), so they run as one round trip instead of four sequential
    // ones. Their errors are still evaluated and thrown below in the same priority
    // order the original sequential checks used.
    const [branchSchedule, [leaveRows], [templates], [assignments], selfRows] = await Promise.all([
      getBranchSchedule(pool, body.branch_id, { from: body.date, to: body.date }),
      pool.query<Row[]>(
        `SELECT dse.id FROM doctor_slot_exceptions dse
           JOIN doctor_branch_assignments dba ON dba.id = dse.doctor_branch_assignment_id
          WHERE dba.doctor_id = ? AND dba.branch_id = ? AND dba.is_active = 1
            AND dse.status = 'active' AND dse.excluded_date <= ? AND COALESCE(dse.end_date, dse.excluded_date) >= ?
          LIMIT 1`,
        [body.doctor_id, body.branch_id, body.date, body.date],
      ),
      pool.query<Row[]>(
        `SELECT dst.start_time, dst.end_time, dst.slot_duration_minutes, dba.slot_type
           FROM doctor_slot_templates dst
           JOIN doctor_branch_assignments dba ON dba.id = dst.doctor_branch_assignment_id
          WHERE dba.doctor_id = ? AND dba.branch_id = ? AND dba.is_active = 1
            AND dst.weekday = ? AND dst.start_date <= ? AND (dst.end_date IS NULL OR dst.end_date >= ?)`,
        [body.doctor_id, body.branch_id, branchWeekday, body.date, body.date],
      ),
      pool.query<Row[]>(
        `SELECT dba.id, dba.fee_amount, dba.currency
           FROM doctor_branch_assignments dba
           JOIN doctors d ON d.id = dba.doctor_id AND d.deleted_at IS NULL
          WHERE dba.doctor_id = ? AND dba.branch_id = ? AND dba.is_active = 1`,
        [body.doctor_id, body.branch_id],
      ),
      body.patient_details
        ? Promise.resolve(null)
        : pool.query<Row[]>(`SELECT name, phone FROM users WHERE id = ?`, [auth.userId]).then(([rows]) => rows),
    ]);

    // Branch-level gate checked first — it's the outermost constraint (a doctor can
    // never be bookable on a day/date the branch itself isn't open), so it gets its
    // own conflict code rather than being folded into DOCTOR_ON_LEAVE.
    if (!isWeekdayOpen(branchSchedule, branchWeekday) || findCoveringLeave(body.date, branchSchedule.closures)) {
      throw conflict("CLINIC_CLOSED", "The clinic is closed on the selected date.");
    }

    // Checked separately (and before the weekday/template match) so a booking blocked by
    // an active leave gets the specific DOCTOR_ON_LEAVE conflict rather than being folded
    // into the generic OUTSIDE_DOCTOR_AVAILABILITY case — this is what stops a client from
    // bypassing the disabled calendar day by calling the booking API directly.
    if (leaveRows[0]) {
      throw conflict("DOCTOR_ON_LEAVE", "Doctor is unavailable on the selected date.");
    }

    const template = templates[0];
    if (!template) {
      throw unprocessable(
        "OUTSIDE_DOCTOR_AVAILABILITY",
        "The doctor is not available on this date.",
      );
    }

    const isSequential = template.slot_type === "sequential";
    const dur = Number(template.slot_duration_minutes);
    let scheduledTime: string;

    if (isSequential) {
      const next = await findNextSequentialSlot(pool, body.doctor_id, body.branch_id, body.date, tz);
      if (!next) {
        throw conflict(
          "DOCTOR_FULLY_BOOKED",
          "No slots are left for this doctor on the selected date.",
        );
      }
      scheduledTime = next;
    } else {
      if (!body.time) {
        throw badRequest("VALIDATION_ERROR", "time is required.", "time");
      }
      let aligned = false;
      for (const key of generateSlotTimes(template.start_time, template.end_time, dur)) {
        if (key === body.time) aligned = true;
      }
      if (!aligned) {
        throw unprocessable(
          "OUTSIDE_DOCTOR_AVAILABILITY",
          "The requested time is not an available slot for this doctor.",
        );
      }
      if (body.date === today && body.time <= currentTimeKeyInTz(tz)) {
        throw unprocessable("DATE_IN_PAST", "This time slot has already passed.");
      }
      scheduledTime = body.time;
    }

    const assignment = assignments[0];
    if (!assignment) throw notFound("DOCTOR_NOT_FOUND", "Doctor is not assigned to this branch.");

    // Defaults to the account holder's own name/phone when patient_details is omitted
    // (the common "booking for myself" case).
    let patientDetails = body.patient_details;
    if (!patientDetails) {
      const self = selfRows?.[0];
      patientDetails = { relationship: "self", name: self?.name ?? "Self", phone: self?.phone ?? null, age: null, gender: null };
    }

    const id = newId();
    const triedTimes = new Set<string>();
    let attemptsLeft = isSequential ? 25 : 1;
    for (;;) {
      try {
        await withTransaction(async (conn) => {
          await conn.query(
            `INSERT INTO appointments
               (id, patient_id, clinic_id, branch_id, doctor_id, scheduled_date, scheduled_time, duration_minutes, status, fee_amount, currency)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [
              id,
              auth.userId,
              branch.clinic_id,
              body.branch_id,
              body.doctor_id,
              body.date,
              scheduledTime,
              dur,
              assignment.fee_amount,
              assignment.currency,
            ],
          );
          await conn.query(
            `INSERT INTO appointment_patients (id, appointment_id, relationship, name, phone, age, gender)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              newId(),
              id,
              patientDetails.relationship,
              patientDetails.name,
              patientDetails.phone ?? null,
              patientDetails.age ?? null,
              patientDetails.gender ?? null,
            ],
          );
          const payload = {
            appointment_id: id,
            doctor_id: body.doctor_id,
            patient_id: auth.userId,
            date: body.date,
            time: scheduledTime,
            visitor_name: patientDetails.name,
            visitor_relationship: patientDetails.relationship,
          };
          await notifyBranchStaff(conn, body.branch_id, "new_booking", payload);
          await createNotification(conn, branch.owner_user_id, "new_booking", payload, body.branch_id);
        });
        break;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (!isSequential) {
          throw conflict(
            "SLOT_ALREADY_BOOKED",
            "This time slot was just taken. Please choose another.",
          );
        }
        triedTimes.add(scheduledTime);
        attemptsLeft -= 1;
        const next: string | null =
          attemptsLeft > 0
            ? await findNextSequentialSlot(pool, body.doctor_id, body.branch_id, body.date, tz, triedTimes)
            : null;
        if (!next) {
          throw conflict(
            "DOCTOR_FULLY_BOOKED",
            "No slots are left for this doctor on the selected date.",
          );
        }
        scheduledTime = next;
      }
    }

    // Independent reads — none depends on the others — so they run as one round trip.
    const [[rows], [details], recipients] = await Promise.all([
      pool.query<Row[]>(
        `SELECT a.*, ap.relationship AS visitor_relationship, ap.name AS visitor_name,
                ap.phone AS visitor_phone, ap.age AS visitor_age, ap.gender AS visitor_gender
           FROM appointments a
           LEFT JOIN appointment_patients ap ON ap.appointment_id = a.id
          WHERE a.id = ?`,
        [id],
      ),
      pool.query<Row[]>(
        `SELECT u.name AS patient_name, u.email AS patient_email, u.phone AS patient_phone,
                d.name AS doctor_name, b.name AS branch_name
           FROM appointments a
           JOIN users u ON u.id = a.patient_id
           JOIN doctors d ON d.id = a.doctor_id
           JOIN branches b ON b.id = a.branch_id
          WHERE a.id = ?`,
        [id],
      ),
      branchContactEmails(pool, body.branch_id),
    ]);
    const info = details[0];
    if (info) {
      const isForSelf = patientDetails.relationship === "self";
      const subject = `New appointment booked — ${patientDetails.name} with Dr. ${info.doctor_name}`;
      const emailBody = [
        `A new appointment has been booked at ${info.branch_name}.`,
        "",
        `Visiting patient: ${patientDetails.name}${isForSelf ? "" : ` (${patientDetails.relationship} of ${info.patient_name ?? "the account holder"})`}`,
        ...(patientDetails.phone ? [`Visiting patient phone: ${patientDetails.phone}`] : []),
        "",
        `Booked by: ${info.patient_name ?? "-"}`,
        `Email: ${info.patient_email ?? "-"}`,
        `Phone: ${info.patient_phone ?? "-"}`,
        "",
        `Doctor: Dr. ${info.doctor_name}`,
        `Date: ${body.date} at ${scheduledTime}`,
      ].join("\n");
      const emailHtmlBody = detailsEmailHtml({
        heading: "New Appointment Booked",
        intro: `A new appointment has been confirmed at ${info.branch_name}.`,
        rows: [
          { label: "Doctor", value: `Dr. ${info.doctor_name}` },
          { label: "Date & Time", value: `${body.date} at ${scheduledTime}` },
          {
            label: "Visiting Patient",
            value: patientDetails.name,
            sub: isForSelf
              ? patientDetails.phone
                ? `Phone: ${patientDetails.phone}`
                : undefined
              : `${patientDetails.relationship} of ${info.patient_name ?? "the account holder"}${patientDetails.phone ? ` · Phone: ${patientDetails.phone}` : ""}`,
          },
          {
            label: "Booked By",
            value: info.patient_name ?? "-",
            sub: `${info.patient_email ?? "-"} · Phone: ${info.patient_phone ?? "-"}`,
          },
        ],
      });
      // sendEmail already catches its own errors — no reason to hold the response on
      // Brevo's round trip once the booking itself is committed.
      void Promise.all(recipients.map((email) => sendEmail(email, subject, emailBody, emailHtmlBody)));
    }

    return { status: 201, body: serializeAppointment(rows[0]) };
  });

  return json(result.body, result.status);
});
