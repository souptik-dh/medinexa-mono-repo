import { createHash, randomUUID } from "node:crypto";
import { badRequest, tooLarge, unsupported } from "@/lib/errors";

const CLOUDINARY_URL = process.env.CLOUDINARY_URL;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

function parseCloudinaryUrl(url: string): CloudinaryConfig {
  const m = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  if (!m) throw new Error("CLOUDINARY_URL is not a valid cloudinary:// URL.");
  return { apiKey: m[1], apiSecret: m[2], cloudName: m[3] };
}

export function getCloudinary(): CloudinaryConfig {
  if (!CLOUDINARY_URL) throw new Error("CLOUDINARY_URL is not set.");
  return parseCloudinaryUrl(CLOUDINARY_URL);
}

export const UPLOAD_ALLOWED_FORMATS = ["jpg", "png", "webp", "gif"] as const;

export function cloudinaryUploadUrl(cloudName: string): string {
  return `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
}

export function cloudinaryImageUrl(cloudName: string, publicId: string): string {
  return `https://res.cloudinary.com/${cloudName}/image/upload/${publicId}`;
}

export interface ImageUploadSignature {
  upload_url: string;
  cloud_name: string;
  api_key: string;
  timestamp: number;
  public_id: string;
  allowed_formats: string[];
  signature: string;
}

export function createImageUploadSignature(
  folder: string,
  allowedFormats: readonly string[] = UPLOAD_ALLOWED_FORMATS,
): ImageUploadSignature {
  const { cloudName, apiKey, apiSecret } = getCloudinary();
  const public_id = `${folder}/${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const allowed_formats = allowedFormats.join(",");
  const toSign = `allowed_formats=${allowed_formats}&public_id=${public_id}&timestamp=${timestamp}`;
  const signature = createHash("sha1").update(`${toSign}${apiSecret}`).digest("hex");
  return {
    upload_url: cloudinaryUploadUrl(cloudName),
    cloud_name: cloudName,
    api_key: apiKey,
    timestamp,
    public_id,
    allowed_formats: [...allowedFormats],
    signature,
  };
}

export function assertPublicId(publicId: string, folder: string): string {
  if (!publicId.startsWith(`${folder}/`) || !UUID_RE.test(publicId.slice(folder.length + 1))) {
    throw badRequest(
      "INVALID_PUBLIC_ID",
      `public_id must reference a file previously issued for the ${folder} folder.`,
      "public_id",
    );
  }
  return publicId;
}

export interface DocumentUploadResult {
  url: string;
  publicId: string;
  size: number;
  mime: string;
}

export async function uploadDocumentToCloudinary(
  file: unknown,
  folder: string,
  maxBytes: number,
  allowedMimes: string[],
): Promise<DocumentUploadResult> {
  if (!(file instanceof File)) throw badRequest("FILE_REQUIRED", "A file is required in the `file` field.");
  if (file.size <= 0) throw badRequest("FILE_EMPTY", "The uploaded file is empty.");
  if (file.size > maxBytes) {
    throw tooLarge(
      "FILE_TOO_LARGE",
      `File exceeds the ${Math.round(maxBytes / 1_000_000)}MB limit.`,
    );
  }
  if (!allowedMimes.includes(file.type)) {
    throw unsupported(
      "UNSUPPORTED_MEDIA_TYPE",
      `Unsupported media type: ${file.type || "unknown"}. Allowed: ${allowedMimes.join(", ")}.`,
    );
  }

  const { cloudName, apiKey, apiSecret } = getCloudinary();
  const publicId = `${folder}/${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}`;
  const signature = createHash("sha1").update(`${toSign}${apiSecret}`).digest("hex");

  const body = new FormData();
  body.append("file", file);
  body.append("api_key", apiKey);
  body.append("timestamp", String(timestamp));
  body.append("folder", folder);
  body.append("public_id", publicId);
  body.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
    method: "POST",
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Cloudinary upload failed: ${data?.error?.message ?? res.statusText}`);
  }

  return { url: data.secure_url, publicId: data.public_id, size: file.size, mime: file.type };
}
