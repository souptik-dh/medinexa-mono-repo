import { api, json } from "@/lib/http";
import { pool, type Row } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/super-admin";
import { notFound } from "@/lib/errors";
import { serializeOffer, serializeOfferRecipient } from "@/lib/offers";

/** Offer detail — the campaign plus every targeted clinic's redemption and delivery status. */
export const GET = api({ rateLimit: 200 }, async (ctx) => {
  await requireSuperAdmin(ctx.auth);
  const { offerId } = ctx.params;

  const [offerRows] = await pool.query<Row[]>(
    `SELECT o.id, o.title, o.message, o.discounted_amount, o.currency, o.duration_months,
            o.valid_until, o.channels_json, o.status, o.created_by, o.created_at, o.cancelled_at,
            (SELECT COUNT(*) FROM subscription_offer_recipients r WHERE r.offer_id = o.id) AS recipient_count,
            (SELECT COUNT(*) FROM subscription_offer_recipients r WHERE r.offer_id = o.id AND r.status = 'REDEEMED') AS redeemed_count
       FROM subscription_offers o WHERE o.id = ?`,
    [offerId],
  );
  const offer = offerRows[0];
  if (!offer) throw notFound("OFFER_NOT_FOUND", "Offer not found.");

  const [recipientRows] = await pool.query<Row[]>(
    `SELECT r.*, c.name AS clinic_name
       FROM subscription_offer_recipients r JOIN clinics c ON c.id = r.clinic_id
      WHERE r.offer_id = ?
      ORDER BY r.created_at ASC`,
    [offerId],
  );

  return json({
    offer: serializeOffer(offer),
    recipients: recipientRows.map((r) => serializeOfferRecipient(r)),
  });
});
