import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { badRequest, tooLarge } from "@/lib/errors";
import { newId } from "@/lib/ids";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_SIZE = 10 * 1024 * 1024;

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);

  const formData = await ctx.request.formData();
  const file = formData.get("file");
  const appointmentId = formData.get("appointment_id");

  if (!file || !(file instanceof File)) {
    throw badRequest("VALIDATION_ERROR", "A file is required.");
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw badRequest("PRESCRIPTION_INVALID", "Only JPG, PNG, and PDF files are allowed.");
  }
  if (file.size > MAX_SIZE) {
    throw tooLarge("FILE_TOO_LARGE", "File size must be under 10MB.");
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const uploadDir = `${process.cwd()}/uploads/lab-prescriptions`;
  const fs = await import("node:fs/promises");
  await fs.mkdir(uploadDir, { recursive: true });

  const ext = file.name.split(".").pop() ?? "bin";
  const fileName = `${newId()}.${ext}`;
  const filePath = `${uploadDir}/${fileName}`;
  await fs.writeFile(filePath, buffer);

  return json({
    id: newId(),
    file_name: file.name,
    file_url: `/uploads/lab-prescriptions/${fileName}`,
    mime_type: file.type,
    file_size: file.size,
  });
});
