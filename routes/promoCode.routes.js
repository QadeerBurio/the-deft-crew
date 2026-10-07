// routes/promoCode.routes.js
const express = require("express");
const router = express.Router();
const PromoCode = require("../models/PromoCode");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const auth = require("../middleware/auth.middleware");
const axios = require("axios");

// ============================================================
// HELPERS
// ============================================================

// Normalize "https://x.myshopify.com/" → "x.myshopify.com"
function normalizeShop(raw) {
  return String(raw || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase()
    .trim();
}

// ============================================================
// SHOPIFY — tell the Remix app to create the discount in the store
// ============================================================
async function createShopifyDiscountViaRemix(
  brand,
  code,
  discountPercentage,
  expiresAt
) {
  if (!brand.shopifyStoreUrl) {
    return { success: false, reason: "not_configured" };
  }

  const shop = normalizeShop(brand.shopifyStoreUrl);
  const url = `${process.env.SHOPIFY_APP_REMIX_URL}/api/internal/create-discount`;

  try {
    const response = await axios.post(
      url,
      {
        shop,
        code,
        discountType: "percentage",
        discountValue: discountPercentage,
        expiresAt: expiresAt.toISOString(),
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": process.env.SHOPIFY_APP_API_KEY,
        },
        timeout: 15000,
      }
    );

    if (!response.data?.success) {
      return {
        success: false,
        reason: response.data?.error || "shopify_error",
      };
    }

    return {
      success: true,
      shopifyDiscountId: response.data.shopifyDiscountId,
    };
  } catch (err) {
    const reason =
      err.response?.data?.error || err.message || "shopify_request_failed";
    console.error(
      `[shopify] create-discount failed for ${shop}:`,
      err.response?.data || err.message
    );
    return { success: false, reason };
  }
}

// ============================================================
// WOOCOMMERCE
// ============================================================
async function createWooCommerceCoupon(
  brand,
  code,
  discountPercentage,
  expiresAt
) {
  if (!brand.websiteUrl || !brand.wooConsumerKey || !brand.wooConsumerSecret) {
    return { success: false, reason: "not_configured" };
  }
  try {
    await axios.post(
      `${brand.websiteUrl.replace(/\/$/, "")}/wp-json/wc/v3/coupons`,
      {
        code,
        discount_type: "percent",
        amount: discountPercentage.toString(),
        individual_use: true,
        usage_limit: 1,
        date_expires: expiresAt.toISOString(),
      },
      {
        auth: {
          username: brand.wooConsumerKey,
          password: brand.wooConsumerSecret,
        },
        timeout: 15000,
      }
    );
    return { success: true };
  } catch (err) {
    console.error(
      "[woo] coupon creation failed:",
      err.response?.data || err.message
    );
    return { success: false, reason: err.message };
  }
}

// ============================================================
// CACHE (Redis, with in-memory fallback)
// ============================================================
// Shared with offer.routes.js, so clearing "offers:claimed:<id>" here
// really refreshes My Discounts.
const cache = require("../utils/cache");

