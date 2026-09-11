import { readFile } from "node:fs/promises";
import path from "node:path";
import { api } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { pool } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { UPLOAD_DIR } from "@/lib/upload";
import { getClinicVisibleDocument, getOwnDocument, auditPatientDocumentAction } from "@/lib/patient-documents";
import { assertBranchStaffPermission } from "@/lib/permissions";

// Streams the file directly from this authenticated endpoint rather than redirecting to
// (or returning) a signed /files/:key URL — so downloading a patient document never
// hands the client a link that could be reused, forwarded, or outlive this request's
// own authorization check. `/files/:key` is still used for the short-lived preview
// `file_url` on list/detail responses, but the actual download action doesn't rely on it.
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

  let buf: Buffer;
  try {
    buf = await readFile(path.join(UPLOAD_DIR, doc.file_key));
  } catch {
    throw notFound("PATIENT_DOCUMENT_NOT_FOUND", "Document file not found.");
  }

  await auditPatientDocumentAction(pool, auth.userId, "document_downloaded", documentId, {
    patient_id: doc.patient_id,
  });

  const safeName = doc.file_name.replace(/[\r\n"]/g, "_");
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": doc.mime_type,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
