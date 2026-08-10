import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { saveUpload, signFileUrl } from "@/lib/upload";
import { licenseColumns } from "@/lib/licenses";

const LICENSE_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_BYTES = 10 * 1024 * 1024;

export const POST = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const branch = await getOwnedBranch(pool, ctx.params.id, auth.userId);
  const { url: urlColumn } = licenseColumns(ctx.params.type);

  const form = await ctx.request.formData();
  const saved = await saveUpload(form.get("file"), "branch-license", MAX_BYTES, LICENSE_MIMES);
  const url = signFileUrl(saved.fileName);

  await pool.query(`UPDATE branches SET ${urlColumn} = ? WHERE id = ?`, [url, branch.id]);
  return json({ type: ctx.params.type, url });
});