// ============================================================
// GENERATE PROMO CODE
// ============================================================
router.post("/generate", auth, async (req, res) => {
  let newPromoCode = null;
  try {
    const { offerId } = req.body;
    const studentId = req.userId;

    if (!offerId) {
      return res
        .status(400)
        .json({ success: false, message: "offerId is required" });
    }

    const student = await User.findById(studentId).lean();
    if (!student) {
      return res
        .status(404)
        .json({ success: false, message: "Student not found" });
    }

    const offer = await Offer.findById(offerId)
      .populate("brand", "name brandName logo shopifyStoreUrl websiteUrl")
      .lean();

    if (!offer) {
      return res
        .status(404)
        .json({ success: false, message: "Offer not found" });
    }

    const hasClaimed = (offer.claimedBy || []).some(
      (id) => id.toString() === studentId.toString()
    );
    if (!hasClaimed) {
      return res
        .status(403)
        .json({ success: false, message: "You must claim this offer first" });
    }

    if (!offer.isOnline) {
      return res
        .status(400)
        .json({
          success: false,
          message: "This offer is not available online.",
        });
    }

    // One active code per (student, offer)
    const existingActive = await PromoCode.findOne({
      offer: offerId,
      student: studentId,
      status: "active",
    });
    if (existingActive) {
      return res
        .status(400)
        .json({
          success: false,
          message: "You already have an active promo code",
        });
    }

    // Daily redemption cap (2 per day per student per offer)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayRedemptions = (offer.redemptions || []).filter((r) => {
      const d = new Date(r.redeemedAt);
      d.setHours(0, 0, 0, 0);
      return (
        r.student?.toString() === studentId &&
        d.getTime() === today.getTime()
      );
    });
    if (todayRedemptions.length >= 2) {
      return res
        .status(400)
        .json({
          success: false,
          message: "You have already used this discount 2 times today.",
        });
    }

    // Lifetime cap (2 total per student per offer)
    const totalRedemptions = (offer.redemptions || []).filter(
      (r) => r.student?.toString() === studentId
    );
    if (totalRedemptions.length >= 2) {
      return res
        .status(400)
        .json({
          success: false,
          message: "You have already used this offer the maximum of 2 times.",
        });
    }

    // Prefix from brand name
    const brandDisplayName = offer.brand?.brandName || offer.brand?.name || "";
    const brandPrefix = brandDisplayName.substring(0, 3).toUpperCase() || "TDC";

    const promoCode = await PromoCode.generateUniqueCode(brandPrefix);

    newPromoCode = await PromoCode.create({
      code: promoCode,
      offer: offerId,
      student: studentId,
      brand: offer.brand._id,
      discountPercentage: offer.discountPercentage,
      offerTitle: offer.title,
      brandName: brandDisplayName || "Brand",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      generatedAt: new Date(),
      maxUses: 1,
      externalProvider: "none",
    });

    // Track on the offer
    await Offer.findByIdAndUpdate(offerId, {
      $push: { promoCodesGenerated: newPromoCode._id },
    });

    // ------- EXTERNAL PROVIDERS -------
    const brandUser = await User.findById(offer.brand._id).lean();

    // Shopify: tell Remix to create the discount
    if (brandUser?.shopifyStoreUrl) {
      const shopifyResult = await createShopifyDiscountViaRemix(
        brandUser,
        newPromoCode.code,
        newPromoCode.discountPercentage,
        newPromoCode.expiresAt
      );

      if (shopifyResult.success) {
        newPromoCode.externalProvider = "shopify";
        newPromoCode.externalDiscountId = shopifyResult.shopifyDiscountId;
        await newPromoCode.save();
      } else {
        // Roll back — do NOT give the student a code that won't work
        console.warn(
          `[generate] Shopify discount failed: ${shopifyResult.reason}`
        );
        await PromoCode.findByIdAndDelete(newPromoCode._id);
        await Offer.findByIdAndUpdate(offerId, {
          $pull: { promoCodesGenerated: newPromoCode._id },
        });
        return res.status(502).json({
          success: false,
          message:
            "Could not create the discount on the brand's Shopify store. Please try again later.",
          reason: shopifyResult.reason,
        });
      }
    }

    // WooCommerce (unchanged)
    if (
      brandUser?.websiteUrl &&
      brandUser?.wooConsumerKey &&
      brandUser?.wooConsumerSecret
    ) {
      const wooResult = await createWooCommerceCoupon(
        brandUser,
        newPromoCode.code,
        newPromoCode.discountPercentage,
        newPromoCode.expiresAt
      );
      if (wooResult.success) {
        newPromoCode.externalProvider = "woocommerce";
        await newPromoCode.save();
      } else {
        console.warn(`[generate] Woo coupon failed: ${wooResult.reason}`);
        // Same rollback for Woo
        await PromoCode.findByIdAndDelete(newPromoCode._id);
        await Offer.findByIdAndUpdate(offerId, {
          $pull: { promoCodesGenerated: newPromoCode._id },
        });
        return res.status(502).json({
          success: false,
          message:
            "Could not create the coupon on the brand's WooCommerce store. Please try again later.",
          reason: wooResult.reason,
        });
      }
    }

    // ------- CACHE -------
    try {
      if (cache && typeof cache.del === "function") {
        await cache.del(`offers:claimed:${studentId}`);
        await cache.del(`promo:student:${studentId}`);
      }
    } catch (cacheErr) {
      console.log("[cache] clear warning:", cacheErr.message);
    }

    // ------- NOTIFY -------
    await Notification.create({
      recipient: studentId,
      title: "🎉 Promo Code Generated!",
      description: `Your promo code ${promoCode} for ${offer.title} is ready.`,
      type: "System",
      icon: "ticket-outline",
      data: { promoCodeId: newPromoCode._id },
    });

    res.json({
      success: true,
      message: "Promo code generated successfully",
      promoCode: {
        code: newPromoCode.code,
        offerTitle: newPromoCode.offerTitle,
        brandName: newPromoCode.brandName,
        discountPercentage: newPromoCode.discountPercentage,
        expiresAt: newPromoCode.expiresAt,
        qrData: newPromoCode.qrData,
        externalProvider: newPromoCode.externalProvider,
      },
    });
  } catch (err) {
    console.error("Error generating promo code:", err);

    // Best-effort cleanup
    if (newPromoCode?._id) {
      try {
        await PromoCode.findByIdAndDelete(newPromoCode._id);
      } catch {}
    }

    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// VERIFY PROMO CODE (brand dashboard, in-person)
// NOTE: This endpoint DOES change state (marks code as used,
// adds redemption to offer). But the engagement hook was
// removed from here to avoid double-counting when the frontend
// also calls /confirm-redemption. Only /confirm-redemption
// awards points now.
// ============================================================
router.post("/verify", auth, async (req, res) => {
  try {
    const { promoCode, offerId, billAmount } = req.body;
    const brandId = req.userId;

    if (!promoCode || !offerId || !billAmount) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Missing required fields: promoCode, offerId, billAmount",
        });
    }

    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== "brand") {
      return res
        .status(403)
        .json({ success: false, message: "Only brands can verify promo codes" });
    }

    const promoCodeDoc = await PromoCode.findOne({
      code: promoCode.toUpperCase().trim(),
    });
    if (!promoCodeDoc) {
      return res
        .status(404)
        .json({
          success: false,
          message: "Invalid promo code. Please check and try again.",
        });
    }

    if (promoCodeDoc.brand.toString() !== brandId) {
      return res
        .status(403)
        .json({
          success: false,
          message: "This promo code does not belong to your brand",
        });
    }

    if (promoCodeDoc.status !== "active") {
      const statusMap = {
        used: "This promo code has already been used",
        expired: "This promo code has expired",
        cancelled: "This promo code has been cancelled",
      };
      return res
        .status(400)
        .json({
          success: false,
          message:
            statusMap[promoCodeDoc.status] ||
            "This promo code is no longer valid",
        });
    }

    if (new Date() > promoCodeDoc.expiresAt) {
      await PromoCode.findByIdAndUpdate(promoCodeDoc._id, {
        status: "expired",
      });
      return res
        .status(400)
        .json({ success: false, message: "This promo code has expired" });
    }

    if (promoCodeDoc.usedCount >= promoCodeDoc.maxUses) {
      await PromoCode.findByIdAndUpdate(promoCodeDoc._id, { status: "used" });
      return res
        .status(400)
        .json({
          success: false,
          message: "This promo code has already been used",
        });
    }

    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res
        .status(404)
        .json({ success: false, message: "Offer not found" });
    }

    if (offer._id.toString() !== promoCodeDoc.offer.toString()) {
      return res
        .status(400)
        .json({
          success: false,
          message: "This promo code is not valid for this offer",
        });
    }

    const studentId = promoCodeDoc.student;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayRedemptions = (offer.redemptions || []).filter((r) => {
      const d = new Date(r.redeemedAt);
      d.setHours(0, 0, 0, 0);
      return (
        r.student.toString() === studentId.toString() &&
        d.getTime() === today.getTime()
      );
    });

    if (todayRedemptions.length >= 2) {
      return res.status(400).json({
        success: false,
        message: "This student has already used this discount 2 times today",
        redemptionsUsed: todayRedemptions.length,
        maxRedemptions: 2,
      });
    }

    const discountAmount =
      (Number(billAmount) * promoCodeDoc.discountPercentage) / 100;
    const savedAmount = Math.round(discountAmount);
    const finalAmount = Number(billAmount) - savedAmount;

    await PromoCode.findByIdAndUpdate(promoCodeDoc._id, {
      status: "used",
      usedAt: new Date(),
      usedBy: studentId,
      $inc: { usedCount: 1 },
    });

    await Offer.findByIdAndUpdate(offerId, {
      $push: {
        redemptions: {
          student: studentId,
          billAmount: Number(billAmount),
          savedAmount,
          redeemedAt: new Date(),
          promoCode: promoCodeDoc.code,
          promoCodeId: promoCodeDoc._id,
        },
      },
    });

    const student = await User.findById(studentId).select("name");

    await Notification.create({
      recipient: studentId,
      title: "✅ Promo Code Used!",
      description: `Your promo code was successfully used at ${offer.title}! You saved Rs. ${savedAmount}.`,
      type: "System",
      icon: "checkmark-circle",
    });

    await Notification.create({
      recipient: brandId,
      title: "💰 Promo Code Redeemed!",
      description: `${student?.name || "A student"} used promo code ${
        promoCodeDoc.code
      } at ${offer.title}. Savings: Rs. ${savedAmount}`,
      type: "System",
      icon: "cash-outline",
    });

    // 🚫 engagement hook removed here — only /confirm-redemption awards points

    res.json({
      success: true,
      message: "Promo code verified and applied successfully!",
      data: {
        student: { id: studentId, name: student?.name || "Student" },
        offer: {
          id: offer._id,
          title: offer.title,
          discountPercentage: promoCodeDoc.discountPercentage,
        },
        billAmount: Number(billAmount),
        savedAmount,
        finalAmount,
        promoCode: promoCodeDoc.code,
      },
    });
  } catch (err) {
    console.error("Error verifying promo code:", err);
    res
      .status(500)
      .json({
        success: false,
        message: err.message || "Failed to verify promo code",
      });
  }
});

