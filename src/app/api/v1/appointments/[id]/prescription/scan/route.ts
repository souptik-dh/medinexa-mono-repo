import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { conflict, notFound } from "@/lib/errors";
import { requireAssignedDoctor } from "@/lib/prescriptions";
import { saveUpload, signFileUrl } from "@/lib/upload";
import { createOcrJob } from "@/lib/ocr";

const SCAN_MIMES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["doctor"]);
  const appointment = await requireAssignedDoctor(pool, ctx.params.id, auth);

  if (!["paid", "completed"].includes(appointment.status)) {
    throw conflict(
      "APPOINTMENT_NOT_YET_PAID",
      "Prescriptions are available once the appointment has been paid.",
    );
  }

  const form = await ctx.request.formData();
  const saved = await saveUpload(form.get("file"), "prescription-scan", MAX_BYTES, SCAN_MIMES);
  const scanUrl = signFileUrl(saved.fileName);

  if (!auth.doctorId) throw notFound("DOCTOR_NOT_FOUND", "Doctor profile not found.");
  const jobId = await createOcrJob(appointment.id, auth.doctorId, scanUrl);
  return json({ job_id: jobId, status: "processing" }, 202);
});
