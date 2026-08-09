import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { badRequest, tooLarge, unsupported } from "@/lib/errors";

export const UPLOAD_DIR = path.join(process.cwd(), "uploads");

const SIGNING_SECRET =
  process.env.FILE_SIGNING_SECRET ?? process.env.JWT_SECRET ?? "dev-file-signing-secret";

export const SIGNED_URL_TTL_SECONDS = 15 * 60;

export type UploadKind =
  | "doctor-certificate"
  | "prescription-scan"
  | "medical-doc";

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

export async function saveUpload(
  file: unknown,
  kind: UploadKind,
  maxBytes: number,
  allowedMimes: string[],
): Promise<{ fileName: string; size: number; mime: string }> {
  if (!(file instanceof File)) throw badRequest("FILE_REQUIRED", "A file is required in the `file` field.");
  if (file.size <= 0) throw badRequest("FILE_EMPTY", "The uploaded file is empty.");
  if (file.size > maxBytes) {
    throw tooLarge(
      "FILE_TOO_LARGE",
      `File exceeds the ${Math.round(maxBytes / 1_000_000)}MB limit.`,
    );
  }
  const mime = file.type;
  if (!allowedMimes.includes(mime)) {
    throw unsupported(
      "UNSUPPORTED_MEDIA_TYPE",
      `Unsupported media type: ${mime || "unknown"}. Allowed: ${allowedMimes.join(", ")}.`,
    );
  }
  const ext = MIME_EXT[mime] ?? ".bin";
  const fileName = `${kind}-${randomUUID()}${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, fileName), buf);
  return { fileName, size: file.size, mime };
}

export function signFileUrl(fileName: string, ttlSeconds = SIGNED_URL_TTL_SECONDS): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac("sha256", SIGNING_SECRET)
    .update(`${fileName}:${expires}`)
    .digest("hex");
  const base = process.env.APP_URL ?? "";
  return `${base}/api/v1/files/${encodeURIComponent(fileName)}?expires=${expires}&sig=${sig}`;
}

export function verifyFileUrl(
  fileName: string,
  expires: string,
  sig: string,
): boolean {
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", SIGNING_SECRET)
    .update(`${fileName}:${exp}`)
    .digest("hex");
  return expected === sig;
}

export function mimeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  for (const [mime, e] of Object.entries(MIME_EXT)) {
    if (e === ext) return mime;
  }
  return "application/octet-stream";
}
