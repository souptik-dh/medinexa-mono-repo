import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"] as const;

const SELECT_FIELDS =
  "patient_id, blood_group, allergies, medical_conditions, current_medications, previous_surgeries, medical_notes, emergency_contact_name, emergency_contact_relationship, emergency_contact_phone, updated_at";

function toMedicalInfo(patientId: string, r: Row | undefined) {
  return {
    patient_id: patientId,
    blood_group: r?.blood_group ?? null,
    allergies: r?.allergies ?? null,
    medical_conditions: r?.medical_conditions ?? null,
    current_medications: r?.current_medications ?? null,
    previous_surgeries: r?.previous_surgeries ?? null,
    medical_notes: r?.medical_notes ?? null,
    emergency_contact: {
      name: r?.emergency_contact_name ?? null,
      relationship: r?.emergency_contact_relationship ?? null,
      phone: r?.emergency_contact_phone ?? null,
    },
    updated_at: r?.updated_at ?? null,
  };
}

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const [rows] = await pool.query<Row[]>(
    `SELECT ${SELECT_FIELDS} FROM patient_medical_profile WHERE patient_id = ?`,
    [auth.userId],
  );
  return json(toMedicalInfo(auth.userId, rows[0]));
});

const putSchema = z.object({
  blood_group: z.enum(BLOOD_GROUPS).nullable().optional(),
  allergies: z.string().trim().max(2000).nullable().optional(),
  medical_conditions: z.string().trim().max(2000).nullable().optional(),
  current_medications: z.string().trim().max(2000).nullable().optional(),
  previous_surgeries: z.string().trim().max(2000).nullable().optional(),
  medical_notes: z.string().trim().max(2000).nullable().optional(),
  emergency_contact_name: z.string().trim().max(255).nullable().optional(),
  emergency_contact_relationship: z.string().trim().max(100).nullable().optional(),
  emergency_contact_phone: z.string().trim().max(32).nullable().optional(),
});

const MEDICAL_INFO_COLUMNS = [
  "blood_group",
  "allergies",
  "medical_conditions",
  "current_medications",
  "previous_surgeries",
  "medical_notes",
  "emergency_contact_name",
  "emergency_contact_relationship",
  "emergency_contact_phone",
] as const;

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const body = parseBody(putSchema, await readJson(ctx.request));

  const columns = MEDICAL_INFO_COLUMNS.filter((key) => body[key] !== undefined);
  if (columns.length > 0) {
    const values = columns.map((key) => body[key] ?? null);
    const placeholders = columns.map(() => "?").join(", ");
    const updateClause = columns.map((c) => `${c} = VALUES(${c})`).join(", ");
    await pool.query(
      `INSERT INTO patient_medical_profile (patient_id, ${columns.join(", ")})
       VALUES (?, ${placeholders})
       ON DUPLICATE KEY UPDATE ${updateClause}`,
      [auth.userId, ...values],
    );
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT ${SELECT_FIELDS} FROM patient_medical_profile WHERE patient_id = ?`,
    [auth.userId],
  );
  return json(toMedicalInfo(auth.userId, rows[0]));
});
