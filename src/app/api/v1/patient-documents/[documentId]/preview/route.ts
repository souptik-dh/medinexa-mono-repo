import { readFile } from "node:fs/promises";
import path from "node:path";
import { api } from "@/lib/http";
import { pool } from "@/lib/db";
import { forbidden } from "@/lib/errors";
import { UPLOAD_DIR } from "@/lib/upload";
import { verifyPatientDocumentPreviewUrl } from "@/lib/patient-documents";
import type { RowDataPacket } from "mysql2/promise";

// Backing endpoint for the short-lived `file_url` on list/detail responses (see
// signPatientDocumentPreviewUrl) — authorized by the signed `expires`/`sig` query params
// rather than a bearer token, same trust model as the generic /api/v1/files/:key route.
// Kept separate from that route because `file_key` here may be a full Cloudinary URL,
// which doesn't round-trip through a single dynamic route segment.
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const { documentId } = ctx.params;
  const expires = ctx.request.nextUrl.searchParams.get("expires") ?? "";
  const sig = ctx.request.nextUrl.searchParams.get("sig") ?? "";

  if (!verifyPatientDocumentPreviewUrl(documentId, expires, sig)) {
    throw forbidden("INVALID_SIGNED_URL", "This link is invalid or has expired.");
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT file_key, mime_type FROM patient_documents WHERE id = ? AND deleted_at IS NULL`,
    [documentId],
  );
  const doc = rows[0];
  if (!doc) throw forbidden("INVALID_SIGNED_URL", "File not found or link is invalid.");

  try {
    let buf: Buffer;
    if (/^https?:\/\//.test(doc.file_key)) {
      const res = await fetch(doc.file_key);
      if (!res.ok) throw new Error(`upstream fetch failed: ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      buf = await readFile(path.join(UPLOAD_DIR, doc.file_key));
    }
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": doc.mime_type,
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    throw forbidden("INVALID_SIGNED_URL", "File not found or link is invalid.");
  }
});
