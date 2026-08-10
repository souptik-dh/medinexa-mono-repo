import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { licenseFields } from "@/lib/licenses";

export const GET = api(undefined, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["clinic_owner"]);

  const [clinics] = await pool.query<Row[]>(
    `SELECT * FROM clinics WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    [auth.userId],
  );

  const clinicIds = clinics.map((c) => c.id);
  const branchesByClinic = new Map<string, Row[]>();
  if (clinicIds.length > 0) {
    const [branches] = await pool.query<Row[]>(
      `SELECT * FROM branches WHERE clinic_id IN (?) AND deleted_at IS NULL ORDER BY created_at ASC`,
      [clinicIds],
    );
    for (const b of branches) {
      const list = branchesByClinic.get(b.clinic_id) ?? [];
      list.push(b);
      branchesByClinic.set(b.clinic_id, list);
    }
  }

  return json({
    items: clinics.map((clinic) => ({
      id: clinic.id,
      name: clinic.name,
      description: clinic.description,
      nearby_location: clinic.nearby_location,
      city: clinic.city,
      district: clinic.district,
      pin_code: clinic.pin_code,
      state: clinic.state,
      post_office: clinic.post_office,
      owner_id: clinic.owner_user_id,
      ...licenseFields(clinic),
      created_at: clinic.created_at,
      updated_at: clinic.updated_at,
      branches: (branchesByClinic.get(clinic.id) ?? []).map((b) => ({
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
    })),
  });
});
