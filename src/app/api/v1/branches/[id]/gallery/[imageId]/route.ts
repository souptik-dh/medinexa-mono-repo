import { api, noContent } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getOwnedBranch } from "@/lib/scope";
import { notFound } from "@/lib/errors";

export const DELETE = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);
  const { id: branchId, imageId } = ctx.params;
  await getOwnedBranch(pool, branchId, auth.userId);

  const [rows] = await pool.query<Row[]>(
    `SELECT id FROM branch_gallery_images WHERE id = ? AND branch_id = ?`,
    [imageId, branchId],
  );
  if (!rows[0]) throw notFound("IMAGE_NOT_FOUND", "Gallery image not found.");

  await pool.query(`DELETE FROM branch_gallery_images WHERE id = ?`, [imageId]);
  return noContent();
});
