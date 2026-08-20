import { z } from "zod";
import { api, noContent, readJson } from "@/lib/http";
import { pool } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";

const schema = z.object({
  branch_id: z.string().uuid().optional().nullable(),
});

export const PATCH = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  const body = parseBody(schema, await readJson(ctx.request));

  const params: unknown[] = [auth.userId];
  let branchFilter = "";
  if (body.branch_id) {
    branchFilter = " AND branch_id = ?";
    params.push(body.branch_id);
  }
  await pool.query(
    `UPDATE notifications SET read_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND read_at IS NULL${branchFilter}`,
    params,
  );
  return noContent();
});
