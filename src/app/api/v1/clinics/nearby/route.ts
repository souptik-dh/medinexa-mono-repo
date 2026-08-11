import { api, json, decodeCursor } from "@/lib/http";
import { pool } from "@/lib/db";
import { parsePagination } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { fetchPage } from "@/lib/pagination";
import { getPatientLocation, buildNearbyMatch } from "@/lib/nearby";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const { limit, cursor } = parsePagination(ctx.request.nextUrl.searchParams);

  const location = await getPatientLocation(auth.userId);
  const match = buildNearbyMatch("c", location);

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: `SELECT c.id, c.name, c.description, c.nearby_location, c.city, c.district, c.pin_code, c.state, c.post_office,
                    (SELECT COUNT(*) FROM branches b WHERE b.clinic_id = c.id AND b.deleted_at IS NULL) AS branch_count,
                    c.created_at`,
    from: "FROM clinics c",
    where: `c.deleted_at IS NULL AND ${match.sql}`,
    params: match.params,
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      nearby_location: r.nearby_location,
      city: r.city,
      district: r.district,
      pin_code: r.pin_code,
      state: r.state,
      post_office: r.post_office,
      branch_count: Number(r.branch_count),
      created_at: r.created_at,
    })),
    next_cursor: nextCursor,
  });
});
