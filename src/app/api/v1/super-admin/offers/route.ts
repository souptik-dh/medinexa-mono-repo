import { api, json, readJson, clientIp, decodeCursor } from "@/lib/http";
import { pool, withTransaction } from "@/lib/db";
import { parseBody, parsePagination } from "@/lib/validators";
import { badRequest } from "@/lib/errors";
import { requireSuperAdmin, logSuperAdminAction } from "@/lib/super-admin";
import { fetchPage } from "@/lib/pagination";
import { newId } from "@/lib/ids";
import { getActivePlan } from "@/lib/subscriptions";
import {
  offerInputSchema,
  loadClinicContacts,
  renderOfferMessage,
  sendOfferToClinic,
  serializeOffer,
} from "@/lib/offers";

/**
 * GET — lists discount campaigns (newest first), each annotated with how many
 * clinics it targeted and how many have redeemed it.
 * POST — creates a discount campaign, targets the given clinics, and immediately
 * dispatches it over every requested channel. Run POST .../preview first to see
 * exactly what will be sent before committing to this call.
 */
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const sp = ctx.request.nextUrl.searchParams;
  const { limit, cursor } = parsePagination(sp);

  const { rows, nextCursor } = await fetchPage({
    db: pool,
    select: `SELECT o.id, o.title, o.message, o.discounted_amount, o.currency, o.duration_months,
                    o.valid_until, o.channels_json, o.status, o.created_by, o.created_at, o.cancelled_at,
                    (SELECT COUNT(*) FROM subscription_offer_recipients r WHERE r.offer_id = o.id) AS recipient_count,
                    (SELECT COUNT(*) FROM subscription_offer_recipients r WHERE r.offer_id = o.id AND r.status = 'REDEEMED') AS redeemed_count`,
    from: `FROM subscription_offers o`,
    params: [],
    orderBy: "o.created_at DESC, o.id DESC",
    cursor: decodeCursor(cursor),
    limit,
  });

  return json({ items: rows.map((r) => serializeOffer(r)), next_cursor: nextCursor });
});

export const POST = api({ rateLimit: 20 }, async (ctx) => {
  const admin = await requireSuperAdmin(ctx.auth);
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

  const offerId = newId();
  const recipientIds = new Map<string, string>();

  await withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO subscription_offers
         (id, title, message, discounted_amount, currency, duration_months, valid_until, channels_json, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        offerId,
        body.title,
        body.message,
        body.discounted_amount.toFixed(2),
        body.currency,
        body.duration_months,
        body.valid_until,
        JSON.stringify(body.channels),
        admin.userId,
      ],
    );

    const values = clinicIds.map((clinicId) => {
      const recipientId = newId();
      recipientIds.set(clinicId, recipientId);
      return [recipientId, offerId, clinicId, "PENDING", body.duration_months];
    });
    await conn.query(
      `INSERT INTO subscription_offer_recipients (id, offer_id, clinic_id, status, months_remaining) VALUES ?`,
      [values],
    );

    await logSuperAdminAction(conn, {
      actorUserId: admin.userId,
      action: "subscription_offer.sent",
      resourceType: "subscription_offer",
      resourceId: offerId,
      changes: {
        clinic_count: clinicIds.length,
        discounted_amount: body.discounted_amount,
        currency: body.currency,
        duration_months: body.duration_months,
        valid_until: body.valid_until.toISOString(),
        channels: body.channels,
      },
      ipAddress: clientIp(ctx.request),
    });
  });

  // Dispatch happens after the transaction commits — these are outbound network
  // calls (SMS/WhatsApp/email gateways), never held inside a DB transaction.
  // One clinic's delivery failure must never block the rest.
  const recipients: Record<string, unknown>[] = [];
  for (const clinicId of clinicIds) {
    const recipientId = recipientIds.get(clinicId)!;
    const contact = contacts.get(clinicId)!;
    try {
      const renderedMessage = renderOfferMessage(body.message, {
        clinicName: contact.clinicName,
        regularAmount: plan.amount,
        offerAmount: body.discounted_amount,
        currency: body.currency,
        durationMonths: body.duration_months,
        validUntil: body.valid_until,
      });
      const delivery = await sendOfferToClinic({
        channels: body.channels,
        contact,
        renderedMessage,
        offer: {
          title: body.title,
          discountedAmount: body.discounted_amount,
          currency: body.currency,
          durationMonths: body.duration_months,
          validUntil: body.valid_until,
        },
        regularAmount: plan.amount,
      });
      await pool.query(
        `UPDATE subscription_offer_recipients
            SET notify_sms_status = ?, notify_whatsapp_status = ?, notify_email_status = ?,
                notified_at = UTC_TIMESTAMP(3), portal_notification_id = ?
          WHERE id = ?`,
        [delivery.sms, delivery.whatsapp, delivery.email, delivery.portalNotificationId, recipientId],
      );
      recipients.push({
        clinic_id: clinicId,
        clinic_name: contact.clinicName,
        rendered_message: renderedMessage,
        delivery: {
          sms: delivery.sms,
          whatsapp: delivery.whatsapp,
          email: delivery.email,
          portal: delivery.portalNotificationId ? "SENT" : body.channels.portal ? "FAILED" : "SKIPPED",
        },
      });
    } catch (err) {
      console.error(`[offers] send to clinic ${clinicId} failed:`, err);
      recipients.push({ clinic_id: clinicId, clinic_name: contact.clinicName, error: "Delivery failed." });
    }
  }

  return json(
    {
      message: `Offer sent to ${clinicIds.length} clinic(s).`,
      offer_id: offerId,
      recipients,
    },
    201,
  );
});
