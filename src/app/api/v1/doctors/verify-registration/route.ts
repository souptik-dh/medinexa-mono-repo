import { api, json } from "@/lib/http";
import { requireRoles } from "@/lib/auth";
import { badRequest } from "@/lib/errors";
import { searchNmcDoctorByRegistrationNo } from "@/lib/nmcRegistry";

// Stateless proxy over the National Medical Commission's public Indian Medical
// Register, used by the doctor-invite flow (branches/:id/doctor-invites) to look up
// and confirm a registration number before it's stored on the invite/doctor record.
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "branch_staff"]);

  const regNo = (ctx.request.nextUrl.searchParams.get("reg_no") ?? "").trim();
  if (!regNo) throw badRequest("VALIDATION_ERROR", "reg_no is required.", "reg_no");
  if (regNo.length > 64) throw badRequest("VALIDATION_ERROR", "reg_no is too long.", "reg_no");

  try {
    const doctor = await searchNmcDoctorByRegistrationNo(regNo);
    return json({
      success: true,
      registration_no: regNo,
      found: doctor !== null,
      doctor,
    });
  } catch (err) {
    console.error("[nmc-registry] lookup failed:", err);
    return json({
      success: false,
      registration_no: regNo,
      found: false,
      doctor: null,
      message: "Unable to verify NMC registration number at this time. Please try again.",
    });
  }
});
