import { api, noContent } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { conflict, notFound } from "@/lib/errors";
import { assertBranchStaffPermission } from "@/lib/permissions";

export const DELETE = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);
  const inviteId = ctx.params.id;

  const [rows] = await pool.query<Row[]>(
    `SELECT di.id, di.branch_id, di.status, c.owner_user_id
       FROM doctor_invites di
       JOIN branches b ON b.id = di.branch_id
       JOIN clinics c ON c.id = b.clinic_id
      WHERE di.id = ?`,
    [inviteId],
  );
  const invite = rows[0];
  if (!invite) throw notFound("INVITE_NOT_FOUND", "Invite not found.");
  if (auth.role === "clinic_owner") {
    if (invite.owner_user_id !== auth.userId) {
      throw notFound("INVITE_NOT_FOUND", "Invite not found.");
    }
  } else {
    await assertBranchStaffPermission(pool, auth, invite.branch_id, "doctors:manage");
  }
  if (invite.status === "accepted") {
    throw conflict(
      "INVITE_ALREADY_ACCEPTED",
      "This invite was already accepted. Remove the doctor assignment instead.",
    );
  }
  if (invite.status !== "pending") {
    return noContent();
  }

  await pool.query(`UPDATE doctor_invites SET status = 'revoked' WHERE id = ?`, [inviteId]);
  return noContent();
});
