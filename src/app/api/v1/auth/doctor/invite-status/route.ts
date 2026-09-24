import { z } from "zod";
import { api, json } from "@/lib/http";
import { pool } from "@/lib/db";
import { parseBody, phoneSchema, optionalEmailSchema } from "@/lib/validators";
import { badRequest, notFound } from "@/lib/errors";
import { effectiveInviteStatus, findInviteByCode } from "@/lib/doctor-invites";

const schema = z.object({
  code: z.string().trim().min(1).max(32),
  phone: phoneSchema.optional(),
  email: optionalEmailSchema,
});

/**
 * Lets the accept-invite page decide what to render for a link before the doctor
 * requests an OTP: only 'pending' opens the acceptance form. Public (the doctor has
 * no account yet), so it requires the code plus the phone/email it was sent to and
 * reveals nothing beyond the status. IP-keyed like accept-invite since it checks a code.
 */
export const GET = api({ rateLimit: 30, rateKey: "ip" }, async (ctx) => {
  const sp = ctx.request.nextUrl.searchParams;
  const query = parseBody(schema, {
    code: sp.get("code") ?? undefined,
    phone: sp.get("phone") || undefined,
    email: sp.get("email") || undefined,
  });
  if (!query.phone && !query.email) {
    throw badRequest("VALIDATION_ERROR", "phone or email is required.");
  }

  const invite = await findInviteByCode(pool, query.code, query.phone ?? null, query.email ?? null);
  if (!invite) {
    throw notFound("INVITE_NOT_FOUND", "Invite not found or invite code is invalid.");
  }
  return json({ status: effectiveInviteStatus(invite), expires_at: invite.expires_at });
});
