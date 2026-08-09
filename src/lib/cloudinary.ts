import { createHash, randomUUID } from "node:crypto";
import { badRequest } from "@/lib/errors";

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

export function createImageUploadSignature(folder: string): ImageUploadSignature {
  const { cloudName, apiKey, apiSecret } = getCloudinary();
  const public_id = `${folder}/${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const allowed_formats = UPLOAD_ALLOWED_FORMATS.join(",");
  const toSign = `allowed_formats=${allowed_formats}&public_id=${public_id}&timestamp=${timestamp}`;
  const signature = createHash("sha1").update(`${toSign}${apiSecret}`).digest("hex");
  return {
    upload_url: cloudinaryUploadUrl(cloudName),
    cloud_name: cloudName,
    api_key: apiKey,
    timestamp,
    public_id,
    allowed_formats: [...UPLOAD_ALLOWED_FORMATS],
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
