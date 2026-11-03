const express = require("express");
const mongoose = require("mongoose");
const { creditSafe } = require("../services/loyalty");
const router = express.Router();
const PromoCode = require("../models/PromoCode");
const User = require("../models/User");
const Notification = require("../models/Notification");
const Offer = require("../models/Offer");
const crypto = require("crypto");
const axios = require("axios");

// ==================== BRAND ORDER CONFIRMATION WEBHOOK ====================
// POST /api/webhooks/confirm
// Called by a brand's site (WordPress/WooCommerce plugin) when an order is paid. No login: the body must be
// signed with the brand's own secret: header x-webhook-signature = hex HMAC-SHA256 of the raw body, keyed
// with User.webhookSecret of the brand that owns the code. No secret, a wrong or missing signature, or an
// unknown code all get the same reply, so the endpoint can't be used to find codes.
//   body: { coupon_code, order_id, amount, status }
// Only "processing" and "completed" orders count. If the brand's WooCommerce keys are set, the order is
// read back from the store and its total is used (the code must be on the order); otherwise the signed
// amount is used, after checks.
const { rateLimit } = require("express-rate-limit");
const confirmLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: () => Number(process.env.WEBHOOK_CONFIRM_RATE_LIMIT) || 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // "trust proxy" is not set: the last x-forwarded-for hop is the one Railway's proxy added
    keyGenerator: (req) => String(req.headers["x-forwarded-for"] || "").split(",").pop().trim() || req.ip || "unknown",
    message: { success: false, message: "Too many requests" },
});
const NOT_ACCEPTED = { success: false, message: "Webhook not accepted" };
const PAID_STATUSES = new Set(["processing", "completed"]);
const MAX_AMOUNT = 10000000; // PKR; anything above is a mistake or an attack

