// services/storeOrders.js
// A paid order on a brand's connected store used one of our promo codes: mark the code used and count it
// as a redemption (bill, saving), the same way the promo code verify flow does. Safe to call twice for the
// same order: the code is only marked if it is still active.
const PromoCode = require("../models/PromoCode");
const Offer = require("../models/Offer");
const Notification = require("../models/Notification");

const PAID = new Set(["processing", "completed"]);
const MAX_AMOUNT = 10000000;

// order: WooCommerce order JSON (read back from the store, never the webhook body)
async function recordWooOrder(brandId, order) {
  const result = { counted: 0, codes: [] };
  if (!order || !PAID.has(String(order.status || "").toLowerCase())) return { ...result, ignored: "not paid" };
  const orderId = String(order.id);
  for (const line of order.coupon_lines || []) {
    const code = String(line.code || "").toUpperCase().trim();
    if (!code) continue;
    const promo = await PromoCode.findOne({ code, brand: brandId });
    if (!promo || promo.status !== "active") continue;
    let billAmount = Math.round((Number(order.total) || 0) + (Number(line.discount) || 0)); // before the tdc discount
    if (!Number.isFinite(billAmount) || billAmount <= 0 || billAmount > MAX_AMOUNT) continue;
    const savedAmount = Math.round((billAmount * promo.discountPercentage) / 100);
    const marked = await PromoCode.findOneAndUpdate(
      { _id: promo._id, status: "active" },
      { $set: { status: "used", usedAt: new Date(), redeemedVia: "webhook", externalOrderId: orderId, externalAmount: billAmount }, $inc: { usedCount: 1 } },
      { new: true }
    );
    if (!marked) continue;
    if (promo.offer) {
      await Offer.updateOne(
        { _id: promo.offer },
        { $push: { redemptions: { student: promo.student, billAmount, savedAmount, redeemedAt: new Date(), promoCode: promo.code, promoCodeId: promo._id, source: "webhook", externalOrderId: orderId } } }
      );
    }
    try {
      await Notification.create({ recipient: promo.student, title: "✅ Promo Code Used!", description: `Your promo code ${promo.code} was confirmed at ${promo.brandName}! You saved Rs. ${savedAmount}.`, type: "System", icon: "checkmark-circle" });
      await Notification.create({ recipient: brandId, title: "💰 Online order confirmed", description: `Order #${orderId} used promo code ${promo.code}. Savings: Rs. ${savedAmount}`, type: "System", icon: "cash-outline" });
    } catch (e) {
      console.error("[store orders] notification error:", e.message);
    }
    try {
      const { track } = require("./engagement");
      await track(promo.student, "deal_redeemed", { meta: { offerId: promo.offer?.toString(), savedAmount }, dedupeKey: `deal:${promo.student}:${promo._id}:${orderId}` });
    } catch (e) {
      console.error("[engagement] store order hook failed:", e.message);
    }
    result.counted += 1;
    result.codes.push(promo.code);
  }
  return result;
}

module.exports = { recordWooOrder, PAID };
