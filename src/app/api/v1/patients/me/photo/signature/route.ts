import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { createImageUploadSignature } from "@/lib/cloudinary";

export const POST = api({ rateLimit: 200 }, async (ctx) => {
  requireRoles(ctx.auth, ["patient"]);
  return json(createImageUploadSignature("patients"));
});
