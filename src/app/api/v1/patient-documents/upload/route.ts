import { api, json, requestOrigin } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool, withTransaction } from "@/lib/db";
import { newId } from "@/lib/ids";
import { badRequest } from "@/lib/errors";
import { uploadDocumentToCloudinary } from "@/lib/cloudinary";
import { assertClinicOperational } from "@/lib/subscriptions";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { createPatientNotification } from "@/lib/notifications";
import {
  DOCUMENT_TYPES,
  DOCUMENT_MIMES,
  MAX_DOCUMENT_BYTES,
  DOCUMENT_SELECT_JOIN,
  resolveDocumentBranch,
  assertPatientExists,
  serializeDocument,
  recordDelivery,
  auditPatientDocumentAction,
  type DocumentType,
} from "@/lib/patient-documents";
import type { RowDataPacket } from "mysql2/promise";

function requireField(form: FormData, key: string, max: number): string {
  const raw = form.get(key);
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw badRequest("VALIDATION_ERROR", `${key} is required.`, key);
  }
  const value = raw.trim();
  if (value.length > max) {
    throw badRequest("VALIDATION_ERROR", `${key} must be at most ${max} characters.`, key);
  }
  return value;
}

function parseDocumentType(form: FormData): DocumentType {
  const raw = form.get("document_type");
  if (typeof raw === "string" && (DOCUMENT_TYPES as readonly string[]).includes(raw)) {
    return raw as DocumentType;
  }
  throw badRequest(
    "VALIDATION_ERROR",
    `document_type must be one of: ${DOCUMENT_TYPES.join(", ")}.`,
    "document_type",
  );
}

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const form = await ctx.request.formData();

  const patientId = requireField(form, "patient_id", 36);
  const documentType = parseDocumentType(form);
  const title = requireField(form, "title", 255);
  const descriptionRaw = form.get("description");
  const description =
    typeof descriptionRaw === "string" && descriptionRaw.trim().length > 0
      ? descriptionRaw.trim().slice(0, 2000)
      : null;
  const requestedBranchId = typeof form.get("branch_id") === "string" ? (form.get("branch_id") as string) : null;

  // clinic_id/branch_id are resolved+verified server-side (never trusted from the
  // client) — pinned to the staff member's own branch, or checked against the
  // owner's actual branches.
  const { branchId, clinicId } = await resolveDocumentBranch(pool, auth, requestedBranchId);
  await assertPatientExists(pool, patientId);
  if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, branchId, "patient_documents:upload");
  }
  await assertClinicOperational(pool, clinicId);

  const file = form.get("file");
  // Uploaded to Cloudinary rather than local disk — this API is served from Render,
  // where the local filesystem is wiped on every redeploy/restart (see the note in
  // send-email/route.ts), so patient documents need storage that outlives the dyno.
  const saved = await uploadDocumentToCloudinary(file, "patient-document", MAX_DOCUMENT_BYTES, DOCUMENT_MIMES);
  const originalName = file instanceof File ? file.name : "document";

  const id = newId();
  await withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO patient_documents
         (id, patient_id, clinic_id, branch_id, document_type, title, description,
          file_name, file_key, file_size, mime_type, uploaded_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'GENERATED')`,
      [
        id,
        patientId,
        clinicId,
        branchId,
        documentType,
        title,
        description,
        originalName,
        saved.url,
        saved.size,
        saved.mime,
        auth.userId,
      ],
    );
    // Every generated document is immediately available in the patient app — recorded
    // as its own delivery-history row (APP channel), same as EMAIL/PRINT.
    await recordDelivery(conn, {
      documentId: id,
      method: "APP",
      status: "DELIVERED",
      deliveredAt: new Date(),
      attemptedBy: auth.userId,
    });
    await auditPatientDocumentAction(conn, auth.userId, "document_uploaded", id, {
      patient_id: patientId,
      clinic_id: clinicId,
      branch_id: branchId,
      document_type: documentType,
    });
  });

  await createPatientNotification(pool, patientId, "patient_document_uploaded", {
    document_id: id,
    title,
    document_type: documentType,
  });

  const [rows] = await pool.query<RowDataPacket[]>(`${DOCUMENT_SELECT_JOIN} WHERE pd.id = ?`, [id]);
  return json(serializeDocument(rows[0], requestOrigin(ctx.request)), 201);
});
