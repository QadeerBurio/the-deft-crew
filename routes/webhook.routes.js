// routes/webhook.routes.js
const express = require("express");
const router = express.Router();
const PromoCode = require("../models/PromoCode");
const User = require("../models/User");
const Notification = require("../models/Notification");
const crypto = require("crypto");

// ==================== BRAND ORDER CONFIRMATION WEBHOOK ====================
// POST /api/webhooks/confirm

router.post("/confirm", async (req, res) => {
    try {
        const { coupon_code, order_id, amount, status } = req.body;
        const incomingSignature = req.headers["x-webhook-signature"];

        console.log("Webhook received:", { coupon_code, order_id }); // Debug log

        if (!coupon_code || !order_id) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields: coupon_code, order_id"
            });
        }

        // Find the promo code
        const promoCodeDoc = await PromoCode.findOne({
            code: coupon_code.toUpperCase().trim()
        });

        if (!promoCodeDoc) {
            console.log("Promo code not found:", coupon_code); // Debug log
            return res.status(404).json({
                success: false,
                message: "Promo code not found"
            });
        }

        // Get the brand and verify signature
        const brand = await User.findById(promoCodeDoc.brand);
        if (!brand || !brand.webhookSecret) {
            return res.status(403).json({
                success: false,
                message: "Brand webhook not configured"
            });
        }

        // Verify signature
        const rawBody = JSON.stringify(req.body);
        const expectedSignature = crypto
            .createHmac("sha256", brand.webhookSecret)
            .update(rawBody)
            .digest("hex");

        console.log("Signature check:", { 
            incoming: incomingSignature, 
            expected: expectedSignature 
        }); // Debug log

        if (!incomingSignature || incomingSignature !== expectedSignature) {
            return res.status(403).json({
                success: false,
                message: "Invalid webhook signature"
            });
        }

        // Check if already used
        if (promoCodeDoc.status === "used") {
            return res.status(400).json({
                success: false,
                message: "This promo code has already been confirmed"
            });
        }

        // Mark as used
        promoCodeDoc.status = "used";
        promoCodeDoc.usedAt = new Date();
        promoCodeDoc.redeemedVia = "webhook";
        promoCodeDoc.externalOrderId = order_id.toString();
        promoCodeDoc.externalAmount = Number(amount) || 0;
        promoCodeDoc.usedCount = (promoCodeDoc.usedCount || 0) + 1;
        await promoCodeDoc.save();

        // Notify the student
        await Notification.create({
            recipient: promoCodeDoc.student,
            title: "✅ Promo Code Used!",
            description: `Your promo code ${promoCodeDoc.code} was confirmed at ${promoCodeDoc.brandName}!`,
            type: "System",
            icon: "checkmark-circle"
        });

        console.log("Promo code confirmed:", promoCodeDoc.code); // Debug log

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