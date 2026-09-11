import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { assertBranchStaffPermission } from "@/lib/permissions";
import { badRequest } from "@/lib/errors";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function serializeCandidate(r: Row) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    is_registered: Boolean(r.is_registered),
  };
}

// Lets reception search for an existing patient by phone/name before booking, so a
// walk-in who's already a patient (registered via the app, or added by reception at
// another branch) can be selected by patient_id instead of creating a duplicate
// record. Not branch-scoped — patients aren't owned by a clinic/branch.
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["branch_staff", "clinic_owner"]);
  if (auth.role === "branch_staff") {
    await assertBranchStaffPermission(pool, auth, auth.branchId ?? "__none__", "patients:view");
  }

  const sp = ctx.request.nextUrl.searchParams;
  const q = sp.get("q")?.trim();
  const phone = sp.get("phone")?.trim();
  if (!q && !phone) {
    throw badRequest("VALIDATION_ERROR", "Provide `q` or `phone` to search for a patient.");
  }

  const whereParts = ["role = 'patient'"];
  const params: unknown[] = [];
  if (phone) {
    whereParts.push("phone = ?");
    params.push(phone);
  } else if (q) {
    const like = `%${escapeLike(q)}%`;
    whereParts.push("(name LIKE ? OR phone LIKE ? OR email LIKE ?)");
    params.push(like, like, like);
  }

  const [rows] = await pool.query<Row[]>(
    `SELECT id, name, email, phone, (password_hash IS NOT NULL) AS is_registered
       FROM users
      WHERE ${whereParts.join(" AND ")}
      ORDER BY name ASC
      LIMIT 20`,
    params,
  );

  return json({ items: rows.map(serializeCandidate) });
});
