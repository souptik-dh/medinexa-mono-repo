import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { createImageUploadSignature } from "@/lib/cloudinary";

export const POST = api(undefined, async (ctx) => {
  requireRoles(ctx.auth, ["patient"]);
  return json(createImageUploadSignature("patients"));
});