// ============================================================
// GET STUDENT'S PROMO CODES
// ============================================================
router.get("/my-codes", auth, async (req, res) => {
  try {
    const studentId = req.userId;
    const promoCodes = await PromoCode.find({ student: studentId })
      .populate("offer", "title discountPercentage image category")
      .populate("brand", "name brandName logo")
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: promoCodes.length,
      promoCodes: promoCodes.map((code) => ({
        id: code._id,
        code: code.code,
        offerTitle: code.offerTitle,
        brandName: code.brandName,
        discountPercentage: code.discountPercentage,
        status: code.status,
        expiresAt: code.expiresAt,
        usedAt: code.usedAt,
        generatedAt: code.generatedAt,
        qrData: code.qrData,
        externalProvider: code.externalProvider,
        offer: code.offer,
      })),
    });
  } catch (err) {
    console.error("Error fetching promo codes:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// GET BRAND'S PROMO CODES
// ============================================================
router.get("/brand-codes", auth, async (req, res) => {
  try {
    const brandId = req.userId;
    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== "brand") {
      return res
        .status(403)
        .json({ success: false, message: "Only brands can view this" });
    }

    const promoCodes = await PromoCode.find({ brand: brandId })
      .populate("student", "name email rollNo university")
      .populate("offer", "title discountPercentage")
      .sort({ createdAt: -1 })
      .lean();

    const activeCount = promoCodes.filter((p) => p.status === "active").length;
    const usedCount = promoCodes.filter((p) => p.status === "used").length;
    const expiredCount = promoCodes.filter(
      (p) => p.status === "expired"
    ).length;

    res.json({
      success: true,
      stats: {
        total: promoCodes.length,
        active: activeCount,
        used: usedCount,
        expired: expiredCount,
      },
      promoCodes: promoCodes.map((code) => ({
        id: code._id,
        code: code.code,
        student: {
          id: code.student?._id,
          name: code.student?.name || "Unknown",
          email: code.student?.email || "",
          rollNo: code.student?.rollNo || "N/A",
        },
        offerTitle: code.offerTitle,
        discountPercentage: code.discountPercentage,
        status: code.status,
        generatedAt: code.generatedAt,
        usedAt: code.usedAt,
        expiresAt: code.expiresAt,
        externalProvider: code.externalProvider,
      })),
    });
  } catch (err) {
    console.error("Error fetching brand promo codes:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// CANCEL PROMO CODE
// ============================================================
router.post("/cancel/:codeId", auth, async (req, res) => {
  try {
    const { codeId } = req.params;
    const studentId = req.userId;

    const promoCode = await PromoCode.findById(codeId);
    if (!promoCode) {
      return res
        .status(404)
        .json({ success: false, message: "Promo code not found" });
    }

    if (promoCode.student.toString() !== studentId) {
      return res
        .status(403)
        .json({
          success: false,
          message: "You can only cancel your own promo codes",
        });
    }

    if (promoCode.status !== "active") {
      return res
        .status(400)
        .json({
          success: false,
          message: `Cannot cancel a ${promoCode.status} promo code`,
        });
    }

    await PromoCode.findByIdAndUpdate(codeId, { status: "cancelled" });

    // Note: we do NOT delete the Shopify discount — merchant can clean up
    // in Shopify Admin if needed. This avoids an extra Remix round-trip.

    res.json({ success: true, message: "Promo code cancelled successfully" });
  } catch (err) {
    console.error("Error cancelling promo code:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// GET PROMO CODE DETAILS
// ============================================================
router.get("/:code", auth, async (req, res) => {
  try {
    const { code } = req.params;
    const userId = req.userId;

    const promoCode = await PromoCode.findOne({
      code: code.toUpperCase().trim(),
    })
      .populate("offer", "title description discountPercentage image category")
      .populate("brand", "name brandName logo")
      .populate("student", "name email")
      .lean();

    if (!promoCode) {
      return res
        .status(404)
        .json({ success: false, message: "Promo code not found" });
    }

    const isStudent = promoCode.student._id.toString() === userId;
    const isBrand = promoCode.brand._id.toString() === userId;

    if (!isStudent && !isBrand) {
      return res
        .status(403)
        .json({
          success: false,
          message: "You are not authorized to view this promo code",
        });
    }

    res.json({
      success: true,
      promoCode: {
        id: promoCode._id,
        code: promoCode.code,
        offerTitle: promoCode.offerTitle,
        brandName: promoCode.brandName,
        discountPercentage: promoCode.discountPercentage,
        status: promoCode.status,
        expiresAt: promoCode.expiresAt,
        generatedAt: promoCode.generatedAt,
        usedAt: promoCode.usedAt,
        qrData: promoCode.qrData,
        externalProvider: promoCode.externalProvider,
        offer: promoCode.offer,
        brand: promoCode.brand,
        student: isStudent
          ? {
              id: promoCode.student._id,
              name: promoCode.student.name,
              email: promoCode.student.email,
            }
          : undefined,
      },
    });
  } catch (err) {
    console.error("Error fetching promo code:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// BULK VERIFY (brand admin)
// ============================================================
router.post("/bulk-verify", auth, async (req, res) => {
  try {
    const { promoCodes } = req.body;
    const brandId = req.userId;

    if (!Array.isArray(promoCodes) || promoCodes.length === 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Please provide an array of promo codes",
        });
    }

    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== "brand") {
      return res
        .status(403)
        .json({ success: false, message: "Only brands can verify promo codes" });
    }

    const results = [];
    const errors = [];

    for (const code of promoCodes) {
      try {
        const trimmedCode = String(code).toUpperCase().trim();
        const promoCodeDoc = await PromoCode.findOne({ code: trimmedCode });

        if (!promoCodeDoc) {
          errors.push({ code: trimmedCode, error: "Not found" });
          continue;
        }
        if (promoCodeDoc.brand.toString() !== brandId) {
          errors.push({
            code: trimmedCode,
            error: "Not owned by this brand",
          });
          continue;
        }
        if (promoCodeDoc.status !== "active") {
          errors.push({
            code: trimmedCode,
            error: `Status: ${promoCodeDoc.status}`,
          });
          continue;
        }
        if (new Date() > promoCodeDoc.expiresAt) {
          errors.push({ code: trimmedCode, error: "Expired" });
          continue;
        }

        results.push({
          code: trimmedCode,
          valid: true,
          student: promoCodeDoc.student,
          discountPercentage: promoCodeDoc.discountPercentage,
          offerTitle: promoCodeDoc.offerTitle,
        });
      } catch (err) {
        errors.push({ code, error: err.message });
      }
    }

    res.json({
      success: true,
      valid: results.length,
      invalid: errors.length,
      results,
      errors,
    });
  } catch (err) {
    console.error("Error in bulk verify:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// BRAND VERIFY PROMO CODE (dry-run, no state change)
// ============================================================
router.post("/brand-verify", auth, async (req, res) => {
  try {
    const { promoCode, offerId, billAmount } = req.body;
    const brandId = req.userId;

    if (!promoCode || !offerId || !billAmount) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Missing required fields: promoCode, offerId, billAmount",
        });
    }

    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== "brand") {
      return res
        .status(403)
        .json({ success: false, message: "Only brands can verify promo codes" });
    }

    const promoCodeDoc = await PromoCode.findOne({
      code: promoCode.toUpperCase().trim(),
    });
    if (!promoCodeDoc) {
      return res
        .status(404)
        .json({
          success: false,
          message: "Invalid promo code. Please check and try again.",
        });
    }

    if (promoCodeDoc.brand.toString() !== brandId) {
      return res
        .status(403)
        .json({
          success: false,
          message: "This promo code does not belong to your brand",
          brandMismatch: true,
        });
    }

    if (promoCodeDoc.status !== "active") {
      const statusMap = {
        used: "This promo code has already been used",
        expired: "This promo code has expired",
        cancelled: "This promo code has been cancelled",
      };
      return res
        .status(400)
        .json({
          success: false,
          message:
            statusMap[promoCodeDoc.status] ||
            "This promo code is no longer valid",
          status: promoCodeDoc.status,
        });
    }

    if (new Date() > promoCodeDoc.expiresAt) {
      await PromoCode.findByIdAndUpdate(promoCodeDoc._id, {
        status: "expired",
      });
      return res
        .status(400)
        .json({
          success: false,
          message: "This promo code has expired",
          status: "expired",
        });
    }

    if (promoCodeDoc.usedCount >= promoCodeDoc.maxUses) {
      await PromoCode.findByIdAndUpdate(promoCodeDoc._id, { status: "used" });
      return res
        .status(400)
        .json({
          success: false,
          message: "This promo code has already been used",
          status: "used",
        });
    }

    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res
        .status(404)
        .json({ success: false, message: "Offer not found" });
    }

    if (offer._id.toString() !== promoCodeDoc.offer.toString()) {
      return res
        .status(400)
        .json({
          success: false,
          message: "This promo code is not valid for this offer",
        });
    }

    const studentId = promoCodeDoc.student;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayRedemptions = (offer.redemptions || []).filter((r) => {
      const d = new Date(r.redeemedAt);
      d.setHours(0, 0, 0, 0);
      return (
        r.student.toString() === studentId.toString() &&
        d.getTime() === today.getTime()
      );
    });

    if (todayRedemptions.length >= 2) {
      return res.status(400).json({
        success: false,
        message: "This student has already used this discount 2 times today",
        redemptionsUsed: todayRedemptions.length,
        maxRedemptions: 2,
      });
    }

    const student = await User.findById(studentId).select(
      "name email rollNo university"
    );
    const discountAmount =
      (Number(billAmount) * promoCodeDoc.discountPercentage) / 100;
    const savedAmount = Math.round(discountAmount);
    const finalAmount = Number(billAmount) - savedAmount;

    // 🚫 engagement hook removed here — this is a DRY-RUN endpoint

    res.json({
      success: true,
      verified: true,
      message: "Promo code verified successfully!",
      data: {
        student: {
          id: studentId,
          name: student?.name || "Student",
          email: student?.email || "",
          rollNo: student?.rollNo || "N/A",
          university: student?.university || "N/A",
        },
        offer: {
          id: offer._id,
          title: offer.title,
          discountPercentage: promoCodeDoc.discountPercentage,
        },
        promoCode: {
          code: promoCodeDoc.code,
          expiresAt: promoCodeDoc.expiresAt,
          generatedAt: promoCodeDoc.generatedAt,
        },
        transaction: {
          billAmount: Number(billAmount),
          savedAmount,
          finalAmount,
          discountPercentage: promoCodeDoc.discountPercentage,
        },
      },
    });
  } catch (err) {
    console.error("Error verifying promo code:", err);
    res
      .status(500)
      .json({
        success: false,
        message: err.message || "Failed to verify promo code",
      });
  }
});

// ============================================================
// CONFIRM REDEMPTION (state-changing, brand dashboard)
// THIS is the ONLY endpoint that awards deal_redeemed points.
// ============================================================
router.post("/confirm-redemption", auth, async (req, res) => {
  try {
    const { promoCode, offerId, billAmount } = req.body;
    const brandId = req.userId;

    if (!promoCode || !offerId || !billAmount) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields" });
    }

    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== "brand") {
      return res
        .status(403)
        .json({
          success: false,
          message: "Only brands can confirm redemption",
        });
    }

    const promoCodeDoc = await PromoCode.findOne({
      code: promoCode.toUpperCase().trim(),
    });
    if (!promoCodeDoc) {
      return res
        .status(404)
        .json({ success: false, message: "Promo code not found" });
    }

    if (promoCodeDoc.brand.toString() !== brandId) {
      return res
        .status(403)
        .json({
          success: false,
          message: "This promo code does not belong to your brand",
        });
    }

    if (promoCodeDoc.status !== "active") {
      return res
        .status(400)
        .json({
          success: false,
          message: "This promo code is no longer valid",
        });
    }

    const studentId = promoCodeDoc.student;
    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res
        .status(404)
        .json({ success: false, message: "Offer not found" });
    }

    const discountAmount =
      (Number(billAmount) * promoCodeDoc.discountPercentage) / 100;
    const savedAmount = Math.round(discountAmount);

    await PromoCode.findByIdAndUpdate(promoCodeDoc._id, {
      status: "used",
      usedAt: new Date(),
      usedBy: studentId,
      externalAmount: Number(billAmount),
      $inc: { usedCount: 1 },
    });

    await Offer.findByIdAndUpdate(offerId, {
      $push: {
        redemptions: {
          student: studentId,
          billAmount: Number(billAmount),
          savedAmount,
          redeemedAt: new Date(),
          promoCode: promoCodeDoc.code,
          promoCodeId: promoCodeDoc._id,
        },
      },
    });

    const student = await User.findById(studentId).select("name");

    await Notification.create({
      recipient: studentId,
      title: "✅ Promo Code Used!",
      description: `Your promo code was successfully used at ${offer.title}! You saved Rs. ${savedAmount}.`,
      type: "System",
      icon: "checkmark-circle",
    });

    await Notification.create({
      recipient: brandId,
      title: "💰 Promo Code Redeemed!",
      description: `${student?.name || "A student"} used promo code ${
        promoCodeDoc.code
      } at ${offer.title}. Savings: Rs. ${savedAmount}`,
      type: "System",
      icon: "cash-outline",
    });

    // 🎯 engagement hook — the ONLY place this fires
    // Uses promoCodeDoc._id in the dedupe key so retries are idempotent.
    try {
      const { track } = require("../services/engagement");
      await track(studentId.toString(), "deal_redeemed", {
        meta: { offerId: offer._id.toString(), savedAmount },
        dedupeKey: `deal:${studentId}:${offer._id}:${promoCodeDoc._id}`,
      });
    } catch (e) {
      console.error("[engagement] promo deal hook failed:", e.message);
    }

    res.json({
      success: true,
      message: "Promo code redeemed successfully!",
      data: {
        student: { id: studentId, name: student?.name || "Student" },
        offer: { id: offer._id, title: offer.title },
        transaction: {
          billAmount: Number(billAmount),
          savedAmount,
          promoCode: promoCodeDoc.code,
        },
      },
    });
  } catch (err) {
    console.error("Error confirming redemption:", err);
    res
      .status(500)
      .json({
        success: false,
        message: err.message || "Failed to confirm redemption",
      });
  }
});

// ============================================================
// BRAND STATISTICS
// ============================================================
router.get("/brand-stats", auth, async (req, res) => {
  try {
    const brandId = req.userId;
    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== "brand") {
      return res
        .status(403)
        .json({ success: false, message: "Only brands can view this" });
    }

    const promoCodes = await PromoCode.find({ brand: brandId });
    const offers = await Offer.find({ brand: brandId });

    const totalCodes = promoCodes.length;
    const activeCodes = promoCodes.filter((p) => p.status === "active").length;
    const usedCodes = promoCodes.filter((p) => p.status === "used").length;
    const expiredCodes = promoCodes.filter(
      (p) => p.status === "expired"
    ).length;

    let totalSavings = 0;
    let totalRedemptions = 0;

    offers.forEach((offer) => {
      (offer.redemptions || []).forEach((r) => {
        totalSavings += r.savedAmount || 0;
        totalRedemptions += 1;
      });
    });

    res.json({
      success: true,
      stats: {
        totalCodes,
        activeCodes,
        usedCodes,
        expiredCodes,
        totalSavings,
        totalRedemptions,
        totalOffers: offers.length,
      },
      recentRedemptions: offers
        .flatMap((offer) =>
          (offer.redemptions || []).map((r) => ({
            ...r.toObject(),
            offerTitle: offer.title,
          }))
        )
        .sort((a, b) => new Date(b.redeemedAt) - new Date(a.redeemedAt))
        .slice(0, 10),
    });
  } catch (err) {
    console.error("Error fetching brand stats:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// BRAND GET SPECIFIC PROMO CODE
// ============================================================
router.get("/brand/code/:code", auth, async (req, res) => {
  try {
    const { code } = req.params;
    const brandId = req.userId;

    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== "brand") {
      return res
        .status(403)
        .json({ success: false, message: "Only brands can view this" });
    }

    const promoCode = await PromoCode.findOne({
      code: code.toUpperCase().trim(),
    })
      .populate("student", "name email rollNo university")
      .populate("offer", "title discountPercentage");

    if (!promoCode) {
      return res
        .status(404)
        .json({ success: false, message: "Promo code not found" });
    }

    if (promoCode.brand.toString() !== brandId) {
      return res
        .status(403)
        .json({
          success: false,
          message: "This promo code does not belong to your brand",
        });
    }

    res.json({
      success: true,
      promoCode: {
        code: promoCode.code,
        status: promoCode.status,
        expiresAt: promoCode.expiresAt,
        generatedAt: promoCode.generatedAt,
        usedAt: promoCode.usedAt,
        discountPercentage: promoCode.discountPercentage,
        offerTitle: promoCode.offerTitle,
        externalProvider: promoCode.externalProvider,
        externalDiscountId: promoCode.externalDiscountId,
        student: {
          name: promoCode.student?.name || "Unknown",
          email: promoCode.student?.email || "",
          rollNo: promoCode.student?.rollNo || "N/A",
          university: promoCode.student?.university || "N/A",
        },
        offer: promoCode.offer,
      },
    });
  } catch (err) {
    console.error("Error fetching brand promo code:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;