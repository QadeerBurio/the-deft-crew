// routes/shopifyApp.routes.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const PromoCode = require("../models/PromoCode");
const Offer = require("../models/Offer");
const Notification = require("../models/Notification");

// ============================================================
// API KEY MIDDLEWARE
// ============================================================
const verifyApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.SHOPIFY_APP_API_KEY) {
    console.warn("[shopify-app] Unauthorized request, bad x-api-key");
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// ============================================================
// HELPER: normalize shop domain to "xxx.myshopify.com"
// ============================================================
const normalizeShop = (raw) =>
  String(raw || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase()
    .trim();

// ============================================================
// GET /api/shopify-app/brand?shop=xxx.myshopify.com
// Called by the Remix dashboard to fetch ROI + discounts.
// ============================================================
router.get("/brand", verifyApiKey, async (req, res) => {
  try {
    const shop = normalizeShop(req.query.shop);
    if (!shop) return res.status(400).json({ error: "shop required" });

    const brand = await User.findOne({
      shopifyStoreUrl: shop,
      role: "brand",
    }).lean();

    if (!brand) {
      return res.status(404).json({ error: "Brand not found" });
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const now = new Date();

    const codes = await PromoCode.find({ brand: brand._id }).lean();
    const offers = await Offer.find({ brand: brand._id }).lean();

    const redemptions = offers.flatMap((o) => o.redemptions || []);
    const recent = redemptions.filter((r) => {
      const t = new Date(r.redeemedAt).getTime();
      return t >= thirtyDaysAgo.getTime() && t <= now.getTime();
    });

    const totalRevenue = recent.reduce((s, r) => s + (r.billAmount || 0), 0);
    const totalDiscount = recent.reduce((s, r) => s + (r.savedAmount || 0), 0);
    const uniqueCustomers = new Set(
      recent.map((r) => String(r.student))
    ).size;

    res.json({
      id: brand._id,
      brandName: brand.brandName || brand.name,
      shopifyStoreUrl: brand.shopifyStoreUrl,
      contactEmail: brand.email,
      roi: {
        totalOrders: recent.length,
        totalRevenue,
        totalDiscount,
        netRevenue: totalRevenue - totalDiscount,
        uniqueCustomers,
        avgOrderValue: recent.length ? totalRevenue / recent.length : 0,
        periodStart: thirtyDaysAgo.toISOString(),
        periodEnd: now.toISOString(),
      },
      discounts: codes.map((c) => ({
        code: c.code,
        discountType: "percentage",
        discountValue: c.discountPercentage,
        isActive: c.status === "active",
      })),
    });
  } catch (err) {
    console.error("[shopify-app] /brand error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/shopify-app/link-shop
// Body: { shop: "xxx.myshopify.com", brandId?: "<TDC user _id>", email?: "brand@x.com" }
// Called by Remix immediately after install (from app._index.tsx loader).
// ============================================================
router.post("/link-shop", verifyApiKey, async (req, res) => {
  try {
    const { brandId, email } = req.body || {};
    const shop = normalizeShop(req.body?.shop);

    if (!shop) return res.status(400).json({ error: "shop required" });

    let brand = null;

    // Priority 1: match by explicit brandId (most reliable)
    if (brandId) {
      brand = await User.findOneAndUpdate(
        { _id: brandId, role: "brand" },
        { shopifyStoreUrl: shop },
        { new: true }
      ).lean();
    }

    // Priority 2: match by email (case-insensitive)
    if (!brand && email) {
      brand = await User.findOneAndUpdate(
        { email: String(email).toLowerCase().trim(), role: "brand" },
        { shopifyStoreUrl: shop },
        { new: true }
      ).lean();
    }

    // Priority 3: if exactly one unlinked brand exists with a matching
    // brandName equal to the shop prefix, use it. (Optional — remove if unwanted.)
    if (!brand) {
      const prefix = shop.replace(".myshopify.com", "");
      brand = await User.findOneAndUpdate(
        {
          role: "brand",
          $or: [
            { shopifyStoreUrl: "" },
            { shopifyStoreUrl: { $exists: false } },
          ],
          brandName: new RegExp(`^${prefix}$`, "i"),
        },
        { shopifyStoreUrl: shop },
        { new: true }
      ).lean();
    }

    if (!brand) {
      // Not fatal — Remix will show the "Partner brand not configured"
      // message, and the merchant can link manually later.
      console.warn(`[link-shop] No brand matched for shop=${shop}`);
      return res
        .status(404)
        .json({ success: false, error: "No matching brand", shop });
    }

    console.log(
      `[link-shop] Linked ${shop} → brand ${brand._id} (${brand.brandName || brand.name})`
    );
    res.json({ success: true, brandId: brand._id, shop });
  } catch (err) {
    console.error("[shopify-app] /link-shop error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/shopify-app/discount
// Called by the Remix Discounts page when a merchant manually creates
// a discount code inside the embedded app.
// ============================================================
router.post("/discount", verifyApiKey, async (req, res) => {
  try {
    const {
      shop,
      code,
      discountType,
      discountValue,
      shopifyDiscountId,
      startsAt,
      endsAt,
    } = req.body || {};

    const cleanShop = normalizeShop(shop);
    if (!cleanShop || !code) {
      return res.status(400).json({ error: "shop and code required" });
    }

    const brand = await User.findOne({
      shopifyStoreUrl: cleanShop,
      role: "brand",
    });
    if (!brand) {
      return res.status(404).json({ error: "Brand not found for shop" });
    }

    await PromoCode.findOneAndUpdate(
      { code: String(code).toUpperCase().trim() },
      {
        code: String(code).toUpperCase().trim(),
        brand: brand._id,
        discountPercentage: Number(discountValue) || 0,
        brandName: brand.brandName || brand.name,
        offerTitle: `Manual rule (${cleanShop})`,
        status: "active",
        externalProvider: "shopify",
        externalDiscountId: shopifyDiscountId || "",
        expiresAt: endsAt
          ? new Date(endsAt)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
      { upsert: true, new: true }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("[shopify-app] /discount error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/shopify-app/order-webhook
// Body: { shop, order }
// Called by Remix on ORDERS_CREATE / ORDERS_UPDATED.
//
// Guarantees:
//  - Only marks PromoCode as used if it is currently "active"
//  - Idempotent: same order ID → no duplicate redemption
//  - Ignores voided / refunded / cancelled / draft orders
//  - Atomic $inc on usedCount
//  - Tolerant of Shopify webhook retries (Remix may call this 2+ times)
// ============================================================
router.post("/order-webhook", verifyApiKey, async (req, res) => {
  try {
    const rawShop = req.body?.shop;
    const order = req.body?.order;
    const idempotencyKey = req.headers["idempotency-key"]; // optional, from Remix

    if (!order) {
      return res.status(400).json({ error: "order required" });
    }

    const cleanShop = normalizeShop(rawShop);
    console.log(
      `[order-webhook] shop=${cleanShop} order=${order.id || order.order_number} topic=${req.body?.topic || "unknown"} idem=${idempotencyKey || "-"}`
    );

    // ---- 1. Skip orders that shouldn't count toward ROI ----
    const financialStatus = (order.financial_status || "").toLowerCase();
    const IGNORED_FINANCIAL_STATUSES = new Set([
      "voided",
      "refunded",
      "partially_refunded",
      "expired",
      "pending",
      "authorized",
    ]);
    // "paid" and "partially_paid" are the only ones we count as revenue.
    // If your store doesn't use those statuses consistently, adjust here.
    const isCountedStatus =
      financialStatus === "paid" || financialStatus === "partially_paid";

    // Draft / cancelled orders should never count
    const cancelledAt = order.cancelled_at;
    const isCancelled = !!cancelledAt;

    // ---- 2. Skip orders with no discount codes ----
    const discountCodes = Array.isArray(order.discount_codes)
      ? order.discount_codes
      : [];
    const codes = discountCodes
      .map((d) => String(d.code || "").toUpperCase().trim())
      .filter(Boolean);

    if (codes.length === 0) {
      return res.json({ success: true, processed: 0, reason: "no_discounts" });
    }

    // ---- 3. Find brand ----
    const brand = await User.findOne({
      shopifyStoreUrl: cleanShop,
      role: "brand",
    }).lean();
    if (!brand) {
      console.warn(`[order-webhook] No brand for shop ${cleanShop}`);
      return res.json({ success: true, ignored: true, reason: "no_brand" });
    }

    // If the order isn't in a counted state, still mark codes as used
    // (they *were* redeemed), but don't push revenue into Offer.redemptions.
    const countRevenue = isCountedStatus && !isCancelled;

    const totalDiscount = discountCodes.reduce(
      (s, d) => s + parseFloat(d.amount || 0),
      0
    );
    const orderTotal = parseFloat(order.total_price || 0);
    const orderId = String(order.id || order.order_number || "");

    let processed = 0;
    let skipped = 0;

    for (const code of codes) {
      // ---- 4. Load promo, but only active ones get transitioned ----
      const promo = await PromoCode.findOne({
        code,
        brand: brand._id,
      });

      if (!promo) {
        console.warn(
          `[order-webhook] PromoCode not found for code=${code} brand=${brand._id}`
        );
        skipped++;
        continue;
      }

      // ---- 5. Idempotency: same order already processed? ----
      if (
        promo.status === "used" &&
        promo.externalOrderId &&
        promo.externalOrderId === orderId
      ) {
        console.log(
          `[order-webhook] ${code} already redeemed for order ${orderId} — skipping`
        );
        skipped++;
        continue;
      }

      // ---- 6. Don't resurrect expired/cancelled codes ----
      if (promo.status !== "active") {
        console.warn(
          `[order-webhook] ${code} status=${promo.status} — not marking as used`
        );
        skipped++;
        continue;
      }

      // ---- 7. Atomic transition active → used ----
      // Use findOneAndUpdate so two concurrent webhooks can't both mark it used.
      const updated = await PromoCode.findOneAndUpdate(
        {
          _id: promo._id,
          status: "active", // guard against race
        },
        {
          $set: {
            status: "used",
            usedAt: new Date(),
            usedBy: promo.student,
            redeemedVia: "webhook",
            externalOrderId: orderId,
            externalAmount: orderTotal,
          },
          $inc: { usedCount: 1 },
        },
        { new: true }
      );

      if (!updated) {
        // Someone else transitioned it between our read and write
        console.log(
          `[order-webhook] ${code} lost race — another process marked it used`
        );
        skipped++;
        continue;
      }

      // ---- 8. Push redemption to Offer (only if revenue should count) ----
      if (countRevenue) {
        // Guard against duplicate redemption entries for the same order.
        const offer = await Offer.findById(promo.offer);
        if (offer) {
          const alreadyPushed = (offer.redemptions || []).some(
            (r) =>
              String(r.promoCodeId) === String(promo._id) &&
              String(r.externalOrderId || "") === orderId
          );

          if (!alreadyPushed) {
            offer.redemptions.push({
              student: promo.student,
              billAmount: orderTotal,
              savedAmount: Math.round(totalDiscount),
              redeemedAt: new Date(),
              promoCode: code,
              promoCodeId: promo._id,
              externalOrderId: orderId, // ← add this field to your schema
            });
            await offer.save();
          }
        }
      } else {
        console.log(
          `[order-webhook] ${code} redeemed but revenue skipped (financial_status=${financialStatus}, cancelled=${isCancelled})`
        );
      }

      // ---- 9. Notify the brand ----
      try {
        await Notification.create({
          recipient: brand._id,
          title: "💰 Promo Code Redeemed on Shopify!",
          description: `Code ${code} used on order #${
            order.order_number || order.id
          }. Saved: $${totalDiscount.toFixed(2)}`,
          type: "System",
          icon: "cash-outline",
          data: {
            promoCodeId: promo._id,
            orderId,
          },
        });
      } catch (nErr) {
        console.warn("[order-webhook] Notification failed:", nErr.message);
      }

      processed++;
    }

    return res.json({
      success: true,
      processed,
      skipped,
      countedRevenue: countRevenue,
      orderId,
    });
  } catch (err) {
    console.error("[shopify-app] /order-webhook error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;