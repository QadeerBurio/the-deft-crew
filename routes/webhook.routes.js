// routes/webhook.routes.js
const express = require("express");
const router = express.Router();
const PromoCode = require("../models/PromoCode");
const User = require("../models/User");
const Notification = require("../models/Notification");
const crypto = require("crypto");

// ==================== BRAND ORDER CONFIRMATION WEBHOOK ====================
// POST /api/webhooks/confirm
// Called by brand's WordPress/WooCommerce when an order completes

router.post("/confirm", async (req, res) => {
    try {
        const { coupon_code, order_id, amount, status, brand_website, brand_email } = req.body;
        const incomingSignature = req.headers["x-webhook-signature"];

        console.log('Webhook received:', { coupon_code, order_id, amount, status });

        if (!coupon_code || !order_id) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields: coupon_code, order_id"
            });
        }

        // STEP 1: Find the promo code first
        const promoCodeDoc = await PromoCode.findOne({
            code: coupon_code.toUpperCase().trim()
        });

        if (!promoCodeDoc) {
            console.log('Promo code not found:', coupon_code);
            return res.status(404).json({
                success: false,
                message: "Promo code not found"
            });
        }

        console.log('Found promo code:', promoCodeDoc.code);

        // STEP 2: Get the brand and verify webhook secret
        const brand = await User.findById(promoCodeDoc.brand);
        if (!brand) {
            console.log('Brand not found for promo code:', promoCodeDoc.brand);
            return res.status(404).json({
                success: false,
                message: "Brand not found"
            });
        }

        // STEP 3: Check if webhook is configured for this brand
        if (!brand.webhookSecret) {
            console.log('Brand webhook not configured:', brand._id);
            
            // For backward compatibility - use default secret if brand doesn't have one
            const defaultSecret = 'be0adcf4b7444c1cf51f9f2507f25f0c';
            if (!incomingSignature || incomingSignature !== crypto
                .createHmac("sha256", defaultSecret)
                .update(JSON.stringify(req.body))
                .digest("hex")) {
                return res.status(403).json({
                    success: false,
                    message: "Webhook not configured for this brand"
                });
            }
        } else {
            // Verify with brand's own secret
            const rawBody = JSON.stringify(req.body);
            const expectedSignature = crypto
                .createHmac("sha256", brand.webhookSecret)
                .update(rawBody)
                .digest("hex");

            console.log('Expected signature:', expectedSignature);
            console.log('Received signature:', incomingSignature);

            if (!incomingSignature || incomingSignature !== expectedSignature) {
                return res.status(403).json({
                    success: false,
                    message: "Invalid webhook signature"
                });
            }
        }

        // STEP 4: Check if already used
        if (promoCodeDoc.status === "used") {
            console.log('Promo code already used:', promoCodeDoc.code);
            return res.status(400).json({
                success: false,
                message: "This promo code has already been confirmed"
            });
        }

        // STEP 5: Mark as used
        promoCodeDoc.status = "used";
        promoCodeDoc.usedAt = new Date();
        promoCodeDoc.redeemedVia = "webhook";
        promoCodeDoc.externalOrderId = order_id.toString();
        promoCodeDoc.externalAmount = Number(amount) || 0;
        promoCodeDoc.usedCount = (promoCodeDoc.usedCount || 0) + 1;
        await promoCodeDoc.save();

        console.log('Promo code marked as used:', promoCodeDoc.code);

        // STEP 6: Also update the offer redemptions if available
        if (promoCodeDoc.offer) {
            const Offer = require("../models/Offer");
            const offer = await Offer.findById(promoCodeDoc.offer);
            if (offer) {
                const savedAmount = (Number(amount) * promoCodeDoc.discountPercentage) / 100;
                offer.redemptions.push({
                    student: promoCodeDoc.student,
                    billAmount: Number(amount) || 0,
                    savedAmount: Math.round(savedAmount),
                    redeemedAt: new Date(),
                    promoCode: promoCodeDoc.code,
                    promoCodeId: promoCodeDoc._id,
                    source: 'webhook'
                });
                await offer.save();
            }
        }

        // STEP 7: Notify the student
        await Notification.create({
            recipient: promoCodeDoc.student,
            title: "✅ Promo Code Used!",
            description: `Your promo code ${promoCodeDoc.code} was confirmed at ${promoCodeDoc.brandName}!`,
            type: "System",
            icon: "checkmark-circle"
        });

        // STEP 8: Notify the brand
        await Notification.create({
            recipient: brand._id,
            title: "💰 Webhook Order Received",
            description: `Order #${order_id} completed with promo code ${promoCodeDoc.code}`,
            type: "System",
            icon: "cash-outline"
        });

        res.json({
            success: true,
            message: "Promo code confirmed successfully"
        });

    } catch (err) {
        console.error("Webhook confirm error:", err);
        res.status(500).json({
            success: false,
            message: err.message || "Webhook processing failed"
        });
    }
});

module.exports = router;