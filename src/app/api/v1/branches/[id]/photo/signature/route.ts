import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { createImageUploadSignature } from "@/lib/cloudinary";

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  await getOwnedBranch(pool, ctx.params.id, auth.userId);
  return json(createImageUploadSignature("branches"));
});
