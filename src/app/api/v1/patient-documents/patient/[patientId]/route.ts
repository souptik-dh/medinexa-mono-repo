import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";
import { assertBranchStaffPermission } from "@/lib/permissions";
import {
  DOCUMENT_TYPES,
  DOCUMENT_SELECT_JOIN,
  assertPatientExists,
  serializeDocument,
  serializeDelivery,
  latestByChannel,
} from "@/lib/patient-documents";
import type { RowDataPacket } from "mysql2/promise";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "sys_admin"]);
  const { patientId } = ctx.params;

  // Strict ownership: a patient may only ever list their OWN documents — the exact
  // IDOR this endpoint shape invites (?patientId=someone-else's-id) is blocked by
  // never trusting the path param for the "who am I" question when the caller is a
  // patient. 404 (not 403) so the response can't be used to probe which patient ids
  // exist.
  if (auth.role === "patient") {
    if (patientId !== auth.userId) {
      throw notFound("PATIENT_NOT_FOUND", "Patient not found.");
    }
  } else if (auth.role !== "sys_admin") {
    await assertPatientExists(pool, patientId);
    if (auth.role === "branch_staff") {
      if (!auth.branchId) throw notFound("BRANCH_NOT_FOUND", "Branch not found.");
      await assertBranchStaffPermission(pool, auth, auth.branchId, "patient_documents:view");
    }
    // clinic_owner scope is applied via the WHERE clause below (own clinics only);
    // branch_staff is scoped to their own branch only, not every branch of the clinic.
  }

  const sp = ctx.request.nextUrl.searchParams;
  const documentType = sp.get("document_type");
  if (documentType && !(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    throw badRequest("VALIDATION_ERROR", `document_type must be one of: ${DOCUMENT_TYPES.join(", ")}.`, "document_type");
  }
  const status = sp.get("status");
  if (status && !["PENDING", "GENERATED"].includes(status)) {
    throw badRequest("VALIDATION_ERROR", "status must be PENDING or GENERATED.", "status");
  }
  const date = sp.get("date");
  if (date && !DATE_RE.test(date)) {
    throw badRequest("VALIDATION_ERROR", "date must be YYYY-MM-DD.", "date");
  }

  const where: string[] = ["pd.patient_id = ?", "pd.deleted_at IS NULL"];
  const params: unknown[] = [patientId];

  if (auth.role === "clinic_owner") {
    where.push("pd.clinic_id IN (SELECT id FROM clinics WHERE owner_user_id = ? AND deleted_at IS NULL)");
    params.push(auth.userId);
  } else if (auth.role === "branch_staff") {
    where.push("pd.branch_id = ?");
    params.push(auth.branchId);
  }
  if (documentType) {
    where.push("pd.document_type = ?");
    params.push(documentType);
  }
  if (status) {
    where.push("pd.status = ?");
    params.push(status);
  }
  if (date) {
    where.push("DATE(pd.uploaded_at) = ?");
    params.push(date);
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `${DOCUMENT_SELECT_JOIN} WHERE ${where.join(" AND ")} ORDER BY pd.uploaded_at DESC`,
    params,
  );

  if (rows.length === 0) {
    return json({ items: [] });
  }

  const ids = rows.map((r) => r.id);
  const [deliveryRows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM patient_document_deliveries WHERE document_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at ASC`,
    ids,
  );
  const byDocument = new Map<string, RowDataPacket[]>();
  for (const d of deliveryRows) {
    const list = byDocument.get(d.document_id) ?? [];
    list.push(d);
    byDocument.set(d.document_id, list);
  }

  return json({
    items: rows.map((r) => {
      const deliveries = byDocument.get(r.id) ?? [];
      const latest = latestByChannel(deliveries);
      return {
        ...serializeDocument(r),
        delivery_summary: {
          APP: latest.APP ? serializeDelivery(latest.APP) : null,
          EMAIL: latest.EMAIL ? serializeDelivery(latest.EMAIL) : null,
          PRINT: latest.PRINT ? serializeDelivery(latest.PRINT) : null,
        },
      };
    }),
  });
});
