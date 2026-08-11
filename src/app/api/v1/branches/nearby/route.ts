import { api, json, decodeCursor } from "@/lib/http";
import { pool } from "@/lib/db";
import { parsePagination } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { fetchPage } from "@/lib/pagination";
import { getPatientLocation, buildNearbyMatch } from "@/lib/nearby";
import { licenseFields } from "@/lib/licenses";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient"]);
  const { limit, cursor } = parsePagination(ctx.request.nextUrl.searchParams);

  const location = await getPatientLocation(auth.userId);
  const match = buildNearbyMatch("b", location);

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: "SELECT b.*",
    from: "FROM branches b",
    where: `b.deleted_at IS NULL AND ${match.sql}`,
    params: match.params,
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({
    items: rows.map((b) => ({
      id: b.id,
      clinic_id: b.clinic_id,
      name: b.name,
      address: b.address,
      nearby_location: b.nearby_location ?? null,
      city: b.city ?? null,
      district: b.district ?? null,
      pin_code: b.pin_code ?? null,
      state: b.state ?? null,
      post_office: b.post_office ?? null,
      phone: b.phone,
      lat: b.lat != null ? Number(b.lat) : null,
      lng: b.lng != null ? Number(b.lng) : null,
      timezone: b.timezone,
      photo_url: b.photo_url,
      ...licenseFields(b),
      created_at: b.created_at,
    })),
    next_cursor: nextCursor,
  });
});
