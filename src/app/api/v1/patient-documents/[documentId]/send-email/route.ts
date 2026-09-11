import { z } from "zod";
import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool, withTransaction } from "@/lib/db";
import { parseBody, emailSchema } from "@/lib/validators";
import { assertClinicOperational } from "@/lib/subscriptions";
import { sendEmail, detailsEmailHtml } from "@/lib/notifications";
import { signFileUrl } from "@/lib/upload";
import {
  getClinicVisibleDocument,
  assertDocumentActionPermission,
  recordDelivery,
  serializeDelivery,
  auditPatientDocumentAction,
} from "@/lib/patient-documents";
import type { RowDataPacket } from "mysql2/promise";

const schema = z.object({ email: emailSchema });

// A document link needs to survive someone actually opening the email, not just the
// 15-minute TTL used for in-app previews — 24h is long enough for that without leaving
// the link live indefinitely.
const EMAIL_LINK_TTL_SECONDS = 24 * 60 * 60;

export const POST = api({ rateLimit: 20 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const { documentId } = ctx.params;
  const body = parseBody(schema, await ctx.request.json());

  // Verifies clinic/branch access AND that the document belongs to a patient
  // associated with that clinic/branch — a document from another clinic 404s here.
  const doc = await getClinicVisibleDocument(pool, documentId, auth);
  await assertDocumentActionPermission(pool, auth, doc, "patient_documents:email");
  await assertClinicOperational(pool, doc.clinic_id);

  const deliveryId = await recordDelivery(pool, {
    documentId,
    method: "EMAIL",
    status: "PENDING",
    recipientEmail: body.email,
    attemptedBy: auth.userId,
  });

  const link = signFileUrl(doc.file_key, EMAIL_LINK_TTL_SECONDS);
  const html = detailsEmailHtml({
    heading: doc.title,
    intro: `${doc.uploaded_by_name ?? "Your clinic"} has shared a document with you from ${doc.clinic_name}, ${doc.branch_name}.`,
    rows: [
      { label: "Document", value: doc.title, sub: doc.document_type.replace(/_/g, " ") },
      { label: "Clinic", value: `${doc.clinic_name} · ${doc.branch_name}` },
    ],
    note: `This link is valid for 24 hours. <a href="${link}">View document</a>`,
    patientFacing: true,
  });

  // sendEmail never throws — it reports success/failure via its return value, which is
  // exactly what lets this delivery record reflect a real DELIVERED/NOT_DELIVERED
  // outcome instead of always defaulting to "sent".
  const delivered = await sendEmail(body.email, `${doc.title} — Jido Healthcare`, "", html);

  await withTransaction(async (conn) => {
    if (delivered) {
      await conn.query(
        `UPDATE patient_document_deliveries SET status = 'DELIVERED', delivered_at = NOW(3) WHERE id = ?`,
        [deliveryId],
      );
    } else {
      await conn.query(
        `UPDATE patient_document_deliveries SET status = 'NOT_DELIVERED', error_message = ? WHERE id = ?`,
        ["Unable to send email. Please try again.", deliveryId],
      );
    }
    await auditPatientDocumentAction(conn, auth.userId, "document_emailed", documentId, {
      recipient_email: body.email,
      delivered,
    });
  });

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT pdd.*, u.name AS attempted_by_name
       FROM patient_document_deliveries pdd
       LEFT JOIN users u ON u.id = pdd.attempted_by
      WHERE pdd.id = ?`,
    [deliveryId],
  );
  return json(serializeDelivery(rows[0]), 200);
});
