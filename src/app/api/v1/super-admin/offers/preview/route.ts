import { api, json, readJson } from "@/lib/http";
import { pool } from "@/lib/db";
import { parseBody } from "@/lib/validators";
import { badRequest } from "@/lib/errors";
import { requireSuperAdmin } from "@/lib/super-admin";
import { getActivePlan } from "@/lib/subscriptions";
import { offerInputSchema, loadClinicContacts, planChannelDelivery, renderOfferMessage } from "@/lib/offers";

/**
 * Dry-run for a discount campaign: renders the exact message each targeted
 * clinic would receive and reports, per channel, whether it will actually send
 * or gets skipped (no phone / no email on file) — without writing anything to
 * the database or contacting any SMS/WhatsApp/email gateway. Call this before
 * POST /super-admin/offers to review the campaign.
 */
export const POST = api({ rateLimit: 30 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const body = parseBody(offerInputSchema, await readJson(ctx.request));

  const plan = await getActivePlan(pool);
  if (body.discounted_amount >= plan.amount) {
    throw badRequest(
      "OFFER_NOT_A_DISCOUNT",
      `The offer price must be lower than the current plan price (${plan.currency} ${plan.amount.toFixed(2)}/month).`,
      "discounted_amount",
    );
  }

  const clinicIds = Array.from(new Set(body.clinic_ids));
  const contacts = await loadClinicContacts(pool, clinicIds);
  const missing = clinicIds.filter((id) => !contacts.has(id));
  if (missing.length > 0) {
    throw badRequest("CLINIC_NOT_FOUND", `Clinic id(s) not found: ${missing.join(", ")}`, "clinic_ids");
  }

  const recipients = clinicIds.map((clinicId) => {
    const contact = contacts.get(clinicId)!;
    const renderedMessage = renderOfferMessage(body.message, {
      clinicName: contact.clinicName,
      regularAmount: plan.amount,
      offerAmount: body.discounted_amount,
      currency: body.currency,
      durationMonths: body.duration_months,
      validUntil: body.valid_until,
    });
    return {
      clinic_id: clinicId,
      clinic_name: contact.clinicName,
      owner_email: contact.ownerEmail,
      owner_phone: contact.ownerPhone,
      rendered_message: renderedMessage,
      channels: planChannelDelivery(body.channels, contact),
    };
  });

  return json({
    plan_amount: plan.amount,
    currency: plan.currency,
    discounted_amount: body.discounted_amount,
    savings_per_month: Math.round((plan.amount - body.discounted_amount) * 100) / 100,
    recipients,
  });
});
