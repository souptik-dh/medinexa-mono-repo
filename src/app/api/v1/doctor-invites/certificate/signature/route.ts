import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { createImageUploadSignature } from "@/lib/cloudinary";

const CERTIFICATE_ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp", "pdf"];

// No invite exists yet at this point (an invite's id is only generated inside
// POST /branches/[id]/doctor-invites), so this is a signed direct-to-Cloudinary
// upload rather than the "upload against an existing id" pattern used for
// clinic/branch licenses — the client uploads straight to Cloudinary with this
// grant, then sends the resulting URL as a plain string in the invite's
// `certificate` field.
export const POST = api({ rateLimit: 200 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  return json(
    createImageUploadSignature("doctor-invites/certificates", CERTIFICATE_ALLOWED_FORMATS),
  );
});
