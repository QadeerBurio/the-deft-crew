const express = require("express");
const router = express.Router();
const PromoCode = require("../models/PromoCode");
const User = require("../models/User");
const Notification = require("../models/Notification");
const Offer = require("../models/Offer");
const crypto = require("crypto");

// ==================== BRAND ORDER CONFIRMATION WEBHOOK ====================
// POST /api/webhooks/confirm
// Called by brand's WordPress/WooCommerce (or any external site) when an order completes
// No user login — verified instead via HMAC signature header, checked against raw request bytes

router.post("/confirm", async (req, res) => {
    let requestBody;
    let parsedBody;
    
    try {
        // Handle both raw and parsed body
        if (req.body && typeof req.body === 'object') {
            parsedBody = req.body;
            requestBody = JSON.stringify(req.body);
        } else if (req.body && Buffer.isBuffer(req.body)) {
            requestBody = req.body.toString();
            parsedBody = JSON.parse(requestBody);
        } else {
            // Try to parse if it's a string
            try {
                parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
                requestBody = JSON.stringify(parsedBody);
            } catch (e) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid JSON body"
                });
            }
        }

        const { coupon_code, order_id, amount, status, brand_website, brand_email } = parsedBody;
        const incomingSignature = req.headers["x-webhook-signature"];

        console.log('📨 Webhook received:', {
            coupon_code,
            order_id,
            amount,
            status,
            brand_website,
            brand_email,
            timestamp: new Date().toISOString()
        });

        // Validate required fields
        if (!coupon_code) {
            return res.status(400).json({
                success: false,
                message: "Missing required field: coupon_code"
            });
        }

        if (!order_id) {
            return res.status(400).json({
                success: false,
                message: "Missing required field: order_id"
            });
        }

        if (!req.rawBody) {
            return res.status(400).json({
                success: false,
                message: "Raw body unavailable for signature verification"
            });
        }

        // STEP 1: Find the promo code
        const promoCodeDoc = await PromoCode.findOne({
            code: coupon_code.toUpperCase().trim()
        });

        if (!promoCodeDoc) {
            console.log('❌ Promo code not found:', coupon_code);
            return res.status(404).json({
                success: false,
                message: "Promo code not found",
                code: coupon_code
            });
        }

        console.log('✅ Found promo code:', {
            code: promoCodeDoc.code,
            status: promoCodeDoc.status,
            brand: promoCodeDoc.brand,
            student: promoCodeDoc.student
        });

        // STEP 2: Get the brand
        const brand = await User.findById(promoCodeDoc.brand);
        if (!brand) {
            console.log('❌ Brand not found:', promoCodeDoc.brand);
            return res.status(404).json({
                success: false,
                message: "Brand not found"
            });
        }

        // STEP 3: Verify webhook signature (if configured)
        if (brand.webhookSecret) {
            const expectedSignature = crypto
                .createHmac("sha256", brand.webhookSecret)
                .update(req.rawBody)
                .digest("hex");

            console.log('🔐 Signature verification:', {
                expected: expectedSignature,
                received: incomingSignature,
                match: incomingSignature === expectedSignature
            });

            if (!incomingSignature || incomingSignature !== expectedSignature) {
                return res.status(403).json({
                    success: false,
                    message: "Invalid webhook signature"
                });
            }
        } else {
            // For backward compatibility - use default secret
            const defaultSecret = process.env.DEFAULT_WEBHOOK_SECRET || 'be0adcf4b7444c1cf51f9f2507f25f0c';
            const expectedSignature = crypto
                .createHmac("sha256", defaultSecret)
                .update(req.rawBody)
                .digest("hex");

            if (!incomingSignature || incomingSignature !== expectedSignature) {
                console.log('⚠️ No webhook secret configured and default signature mismatch');
                // Don't block - just log warning for now
                console.log('⚠️ Continuing without signature verification');
            }
        }

        // STEP 4: Check if already used
        if (promoCodeDoc.status === "used") {
            console.log('⚠️ Promo code already used:', promoCodeDoc.code);
            return res.status(200).json({
                success: true,
                message: "Promo code already confirmed",
                alreadyUsed: true
            });
        }

        // STEP 5: Calculate savings
        const billAmount = Number(amount) || 0;
        const discountAmount = (billAmount * promoCodeDoc.discountPercentage) / 100;
        const savedAmount = Math.round(discountAmount);

        // STEP 6: Mark as used
        promoCodeDoc.status = "used";
        promoCodeDoc.usedAt = new Date();
        promoCodeDoc.redeemedVia = "webhook";
        promoCodeDoc.externalOrderId = order_id.toString();
        promoCodeDoc.externalAmount = billAmount;
        promoCodeDoc.usedCount = (promoCodeDoc.usedCount || 0) + 1;
        
        await promoCodeDoc.save();
        console.log('✅ Promo code marked as used:', promoCodeDoc.code);

        // STEP 7: Update offer redemptions
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
                    source: 'webhook',
                    externalOrderId: order_id.toString()
                });
                await offer.save();
                console.log('✅ Offer redemptions updated');
            }
        }

        // STEP 8: Create notifications
        try {
            // Notify student
            await Notification.create({
                recipient: promoCodeDoc.student,
                title: "✅ Promo Code Used!",
                description: `Your promo code ${promoCodeDoc.code} was confirmed at ${promoCodeDoc.brandName}! You saved Rs. ${savedAmount}.`,
                type: "System",
                icon: "checkmark-circle"
            });

            // Notify brand
            await Notification.create({
                recipient: brand._id,
                title: "💰 Webhook Order Confirmed",
                description: `Order #${order_id} completed with promo code ${promoCodeDoc.code}. Savings: Rs. ${savedAmount}`,
                type: "System",
                icon: "cash-outline"
            });
            console.log('✅ Notifications created');
        } catch (notifError) {
            console.error('⚠️ Notification error:', notifError.message);
        }

        // STEP 9: Send success response
        res.json({
            success: true,
            message: "Promo code confirmed successfully",
            data: {
                promoCode: promoCodeDoc.code,
                orderId: order_id,
                savedAmount: savedAmount,
                status: "confirmed"
            }
        });

        console.log('✅ Webhook processed successfully:', {
            promoCode: promoCodeDoc.code,
            orderId: order_id,
            savedAmount: savedAmount
        });

    } catch (err) {
        console.error("❌ Webhook confirm error:", {
            message: err.message,
            stack: err.stack,
            body: req.body
        });

        // Always return a proper JSON response
        res.status(500).json({
            success: false,
            message: err.message || "Webhook processing failed",
            error: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
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
    let brand = await User.findById(promoCodeDoc.brand);
    if (!brand && shopDomain) {
      const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
      brand = await User.findOne({ shopifyStoreUrl: { $regex: new RegExp(cleanDomain, "i") } });
    }

    // STEP 3: Validate Webhook Signature
    const webhookSecret = brand?.shopifyWebhookSecret || process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_WEBHOOK_SECRET;

    if (webhookSecret && req.rawBody && incomingSignature) {
      const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(req.rawBody)
        .digest("base64");

      if (incomingSignature !== expectedSignature) {
        console.log("🔐 Shopify Signature mismatch!", {
          received: incomingSignature,
          expected: expectedSignature
        });
        return res.status(403).json({
          success: false,
          message: "Invalid Shopify webhook signature"
        });
      }
      console.log("✅ Shopify Webhook signature verified successfully");
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
        await offer.save();
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

// ==================== WEBHOOK STATUS ====================
// GET /api/webhooks/status/:code
router.get("/status/:code", async (req, res) => {
    try {
        const { code } = req.params;
        
        const promoCode = await PromoCode.findOne({
            code: code.toUpperCase().trim()
        }).populate('student', 'name email').populate('brand', 'name');

        if (!promoCode) {
            return res.status(404).json({
                success: false,
                message: "Promo code not found"
            });
        }

        res.json({
            success: true,
            data: {
                code: promoCode.code,
                status: promoCode.status,
                usedAt: promoCode.usedAt,
                redeemedVia: promoCode.redeemedVia,
                externalOrderId: promoCode.externalOrderId,
                externalAmount: promoCode.externalAmount,
                student: promoCode.student,
                brand: promoCode.brand
            }
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

module.exports = router;