// hex HMAC compared in constant time; false for anything that isn't 64 hex characters
function signatureMatches(rawBody, secret, incoming) {
    if (typeof incoming !== "string" || !/^[0-9a-f]{64}$/i.test(incoming.trim())) return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
    const given = Buffer.from(incoming.trim(), "hex");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// the order as the brand's WooCommerce store has it (only when the brand's keys are set), https only
async function readBackWooOrder(brand, orderId) {
    let base;
    try {
        base = new URL(brand.websiteUrl);
    } catch {
        return { ok: false };
    }
    if (base.protocol !== "https:" || !/^\d+$/.test(String(orderId))) return { ok: false };
    try {
        const r = await axios.get(`${base.origin}${base.pathname.replace(/\/$/, "")}/wp-json/wc/v3/orders/${orderId}`, {
            auth: { username: brand.wooConsumerKey, password: brand.wooConsumerSecret },
            timeout: 10000,
            maxRedirects: 0,
            maxContentLength: 2 * 1024 * 1024,
        });
        return { ok: true, order: r.data };
    } catch {
        return { ok: false };
    }
}

router.post("/confirm", confirmLimit, async (req, res) => {
    try {
        const body = req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : null;
        if (!body || !req.rawBody) return res.status(400).json({ success: false, message: "Invalid JSON body" });
        const couponCode = typeof body.coupon_code === "string" ? body.coupon_code.toUpperCase().trim() : "";
        const orderId = body.order_id != null && /^[\w-]{1,64}$/.test(String(body.order_id)) ? String(body.order_id) : "";
        if (!couponCode || couponCode.length > 40 || !orderId) {
            return res.status(400).json({ success: false, message: "coupon_code and order_id are required" });
        }

        // code -> brand -> that brand's secret. Every failure on this path gives the same answer.
        const promoCodeDoc = await PromoCode.findOne({ code: couponCode });
        const brand = promoCodeDoc ? await User.findById(promoCodeDoc.brand).select("+webhookSecret +wooConsumerKey +wooConsumerSecret websiteUrl") : null;
        if (!brand || !brand.webhookSecret || !signatureMatches(req.rawBody, brand.webhookSecret, req.headers["x-webhook-signature"])) {
            return res.status(403).json(NOT_ACCEPTED);
        }

        // signed by the brand from here on
        const status = String(body.status || "").toLowerCase();
        if (!PAID_STATUSES.has(status)) {
            return res.json({ success: true, ignored: true, message: "Only processing or completed orders are counted" });
        }
        if (promoCodeDoc.status === "used") {
            return res.json({ success: true, alreadyUsed: true, message: "Promo code already confirmed" });
        }
        if (promoCodeDoc.status !== "active") {
            return res.status(409).json({ success: false, message: `Promo code is ${promoCodeDoc.status}` });
        }

        // the amount: from the store when we can read the order, otherwise the signed amount after checks
        let billAmount;
        let amountSource;
        if (brand.websiteUrl && brand.wooConsumerKey && brand.wooConsumerSecret) {
            const back = await readBackWooOrder(brand, orderId);
            if (!back.ok) return res.status(502).json({ success: false, message: "Could not read the order from the store; try again" });
            const order = back.order || {};
            const line = (order.coupon_lines || []).find((c) => String(c.code || "").toUpperCase().trim() === couponCode);
            if (!line) return res.status(409).json({ success: false, message: "The code is not on that order" });
            if (!PAID_STATUSES.has(String(order.status || "").toLowerCase())) {
                return res.json({ success: true, ignored: true, message: "Only processing or completed orders are counted" });
            }
            billAmount = (Number(order.total) || 0) + (Number(line.discount) || 0); // before the tdc discount
            amountSource = "store";
        } else {
            billAmount = Number(body.amount);
            amountSource = "signed";
        }
        if (!Number.isFinite(billAmount) || billAmount <= 0 || billAmount > MAX_AMOUNT) {
            return res.status(400).json({ success: false, message: "amount must be a positive number" });
        }
        billAmount = Math.round(billAmount);
        const savedAmount = Math.round((billAmount * promoCodeDoc.discountPercentage) / 100);

        // mark used only if still active (two deliveries of the same order count once)
        const marked = await PromoCode.findOneAndUpdate(
            { _id: promoCodeDoc._id, status: "active" },
            { $set: { status: "used", usedAt: new Date(), redeemedVia: "webhook", externalOrderId: orderId, externalAmount: billAmount }, $inc: { usedCount: 1 } },
            { new: true }
        );
        if (!marked) return res.json({ success: true, alreadyUsed: true, message: "Promo code already confirmed" });

        if (promoCodeDoc.offer) {
            const redemptionId = new mongoose.Types.ObjectId();
            await Offer.updateOne(
                { _id: promoCodeDoc.offer },
                { $push: { redemptions: { _id: redemptionId, student: promoCodeDoc.student, billAmount, savedAmount, redeemedAt: new Date(), promoCode: promoCodeDoc.code, promoCodeId: promoCodeDoc._id, source: "webhook", externalOrderId: orderId } } }
            );
            await creditSafe(redemptionId, { source: "webhook-confirm" }); // a loyalty visit (FLAG_LOYALTY_V2)
        }

        try {
            await Notification.create({
                recipient: promoCodeDoc.student,
                title: "✅ Promo Code Used!",
                description: `Your promo code ${promoCodeDoc.code} was confirmed at ${promoCodeDoc.brandName}! You saved Rs. ${savedAmount}.`,
                type: "System",
                icon: "checkmark-circle"
            });
            await Notification.create({
                recipient: brand._id,
                title: "💰 Webhook Order Confirmed",
                description: `Order #${orderId} completed with promo code ${promoCodeDoc.code}. Savings: Rs. ${savedAmount}`,
                type: "System",
                icon: "cash-outline"
            });
        } catch (notifError) {
            console.error("[webhook confirm] notification error:", notifError.message);
        }
        try {
            const { track } = require("../services/engagement");
            await track(promoCodeDoc.student, "deal_redeemed", {
                meta: { offerId: promoCodeDoc.offer?.toString(), savedAmount },
                dedupeKey: `deal:${promoCodeDoc.student}:${promoCodeDoc._id}:${orderId}`,
            });
        } catch (e) {
            console.error("[engagement] webhook deal hook failed:", e.message);
        }

        console.log(`[webhook confirm] code confirmed for order ${orderId} (${amountSource} amount)`);
        res.json({ success: true, message: "Promo code confirmed successfully", data: { orderId, savedAmount, status: "confirmed" } });
    } catch (err) {
        console.error("[webhook confirm] error:", err.message);
        res.status(500).json({ success: false, message: "Webhook processing failed" });
    }
});

// ==================== SHOPIFY ORDER CONFIRMATION WEBHOOK ====================
// POST /api/webhooks/shopify/confirm
// Called automatically by Shopify when orders/paid fires
router.post("/shopify/confirm", async (req, res) => {
  try {
    const incomingSignature = req.headers["x-shopify-hmac-sha256"];
    const shopDomain = req.headers["x-shopify-shop-domain"];

    console.log("📨 Shopify Webhook Received:", {
      shopDomain,
      topic: req.headers["x-shopify-topic"],
      hasSignature: !!incomingSignature,
      timestamp: new Date().toISOString()
    });

    const order = req.body || {};
    const discountCodes = order.discount_codes || [];

    if (discountCodes.length === 0) {
      console.log("ℹ️ Shopify Webhook: No discount codes found on order #", order.id || order.name);
      return res.status(200).json({ success: true, message: "No discount code on order" });
    }

    const appliedCode = discountCodes[0]?.code;
    if (!appliedCode) {
      return res.status(200).json({ success: true, message: "Empty discount code string" });
    }

    // STEP 1: Find the promo code
    const promoCodeDoc = await PromoCode.findOne({
      code: appliedCode.toUpperCase().trim()
    });

    if (!promoCodeDoc) {
      console.log("❌ Shopify Webhook: Promo code not found in DB:", appliedCode);
      return res.status(200).json({
        success: true,
        message: "Promo code not tracked by app"
      });
    }

    // STEP 2: Find the brand
    let brand = await User.findById(promoCodeDoc.brand).select("+shopifyWebhookSecret");
    if (!brand && shopDomain) {
      const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
      brand = await User.findOne({ shopifyStoreUrl: { $regex: new RegExp(cleanDomain, "i") } }).select("+shopifyWebhookSecret");
    }

    // STEP 3: Validate Webhook Signature
    const webhookSecret = brand?.shopifyWebhookSecret || process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_WEBHOOK_SECRET;

    // Always required: an unsigned request used to skip this check and still mark the code used.
    const expectedSignature = webhookSecret && req.rawBody
      ? crypto.createHmac("sha256", webhookSecret).update(req.rawBody).digest()
      : null;
    const givenSignature = typeof incomingSignature === "string" ? Buffer.from(incomingSignature, "base64") : null;
    if (!expectedSignature || !givenSignature || givenSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(givenSignature, expectedSignature)) {
      console.log("🔐 Shopify webhook signature missing or wrong");
      return res.status(403).json({
        success: false,
        message: "Invalid Shopify webhook signature"
      });
    }

    // STEP 4: Check if already redeemed
    if (promoCodeDoc.status === "used") {
      console.log("⚠️ Promo code already marked as used:", promoCodeDoc.code);
      return res.status(200).json({
        success: true,
        message: "Promo code already redeemed"
      });
    }

    // STEP 5: Calculate Savings & Mark as Used
    const billAmount = Number(order.total_price) || Number(order.subtotal_price) || 0;
    const discountAmount = (billAmount * promoCodeDoc.discountPercentage) / 100;
    const savedAmount = Math.round(discountAmount);
    const orderIdStr = (order.name || order.id || "").toString();

    promoCodeDoc.status = "used";
    promoCodeDoc.usedAt = new Date();
    promoCodeDoc.redeemedVia = "webhook";
    promoCodeDoc.externalOrderId = orderIdStr;
    promoCodeDoc.externalAmount = billAmount;
    promoCodeDoc.usedCount = (promoCodeDoc.usedCount || 0) + 1;

    await promoCodeDoc.save();
    console.log("✅ Shopify Promo Code marked as used:", promoCodeDoc.code);

    // STEP 6: Update Offer redemptions
    if (promoCodeDoc.offer) {
      const offer = await Offer.findById(promoCodeDoc.offer);
      if (offer) {
        offer.redemptions.push({
          student: promoCodeDoc.student,
          billAmount: billAmount,
          savedAmount: savedAmount,
          redeemedAt: new Date(),
          promoCode: promoCodeDoc.code,
          promoCodeId: promoCodeDoc._id,
          source: "shopify_webhook",
          externalOrderId: orderIdStr
        });
        const pushed = offer.redemptions[offer.redemptions.length - 1];
        await offer.save();
        await creditSafe(pushed._id, { source: "shopify-webhook" }); // a loyalty visit (FLAG_LOYALTY_V2)
      }
    }

    // STEP 7: Notifications
    try {
      await Notification.create({
        recipient: promoCodeDoc.student,
        title: "✅ Promo Code Used!",
        description: `Your promo code ${promoCodeDoc.code} was confirmed at ${promoCodeDoc.brandName || "Shopify store"}! You saved Rs. ${savedAmount}.`,
        type: "System",
        icon: "checkmark-circle"
      });

      if (brand) {
        await Notification.create({
          recipient: brand._id,
          title: "💰 Shopify Order Confirmed",
          description: `Order #${orderIdStr} completed with promo code ${promoCodeDoc.code}. Savings: Rs. ${savedAmount}`,
          type: "System",
          icon: "cash-outline"
        });
      }
    } catch (notifErr) {
      console.error("⚠️ Notification creation warning:", notifErr.message);
    }

    res.json({
      success: true,
      message: "Shopify order confirmation processed successfully",
      data: {
        code: promoCodeDoc.code,
        orderId: orderIdStr,
        savedAmount
      }
    });

  } catch (err) {
    console.error("❌ Shopify webhook error:", err);

    try {
  const { track } = require('../services/engagement');
  await track(promoCodeDoc.student, 'deal_redeemed', {
    meta: { offerId: promoCodeDoc.offer?.toString(), savedAmount },
    dedupeKey: `deal:${promoCodeDoc.student}:${promoCodeDoc._id}:${order_id || orderIdStr}`,
  });
} catch (e) {
  console.error('[engagement] webhook deal hook failed:', e.message);
}
    res.status(500).json({
      success: false,
      message: err.message || "Shopify webhook processing failed"
    });
  }
});

// ==================== TEST WEBHOOK ENDPOINT ====================
// GET /api/webhooks/test
router.get("/test", async (req, res) => {
    res.json({
        success: true,
        message: "Webhook endpoint is working",
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ==================== WEBHOOK STATUS (retired) ====================
// GET /api/webhooks/status/:code answered anyone with the code's student name and e-mail and told
// whether a code exists. Nothing calls it; it now answers 410 for every code.
router.get("/status/:code", (req, res) => {
    res.status(410).json({ success: false, message: "This endpoint is no longer available" });
});

module.exports = router;