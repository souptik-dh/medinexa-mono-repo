import { z } from "zod";
import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { computeDaySlots } from "@/lib/availability";

const querySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});

export const GET = api(undefined, async (ctx) => {
  const doctorId = ctx.params.id;
  const rawDate = ctx.request.nextUrl.searchParams.get("date") ?? "";
  const parsed = querySchema.safeParse({ date: rawDate });
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Invalid date.",
          field: "date",
          request_id: ctx.reqId,
        },
      },
      422,
    );
  }
  const date = parsed.data.date;

  const [doctors] = await pool.query<Row[]>(
    `SELECT id FROM doctors WHERE id = ? AND deleted_at IS NULL`,
    [doctorId],
  );
  if (!doctors[0]) throw notFound("DOCTOR_NOT_FOUND", "Doctor not found.");

  const [tzRows] = await pool.query<Row[]>(
    `SELECT b.timezone FROM doctor_branch_assignments dba
       JOIN branches b ON b.id = dba.branch_id AND b.deleted_at IS NULL
      WHERE dba.doctor_id = ? AND dba.is_active = 1
      LIMIT 1`,
    [doctorId],
  );
  const tz = tzRows[0]?.timezone ?? "UTC";

  const slots = await computeDaySlots(pool, doctorId, date, tz);
  return json({ date, slots });
});
