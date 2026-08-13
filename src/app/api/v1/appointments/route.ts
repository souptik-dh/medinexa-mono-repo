import { z } from "zod";
import { api, json, decodeCursor } from "@/lib/http";
import { pool, withTransaction, type Row } from "@/lib/db";
import { parseBody, idSchema, timeSchema, parsePagination } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { badRequest, conflict, notFound, unprocessable, isUniqueViolation } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { runIdempotent } from "@/lib/idempotency";
import { scopeWhere, serializeAppointment, APPT_STATUSES } from "@/lib/appointments";
import { notifyBranchStaff, createNotification, branchContactEmails, sendEmail } from "@/lib/notifications";
import {
  todayInTz,
  weekdayInTz,
  currentTimeKeyInTz,
  generateSlotTimes,
  findNextSequentialSlot,
} from "@/lib/availability";
import { fetchPage } from "@/lib/pagination";

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

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: `SELECT a.*,
                    (SELECT d.name FROM doctors d WHERE d.id = a.doctor_id) AS doctor_name,
                    (SELECT b.name FROM branches b WHERE b.id = a.branch_id) AS branch_name`,
    from: "FROM appointments a",
    where: whereParts.join(" AND "),
    params,
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({
    items: rows.map(serializeAppointment),
    next_cursor: nextCursor,
  });
});

const schema = z.object({
  doctor_id: idSchema,
  branch_id: idSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  time: timeSchema.optional(),
});

export const POST = api({ rateLimit: 20 }, async (ctx) => {
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

    const tz = branch.timezone as string;
    const today = todayInTz(tz);
    if (body.date < today) {
      throw unprocessable("DATE_IN_PAST", "The appointment date is in the past.");
    }

    const wd = weekdayInTz(body.date, tz);
    const [templates] = await pool.query<Row[]>(
      `SELECT dst.start_time, dst.end_time, dst.slot_duration_minutes, dba.slot_type
         FROM doctor_slot_templates dst
         JOIN doctor_branch_assignments dba ON dba.id = dst.doctor_branch_assignment_id
        WHERE dba.doctor_id = ? AND dba.branch_id = ? AND dba.is_active = 1
          AND dst.weekday = ? AND dst.start_date <= ? AND (dst.end_date IS NULL OR dst.end_date >= ?)
          AND NOT EXISTS (
            SELECT 1 FROM doctor_slot_exceptions dse
             WHERE dse.doctor_branch_assignment_id = dba.id AND dse.excluded_date = ?
          )`,
      [body.doctor_id, body.branch_id, wd, body.date, body.date, body.date],
    );
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

    const [assignments] = await pool.query<Row[]>(
      `SELECT dba.id, dba.fee_amount, dba.currency
         FROM doctor_branch_assignments dba
         JOIN doctors d ON d.id = dba.doctor_id AND d.deleted_at IS NULL
        WHERE dba.doctor_id = ? AND dba.branch_id = ? AND dba.is_active = 1`,
      [body.doctor_id, body.branch_id],
    );
    const assignment = assignments[0];
    if (!assignment) throw notFound("DOCTOR_NOT_FOUND", "Doctor is not assigned to this branch.");

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
          const payload = {
            appointment_id: id,
            doctor_id: body.doctor_id,
            patient_id: auth.userId,
            date: body.date,
            time: scheduledTime,
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

    const [rows] = await pool.query<Row[]>(`SELECT * FROM appointments WHERE id = ?`, [id]);

    const [details] = await pool.query<Row[]>(
      `SELECT u.name AS patient_name, u.email AS patient_email, u.phone AS patient_phone,
              d.name AS doctor_name, b.name AS branch_name
         FROM appointments a
         JOIN users u ON u.id = a.patient_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN branches b ON b.id = a.branch_id
        WHERE a.id = ?`,
      [id],
    );
    const info = details[0];
    if (info) {
      const recipients = await branchContactEmails(pool, body.branch_id);
      const subject = `New appointment booked — ${info.patient_name ?? "Patient"} with Dr. ${info.doctor_name}`;
      const emailBody = [
        `A new appointment has been booked at ${info.branch_name}.`,
        "",
        `Patient: ${info.patient_name ?? "-"}`,
        `Email: ${info.patient_email ?? "-"}`,
        `Phone: ${info.patient_phone ?? "-"}`,
        `Doctor: Dr. ${info.doctor_name}`,
        `Date: ${body.date} at ${scheduledTime}`,
      ].join("\n");
      await Promise.all(recipients.map((email) => sendEmail(email, subject, emailBody)));
    }

    return { status: 201, body: serializeAppointment(rows[0]) };
  });

  return json(result.body, result.status);
});
