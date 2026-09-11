import { api, json, noContent, requestOrigin } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import {
  getClinicVisibleDocument,
  getOwnDocument,
  assertDocumentActionPermission,
  serializeDocument,
  serializeDelivery,
  latestByChannel,
  auditPatientDocumentAction,
} from "@/lib/patient-documents";
import { assertBranchStaffPermission } from "@/lib/permissions";
import type { RowDataPacket } from "mysql2/promise";

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "clinic_owner", "branch_staff", "sys_admin"]);
  const { documentId } = ctx.params;

  const doc =
    auth.role === "patient"
      ? await getOwnDocument(pool, documentId, auth.userId)
      : await getClinicVisibleDocument(pool, documentId, auth);

  if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, doc.branch_id, "patient_documents:view");
  }

  const [deliveryRows] = await pool.query<RowDataPacket[]>(
    `SELECT pdd.*, u.name AS attempted_by_name
       FROM patient_document_deliveries pdd
       LEFT JOIN users u ON u.id = pdd.attempted_by
      WHERE pdd.document_id = ? ORDER BY pdd.created_at ASC`,
    [documentId],
  );
  const latest = latestByChannel(deliveryRows);

  return json({
    ...serializeDocument(doc, requestOrigin(ctx.request)),
    delivery_summary: {
      APP: latest.APP ? serializeDelivery(latest.APP) : null,
      EMAIL: latest.EMAIL ? serializeDelivery(latest.EMAIL) : null,
      PRINT: latest.PRINT ? serializeDelivery(latest.PRINT) : null,
    },
    deliveries: deliveryRows.map(serializeDelivery),
  });
});

export const DELETE = api({ rateLimit: 20 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff", "sys_admin"]);
  const { documentId } = ctx.params;

  const doc = await getClinicVisibleDocument(pool, documentId, auth);
  await assertDocumentActionPermission(pool, auth, doc, "patient_documents:delete");

  await pool.query(`UPDATE patient_documents SET deleted_at = NOW(3) WHERE id = ?`, [documentId]);
  await auditPatientDocumentAction(pool, auth.userId, "document_deleted", documentId, {
    patient_id: doc.patient_id,
  });

  return noContent();
});
