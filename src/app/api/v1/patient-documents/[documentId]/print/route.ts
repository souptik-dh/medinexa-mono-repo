import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { assertClinicOperational } from "@/lib/subscriptions";
import {
  getClinicVisibleDocument,
  assertDocumentActionPermission,
  recordDelivery,
  serializeDelivery,
  auditPatientDocumentAction,
} from "@/lib/patient-documents";
import type { RowDataPacket } from "mysql2/promise";

// Called by the clinic app right after it opens the print-ready view / triggers the
// browser print dialog (see AGENTS.md: this is a client-driven action, there's no
// portable "the user actually finished printing" signal to wait for) — so recording
// DELIVERED here reflects "print was initiated", not a guess at physical completion.
export const POST = api({ rateLimit: 100 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const { documentId } = ctx.params;

  const doc = await getClinicVisibleDocument(pool, documentId, auth);
  await assertDocumentActionPermission(pool, auth, doc, "patient_documents:print");
  await assertClinicOperational(pool, doc.clinic_id);

  const deliveryId = await recordDelivery(pool, {
    documentId,
    method: "PRINT",
    status: "DELIVERED",
    deliveredAt: new Date(),
    attemptedBy: auth.userId,
  });
  await auditPatientDocumentAction(pool, auth.userId, "document_printed", documentId, {
    patient_id: doc.patient_id,
  });

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT pdd.*, u.name AS attempted_by_name
       FROM patient_document_deliveries pdd
       LEFT JOIN users u ON u.id = pdd.attempted_by
      WHERE pdd.id = ?`,
    [deliveryId],
  );
  return json(serializeDelivery(rows[0]), 201);
});
