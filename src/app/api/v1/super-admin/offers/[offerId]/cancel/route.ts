import { api, json, clientIp } from "@/lib/http";
import { withTransaction, type Row } from "@/lib/db";
import { requireSuperAdmin, logSuperAdminAction } from "@/lib/super-admin";
import { conflict, notFound } from "@/lib/errors";
import { serializeOffer } from "@/lib/offers";

/**
 * Cancels an offer so it stops being picked up on any clinic's next payment.
 * Recipient rows are left untouched (never deleted) — a clinic that already
 * redeemed some discounted months keeps what it already paid for.
 */
export const POST = api({ rateLimit: 20 }, async (ctx) => {
  const admin = await requireSuperAdmin(ctx.auth);
  const { offerId } = ctx.params;

  const offer = await withTransaction(async (conn) => {
    const [rows] = await conn.query<Row[]>(`SELECT * FROM subscription_offers WHERE id = ? FOR UPDATE`, [offerId]);
    const row = rows[0];
    if (!row) throw notFound("OFFER_NOT_FOUND", "Offer not found.");
    if (row.status === "CANCELLED") {
      throw conflict("OFFER_ALREADY_CANCELLED", "This offer has already been cancelled.");
    }
    await conn.query(
      `UPDATE subscription_offers SET status = 'CANCELLED', cancelled_at = UTC_TIMESTAMP(3), cancelled_by = ? WHERE id = ?`,
      [admin.userId, offerId],
    );
    await logSuperAdminAction(conn, {
      actorUserId: admin.userId,
      action: "subscription_offer.cancelled",
      resourceType: "subscription_offer",
      resourceId: offerId,
      ipAddress: clientIp(ctx.request),
    });
    const [after] = await conn.query<Row[]>(`SELECT * FROM subscription_offers WHERE id = ?`, [offerId]);
    return after[0];
  });

  return json({ message: "Offer cancelled.", offer: serializeOffer(offer) });
});
