import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { parseBody } from "@/lib/validators";
import { requireRoles } from "@/lib/auth";
import { checkTradeLicense } from "@/lib/tradeLicense";

const bodySchema = z.object({
  trade_license_number: z.string().trim().min(1).max(100),
});

// Stateless proxy — doesn't touch the `clinics` table, since this is called from
// both the create-clinic form (no clinic row exists yet) and the edit form. The
// caller (POST /clinics or PATCH /clinics/:id) is what persists trade_license_validated
// et al., by echoing this response's `validated`/`status` back in that request body.
export const POST = api({ rateLimit: 200 }, async (ctx) => {
  requireRoles(ctx.auth, ["clinic_owner", "sys_admin"]);
  const body = parseBody(bodySchema, await readJson(ctx.request));

  try {
    const result = await checkTradeLicense(body.trade_license_number);
    return json({
      success: true,
      validated: result.validated,
      status: result.validated ? "VALID" : "INVALID",
      trade_license_number: body.trade_license_number,
      message: result.validated
        ? "Trade License Number validated successfully."
        : "Trade License Number could not be validated.",
    });
  } catch (err) {
    console.error("[trade-license] PRDEODB lookup failed:", err);
    return json({
      success: false,
      validated: false,
      status: "PENDING",
      message: "Unable to validate Trade License Number at this time. Please try again.",
    });
  }
});
