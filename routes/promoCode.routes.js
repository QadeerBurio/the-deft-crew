// routes/promoCode.routes.js - PUBLIC APP VERSION
const express = require("express");
const router = express.Router();
const PromoCode = require("../models/PromoCode");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const ShopifyStore = require("../models/ShopifyStore"); // NEW
const auth = require("../middleware/auth.middleware");
const crypto = require("crypto");
const axios = require("axios");

// ==================== OAUTH STATE STORE ====================
const stateStore = new Map();

// ==================== OAUTH ROUTES ====================

// Step 1: Start OAuth — redirect merchant to Shopify
router.get("/auth/shopify", auth, async (req, res) => {
  try {
    const { shop, brandId } = req.query;
    if (!shop || !brandId) {
      return res.status(400).json({ success: false, message: "Missing shop or brandId" });
    }

    const brand = await User.findById(brandId);
    if (!brand || brand.role !== "brand") {
      return res.status(404).json({ success: false, message: "Brand not found" });
    }

    let cleanShop = shop.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
    if (!cleanShop.includes(".")) cleanShop = `${cleanShop}.myshopify.com`;

    const state = crypto.randomBytes(32).toString("hex");
    stateStore.set(state, { brandId, shop: cleanShop, createdAt: Date.now() });

    // Clean old states
    for (const [key, value] of stateStore.entries()) {
      if (Date.now() - value.createdAt > 600000) stateStore.delete(key);
    }

    const authUrl = `https://${cleanShop}/admin/oauth/authorize?` +
      `client_id=${process.env.SHOPIFY_API_KEY}&` +
      `scope=${process.env.SHOPIFY_SCOPES}&` +
      `redirect_uri=${encodeURIComponent(process.env.SHOPIFY_REDIRECT_URI)}&` +
      `state=${state}`;

    res.json({ success: true, authUrl });
  } catch (err) {
    console.error("OAuth start error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Step 2: OAuth callback — exchange code for access token
router.get("/auth/shopify/callback", async (req, res) => {
  try {
    const { code, shop, state, hmac } = req.query;

    const stored = stateStore.get(state);
    if (!stored) {
      return res.status(400).send("Invalid or expired state.");
    }

    // Verify HMAC
    const queryParams = { ...req.query };
    delete queryParams.hmac;
    delete queryParams.signature;

    const sortedParams = Object.keys(queryParams)
      .sort()
      .map(key => `${key}=${queryParams[key]}`)
      .join("&");

    const calculatedHmac = crypto
      .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(sortedParams)
      .digest("hex");

    if (calculatedHmac !== hmac) {
      return res.status(401).send("HMAC verification failed");
    }

    // Exchange code for access token (expiring=1 is required for new public apps) [citation:8]
    const tokenResponse = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
        expiring: 1
      }
    );

    const { access_token, refresh_token, expires_in, scope } = tokenResponse.data;

    await ShopifyStore.findOneAndUpdate(
      { shop },
      {
        brandId: stored.brandId,
        shop,
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenExpiresAt: new Date(Date.now() + (expires_in || 86400) * 1000),
        scopes: scope ? scope.split(",") : [],
        status: "active",
        installedAt: new Date(),
        uninstalledAt: null
      },
      { upsert: true, new: true }
    );

    stateStore.delete(state);

    const adminUrl = process.env.TDC_ADMIN_URL || process.env.SHOPIFY_APP_URL;
    res.redirect(`${adminUrl}/brands/${stored.brandId}?shopify=connected`);
  } catch (err) {
    console.error("OAuth callback error:", err.response?.data || err.message);
    res.status(500).send("Failed to complete Shopify connection");
  }
});

// Get connection status
router.get("/auth/shopify/status/:brandId", auth, async (req, res) => {
  try {
    const { brandId } = req.params;
    const store = await ShopifyStore.findOne({ brandId, status: "active" }).lean();
    res.json({
      success: true,
      connected: !!store,
      shop: store?.shop || null,
      installedAt: store?.installedAt || null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== TOKEN MANAGEMENT ====================

async function getShopifyAccessToken(shop) {
  const store = await ShopifyStore.findOne({ shop, status: "active" });
  if (!store) return { success: false, reason: "Store not connected" };

  // Refresh if expiring within 5 minutes [citation:8]
  if (store.tokenExpiresAt && new Date(store.tokenExpiresAt) < new Date(Date.now() + 5 * 60 * 1000)) {
    if (!store.refreshToken) {
      return { success: false, reason: "Token expired, no refresh token" };
    }
    try {
      const refreshResponse = await axios.post(
        `https://${shop}/admin/oauth/access_token`,
        {
          client_id: process.env.SHOPIFY_API_KEY,
          client_secret: process.env.SHOPIFY_API_SECRET,
          grant_type: "refresh_token",
          refresh_token: store.refreshToken
        }
      );
      store.accessToken = refreshResponse.data.access_token;
      store.refreshToken = refreshResponse.data.refresh_token || store.refreshToken;
      store.tokenExpiresAt = new Date(Date.now() + (refreshResponse.data.expires_in || 86400) * 1000);
      await store.save();
    } catch (refreshErr) {
      console.error("Token refresh failed:", refreshErr.response?.data || refreshErr.message);
      return { success: false, reason: "Token refresh failed" };
    }
  }

  return { success: true, accessToken: store.accessToken, storeDomain: shop };
}

// ==================== SHOPIFY DISCOUNT CREATION ====================

async function createShopifyDiscount(brandId, code, discountPercentage, expiresAt) {
  try {
    const store = await ShopifyStore.findOne({ brandId, status: "active" }).lean();
    if (!store) {
      console.log(`Skipping Shopify sync — brand ${brandId} has no connected store`);
      return { success: false, reason: "No connected Shopify store" };
    }

    const authResult = await getShopifyAccessToken(store.shop);
    if (!authResult.success) {
      return { success: false, reason: authResult.reason };
    }

    const { accessToken, storeDomain } = authResult;
    const graphqlUrl = `https://${storeDomain}/admin/api/2024-01/graphql.json`;

    const query = `
      mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
          codeDiscountNode { id }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      basicCodeDiscount: {
        title: code,
        code: code,
        startsAt: new Date().toISOString(),
        endsAt: new Date(expiresAt).toISOString(),
        usageLimit: 1,
        customerSelection: { all: true },
        customerGets: {
          value: { percentage: Number(discountPercentage) / 100 },
          items: { all: true }
        }
      }
    };

    const response = await axios.post(graphqlUrl, { query, variables }, {
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" }
    });

    const result = response.data?.data?.discountCodeBasicCreate;
    if (result?.userErrors?.length > 0) {
      return { success: false, reason: result.userErrors[0].message };
    }

    console.log(`✅ Shopify discount ${code} created on ${storeDomain}`);
    return { success: true, discountNodeId: result?.codeDiscountNode?.id };
  } catch (err) {
    console.error("Shopify discount creation failed:", err.response?.data || err.message);
    return { success: false, reason: err.message };
  }
}

// ==================== WOOCOMMERCE (unchanged) ====================

async function createWooCommerceCoupon(brand, code, discountPercentage, expiresAt) {
  if (!brand.websiteUrl || !brand.wooConsumerKey || !brand.wooConsumerSecret) {
    return { success: false, reason: "not_configured" };
  }
  try {
    await axios.post(
      `${brand.websiteUrl.replace(/\/$/, "")}/wp-json/wc/v3/coupons`,
      {
        code, discount_type: "percent",
        amount: discountPercentage.toString(),
        individual_use: true, usage_limit: 1,
        date_expires: expiresAt.toISOString()
      },
      { auth: { username: brand.wooConsumerKey, password: brand.wooConsumerSecret } }
    );
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ==================== CACHE SETUP ====================
let cache;
try {
  const Redis = require("ioredis");
  cache = new Redis(process.env.REDIS_URL);
} catch (e) {
  cache = {
    store: new Map(),
    async get(key) {
      const item = this.store.get(key);
      if (!item) return null;
      if (Date.now() > item.expiry) { this.store.delete(key); return null; }
      return item.data;
    },
    async set(key, data, ttl = 300) {
      this.store.set(key, { data, expiry: Date.now() + ttl * 1000 });
    },
    async del(pattern) {
      for (const key of this.store.keys()) {
        if (key.includes(pattern)) this.store.delete(key);
      }
    }
  };
}

// ==================== GENERATE PROMO CODE ====================
router.post("/generate", auth, async (req, res) => {
  try {
    const { offerId } = req.body;
    const studentId = req.userId;

    const student = await User.findById(studentId).lean();
    if (!student) return res.status(404).json({ success: false, message: "Student not found" });

    const offer = await Offer.findById(offerId).populate("brand", "name").lean();
    if (!offer) return res.status(404).json({ success: false, message: "Offer not found" });

    const hasClaimed = offer.claimedBy?.some(id => id.toString() === studentId.toString());
    if (!hasClaimed) {
      return res.status(403).json({ success: false, message: "You must claim this offer first" });
    }

    if (!offer.isOnline) {
      return res.status(400).json({ success: false, message: "This offer is not available online." });
    }

    const existingActive = await PromoCode.findOne({ offer: offerId, student: studentId, status: "active" });
    if (existingActive) {
      return res.status(400).json({ success: false, message: "You already have an active promo code" });
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayRedemptions = offer.redemptions?.filter(r => {
      const redeemDate = new Date(r.redeemedAt); redeemDate.setHours(0, 0, 0, 0);
      return r.student?.toString() === studentId && redeemDate.getTime() === today.getTime();
    }) || [];

    if (todayRedemptions.length >= 2) {
      return res.status(400).json({ success: false, message: "You have already used this discount 2 times today." });
    }

    const totalRedemptions = offer.redemptions?.filter(r => r.student?.toString() === studentId) || [];
    if (totalRedemptions.length >= 2) {
      return res.status(400).json({ success: false, message: "You have already used this offer the maximum of 2 times." });
    }

    const brandPrefix = offer.brand?.name?.substring(0, 3).toUpperCase() || "TDC";
    const promoCode = await PromoCode.generateUniqueCode(brandPrefix);

    const newPromoCode = await PromoCode.create({
      code: promoCode, offer: offerId, student: studentId,
      brand: offer.brand._id, discountPercentage: offer.discountPercentage,
      offerTitle: offer.title, brandName: offer.brand?.name || "Brand",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      generatedAt: new Date(), maxUses: 1
    });

    await Offer.findByIdAndUpdate(offerId, { $push: { promoCodesGenerated: newPromoCode._id } });

    // Sync to Shopify or WooCommerce
    const brandUser = await User.findById(offer.brand._id);
    if (brandUser) {
      if (brandUser?.websiteUrl) {
  await createWooCommerceCoupon(brandUser, newPromoCode.code, newPromoCode.discountPercentage, newPromoCode.expiresAt);
}
    }

    try {
      if (cache && typeof cache.del === "function") {
        await cache.del(`offers:claimed:${studentId}`);
        await cache.del(`promo:student:${studentId}`);
      }
    } catch (cacheErr) { console.log("Cache clear warning:", cacheErr.message); }

    await Notification.create({
      recipient: studentId,
      title: "🎉 Promo Code Generated!",
      description: `Your promo code ${promoCode} for ${offer.title} is ready.`,
      type: "System", icon: "ticket-outline",
      data: { promoCodeId: newPromoCode._id }
    });

    res.json({
      success: true, message: "Promo code generated successfully",
      promoCode: {
        code: newPromoCode.code, offerTitle: newPromoCode.offerTitle,
        brandName: newPromoCode.brandName, discountPercentage: newPromoCode.discountPercentage,
        expiresAt: newPromoCode.expiresAt, qrData: newPromoCode.qrData
      }
    });
  } catch (err) {
    console.error("Error generating promo code:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});





// ==================== VERIFY PROMO CODE ====================
// POST /api/promo-codes/verify
// Brand verifies a promo code during checkout
router.post("/verify", auth, async (req, res) => {
  try {
    const { promoCode, offerId, billAmount } = req.body;
    const brandId = req.userId;

    // Validate required fields
    if (!promoCode || !offerId || !billAmount) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: promoCode, offerId, billAmount"
      });
    }

    // Verify brand is authenticated
    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== 'brand') {
      return res.status(403).json({
        success: false,
        message: "Only brands can verify promo codes"
      });
    }

    // Find the promo code
    const promoCodeDoc = await PromoCode.findOne({
      code: promoCode.toUpperCase().trim()
    });

    if (!promoCodeDoc) {
      return res.status(404).json({
        success: false,
        message: "Invalid promo code. Please check and try again."
      });
    }

    // Check if promo code belongs to this brand
    if (promoCodeDoc.brand.toString() !== brandId) {
      return res.status(403).json({
        success: false,
        message: "This promo code does not belong to your brand"
      });
    }

    // Check if promo code is active
    if (promoCodeDoc.status !== 'active') {
      const statusMap = {
        'used': 'This promo code has already been used',
        'expired': 'This promo code has expired',
        'cancelled': 'This promo code has been cancelled'
      };
      return res.status(400).json({
        success: false,
        message: statusMap[promoCodeDoc.status] || 'This promo code is no longer valid'
      });
    }

    // Check if expired
    if (new Date() > promoCodeDoc.expiresAt) {
      await PromoCode.findByIdAndUpdate(promoCodeDoc._id, { status: 'expired' });
      return res.status(400).json({
        success: false,
        message: "This promo code has expired"
      });
    }

    // Check if usage limit reached
    if (promoCodeDoc.usedCount >= promoCodeDoc.maxUses) {
      await PromoCode.findByIdAndUpdate(promoCodeDoc._id, { status: 'used' });
      return res.status(400).json({
        success: false,
        message: "This promo code has already been used"
      });
    }

    // Find the offer and verify it matches
    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res.status(404).json({
        success: false,
        message: "Offer not found"
      });
    }

    // Verify offer matches promo code
    if (offer._id.toString() !== promoCodeDoc.offer.toString()) {
      return res.status(400).json({
        success: false,
        message: "This promo code is not valid for this offer"
      });
    }

    // Check if student has already redeemed today
    const studentId = promoCodeDoc.student;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayRedemptions = offer.redemptions.filter(r => {
      const redeemDate = new Date(r.redeemedAt);
      redeemDate.setHours(0, 0, 0, 0);
      return r.student.toString() === studentId.toString() &&
        redeemDate.getTime() === today.getTime();
    });

    if (todayRedemptions.length >= 2) {
      return res.status(400).json({
        success: false,
        message: "This student has already used this discount 2 times today",
        redemptionsUsed: todayRedemptions.length,
        maxRedemptions: 2
      });
    }

    // Calculate savings
    const discountAmount = (Number(billAmount) * promoCodeDoc.discountPercentage) / 100;
    const savedAmount = Math.round(discountAmount);
    const finalAmount = Number(billAmount) - savedAmount;

    // Mark promo code as used
    await PromoCode.findByIdAndUpdate(promoCodeDoc._id, {
      status: 'used',
      usedAt: new Date(),
      usedBy: studentId,
      $inc: { usedCount: 1 }
    });

    // Add redemption to offer
    await Offer.findByIdAndUpdate(offerId, {
      $push: {
        redemptions: {
          student: studentId,
          billAmount: Number(billAmount),
          savedAmount: savedAmount,
          redeemedAt: new Date(),
          promoCode: promoCodeDoc.code,
          promoCodeId: promoCodeDoc._id
        }
      }
    });

    // Get student details for notification
    const student = await User.findById(studentId).select('name');

    // Create notification for student
    await Notification.create({
      recipient: studentId,
      title: "✅ Promo Code Used!",
      description: `Your promo code was successfully used at ${offer.title}! You saved Rs. ${savedAmount}.`,
      type: "System",
      icon: "checkmark-circle"
    });

    // Create notification for brand
    await Notification.create({
      recipient: brandId,
      title: "💰 Promo Code Redeemed!",
      description: `${student?.name || 'A student'} used promo code ${promoCodeDoc.code} at ${offer.title}. Savings: Rs. ${savedAmount}`,
      type: "System",
      icon: "cash-outline"
    });

    res.json({
      success: true,
      message: "Promo code verified and applied successfully!",
      data: {
        student: {
          id: studentId,
          name: student?.name || 'Student'
        },
        offer: {
          id: offer._id,
          title: offer.title,
          discountPercentage: promoCodeDoc.discountPercentage
        },
        billAmount: Number(billAmount),
        savedAmount: savedAmount,
        finalAmount: finalAmount,
        promoCode: promoCodeDoc.code
      }
    });

  } catch (err) {
    console.error("Error verifying promo code:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to verify promo code"
    });
  }
});

// ==================== GET STUDENT'S PROMO CODES ====================
// GET /api/promo-codes/my-codes
router.get("/my-codes", auth, async (req, res) => {
  try {
    const studentId = req.userId;

    const promoCodes = await PromoCode.find({
      student: studentId
    })
      .populate('offer', 'title discountPercentage image category')
      .populate('brand', 'name')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: promoCodes.length,
      promoCodes: promoCodes.map(code => ({
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
        offer: code.offer
      }))
    });

  } catch (err) {
    console.error("Error fetching promo codes:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

// ==================== GET BRAND'S PROMO CODES ====================
// GET /api/promo-codes/brand-codes
router.get("/brand-codes", auth, async (req, res) => {
  try {
    const brandId = req.userId;

    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== 'brand') {
      return res.status(403).json({
        success: false,
        message: "Only brands can view this"
      });
    }

    const promoCodes = await PromoCode.find({
      brand: brandId
    })
      .populate('student', 'name email rollNo university')
      .populate('offer', 'title discountPercentage')
      .sort({ createdAt: -1 })
      .lean();

    // Get statistics
    const activeCount = promoCodes.filter(p => p.status === 'active').length;
    const usedCount = promoCodes.filter(p => p.status === 'used').length;
    const expiredCount = promoCodes.filter(p => p.status === 'expired').length;

    res.json({
      success: true,
      stats: {
        total: promoCodes.length,
        active: activeCount,
        used: usedCount,
        expired: expiredCount
      },
      promoCodes: promoCodes.map(code => ({
        id: code._id,
        code: code.code,
        student: {
          id: code.student?._id,
          name: code.student?.name || 'Unknown',
          email: code.student?.email || '',
          rollNo: code.student?.rollNo || 'N/A'
        },
        offerTitle: code.offerTitle,
        discountPercentage: code.discountPercentage,
        status: code.status,
        generatedAt: code.generatedAt,
        usedAt: code.usedAt,
        expiresAt: code.expiresAt
      }))
    });

  } catch (err) {
    console.error("Error fetching brand promo codes:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

// ==================== CANCEL PROMO CODE ====================
// POST /api/promo-codes/cancel/:codeId
router.post("/cancel/:codeId", auth, async (req, res) => {
  try {
    const { codeId } = req.params;
    const studentId = req.userId;

    const promoCode = await PromoCode.findById(codeId);
    if (!promoCode) {
      return res.status(404).json({
        success: false,
        message: "Promo code not found"
      });
    }

    // Only the student who owns it can cancel
    if (promoCode.student.toString() !== studentId) {
      return res.status(403).json({
        success: false,
        message: "You can only cancel your own promo codes"
      });
    }

    // Can only cancel active codes
    if (promoCode.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a ${promoCode.status} promo code`
      });
    }

    await PromoCode.findByIdAndUpdate(codeId, { status: 'cancelled' });

    res.json({
      success: true,
      message: "Promo code cancelled successfully"
    });

  } catch (err) {
    console.error("Error cancelling promo code:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

// ==================== GET PROMO CODE DETAILS ====================
// GET /api/promo-codes/:code
router.get("/:code", auth, async (req, res) => {
  try {
    const { code } = req.params;
    const userId = req.userId;

    const promoCode = await PromoCode.findOne({
      code: code.toUpperCase().trim()
    })
      .populate('offer', 'title description discountPercentage image category')
      .populate('brand', 'name logo')
      .populate('student', 'name email')
      .lean();

    if (!promoCode) {
      return res.status(404).json({
        success: false,
        message: "Promo code not found"
      });
    }

    // Check if user is authorized to view this code
    const isStudent = promoCode.student._id.toString() === userId;
    const isBrand = promoCode.brand._id.toString() === userId;

    if (!isStudent && !isBrand) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to view this promo code"
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
        offer: promoCode.offer,
        brand: promoCode.brand,
        student: isStudent ? {
          id: promoCode.student._id,
          name: promoCode.student.name,
          email: promoCode.student.email
        } : undefined
      }
    });

  } catch (err) {
    console.error("Error fetching promo code:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

// ==================== BULK VERIFY (for brand admin) ====================
// POST /api/promo-codes/bulk-verify
router.post("/bulk-verify", auth, async (req, res) => {
  try {
    const { promoCodes, offerId } = req.body;
    const brandId = req.userId;

    if (!Array.isArray(promoCodes) || promoCodes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide an array of promo codes"
      });
    }

    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== 'brand') {
      return res.status(403).json({
        success: false,
        message: "Only brands can verify promo codes"
      });
    }

    const results = [];
    const errors = [];

    for (const code of promoCodes) {
      try {
        const trimmedCode = code.toUpperCase().trim();
        const promoCodeDoc = await PromoCode.findOne({ code: trimmedCode });

        if (!promoCodeDoc) {
          errors.push({ code: trimmedCode, error: "Not found" });
          continue;
        }

        if (promoCodeDoc.brand.toString() !== brandId) {
          errors.push({ code: trimmedCode, error: "Not owned by this brand" });
          continue;
        }

        if (promoCodeDoc.status !== 'active') {
          errors.push({ code: trimmedCode, error: `Status: ${promoCodeDoc.status}` });
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
          offerTitle: promoCodeDoc.offerTitle
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
      errors
    });

  } catch (err) {
    console.error("Error in bulk verify:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

// routes/promoCode.routes.js - Add these new routes

// ==================== BRAND VERIFY PROMO CODE (For Brand Dashboard) ====================
// POST /api/promo-codes/brand-verify
// Brand verifies a promo code from their dashboard
router.post("/brand-verify", auth, async (req, res) => {
  try {
    const { promoCode, offerId, billAmount } = req.body;
    const brandId = req.userId;

    // Validate required fields
    if (!promoCode || !offerId || !billAmount) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: promoCode, offerId, billAmount"
      });
    }

    // Verify brand is authenticated
    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== 'brand') {
      return res.status(403).json({
        success: false,
        message: "Only brands can verify promo codes"
      });
    }

    // Find the promo code
    const promoCodeDoc = await PromoCode.findOne({
      code: promoCode.toUpperCase().trim()
    });

    if (!promoCodeDoc) {
      return res.status(404).json({
        success: false,
        message: "Invalid promo code. Please check and try again."
      });
    }

    // Check if promo code belongs to this brand
    if (promoCodeDoc.brand.toString() !== brandId) {
      return res.status(403).json({
        success: false,
        message: "This promo code does not belong to your brand",
        brandMismatch: true
      });
    }

    // Check if promo code is active
    if (promoCodeDoc.status !== 'active') {
      const statusMap = {
        'used': 'This promo code has already been used',
        'expired': 'This promo code has expired',
        'cancelled': 'This promo code has been cancelled'
      };
      return res.status(400).json({
        success: false,
        message: statusMap[promoCodeDoc.status] || 'This promo code is no longer valid',
        status: promoCodeDoc.status
      });
    }

    // Check if expired
    if (new Date() > promoCodeDoc.expiresAt) {
      await PromoCode.findByIdAndUpdate(promoCodeDoc._id, { status: 'expired' });
      return res.status(400).json({
        success: false,
        message: "This promo code has expired",
        status: 'expired'
      });
    }

    // Check if usage limit reached
    if (promoCodeDoc.usedCount >= promoCodeDoc.maxUses) {
      await PromoCode.findByIdAndUpdate(promoCodeDoc._id, { status: 'used' });
      return res.status(400).json({
        success: false,
        message: "This promo code has already been used",
        status: 'used'
      });
    }

    // Find the offer and verify it matches
    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res.status(404).json({
        success: false,
        message: "Offer not found"
      });
    }

    // Verify offer matches promo code
    if (offer._id.toString() !== promoCodeDoc.offer.toString()) {
      return res.status(400).json({
        success: false,
        message: "This promo code is not valid for this offer"
      });
    }

    // Check if student has already redeemed today
    const studentId = promoCodeDoc.student;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayRedemptions = offer.redemptions.filter(r => {
      const redeemDate = new Date(r.redeemedAt);
      redeemDate.setHours(0, 0, 0, 0);
      return r.student.toString() === studentId.toString() &&
        redeemDate.getTime() === today.getTime();
    });

    if (todayRedemptions.length >= 2) {
      return res.status(400).json({
        success: false,
        message: "This student has already used this discount 2 times today",
        redemptionsUsed: todayRedemptions.length,
        maxRedemptions: 2
      });
    }

    // Get student details
    const student = await User.findById(studentId).select('name email rollNo university');

    // Calculate savings
    const discountAmount = (Number(billAmount) * promoCodeDoc.discountPercentage) / 100;
    const savedAmount = Math.round(discountAmount);
    const finalAmount = Number(billAmount) - savedAmount;

    // Return verification data without marking as used (brand can confirm)
    res.json({
      success: true,
      verified: true,
      message: "Promo code verified successfully!",
      data: {
        student: {
          id: studentId,
          name: student?.name || 'Student',
          email: student?.email || '',
          rollNo: student?.rollNo || 'N/A',
          university: student?.university || 'N/A'
        },
        offer: {
          id: offer._id,
          title: offer.title,
          discountPercentage: promoCodeDoc.discountPercentage
        },
        promoCode: {
          code: promoCodeDoc.code,
          expiresAt: promoCodeDoc.expiresAt,
          generatedAt: promoCodeDoc.generatedAt
        },
        transaction: {
          billAmount: Number(billAmount),
          savedAmount: savedAmount,
          finalAmount: finalAmount,
          discountPercentage: promoCodeDoc.discountPercentage
        }
      }
    });

  } catch (err) {
    console.error("Error verifying promo code:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to verify promo code"
    });
  }
});

// ==================== CONFIRM REDEMPTION ====================
// POST /api/promo-codes/confirm-redemption
// Brand confirms the redemption after verification
router.post("/confirm-redemption", auth, async (req, res) => {
  try {
    const { promoCode, offerId, billAmount } = req.body;
    const brandId = req.userId;

    if (!promoCode || !offerId || !billAmount) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== 'brand') {
      return res.status(403).json({
        success: false,
        message: "Only brands can confirm redemption"
      });
    }

    const promoCodeDoc = await PromoCode.findOne({
      code: promoCode.toUpperCase().trim()
    });

    if (!promoCodeDoc) {
      return res.status(404).json({
        success: false,
        message: "Promo code not found"
      });
    }

    if (promoCodeDoc.brand.toString() !== brandId) {
      return res.status(403).json({
        success: false,
        message: "This promo code does not belong to your brand"
      });
    }

    if (promoCodeDoc.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: "This promo code is no longer valid"
      });
    }

    const studentId = promoCodeDoc.student;
    const offer = await Offer.findById(offerId);

    if (!offer) {
      return res.status(404).json({
        success: false,
        message: "Offer not found"
      });
    }

    // Calculate savings
    const discountAmount = (Number(billAmount) * promoCodeDoc.discountPercentage) / 100;
    const savedAmount = Math.round(discountAmount);

    // Mark promo code as used
    await PromoCode.findByIdAndUpdate(promoCodeDoc._id, {
      status: 'used',
      usedAt: new Date(),
      usedBy: studentId,
      externalAmount: Number(billAmount), // ✅ Add this
      $inc: { usedCount: 1 }
    });

    // Add redemption to offer
    await Offer.findByIdAndUpdate(offerId, {
      $push: {
        redemptions: {
          student: studentId,
          billAmount: Number(billAmount),
          savedAmount: savedAmount,
          redeemedAt: new Date(),
          promoCode: promoCodeDoc.code,
          promoCodeId: promoCodeDoc._id
        }
      }
    });

    // Get student details for notification
    const student = await User.findById(studentId).select('name');

    // Create notification for student
    await Notification.create({
      recipient: studentId,
      title: "✅ Promo Code Used!",
      description: `Your promo code was successfully used at ${offer.title}! You saved Rs. ${savedAmount}.`,
      type: "System",
      icon: "checkmark-circle"
    });

    // Create notification for brand
    await Notification.create({
      recipient: brandId,
      title: "💰 Promo Code Redeemed!",
      description: `${student?.name || 'A student'} used promo code ${promoCodeDoc.code} at ${offer.title}. Savings: Rs. ${savedAmount}`,
      type: "System",
      icon: "cash-outline"
    });

    res.json({
      success: true,
      message: "Promo code redeemed successfully!",
      data: {
        student: {
          id: studentId,
          name: student?.name || 'Student'
        },
        offer: {
          id: offer._id,
          title: offer.title
        },
        transaction: {
          billAmount: Number(billAmount),
          savedAmount: savedAmount,
          promoCode: promoCodeDoc.code
        }
      }
    });

  } catch (err) {
    console.error("Error confirming redemption:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to confirm redemption"
    });
  }
});

// ==================== GET BRAND STATISTICS ====================
// GET /api/promo-codes/brand-stats
router.get("/brand-stats", auth, async (req, res) => {
  try {
    const brandId = req.userId;

    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== 'brand') {
      return res.status(403).json({
        success: false,
        message: "Only brands can view this"
      });
    }

    // Get all promo codes for this brand
    const promoCodes = await PromoCode.find({ brand: brandId });

    // Get all offers for this brand
    const offers = await Offer.find({ brand: brandId });

    // Calculate statistics
    const totalCodes = promoCodes.length;
    const activeCodes = promoCodes.filter(p => p.status === 'active').length;
    const usedCodes = promoCodes.filter(p => p.status === 'used').length;
    const expiredCodes = promoCodes.filter(p => p.status === 'expired').length;

    // Get total savings
    let totalSavings = 0;
    let totalRedemptions = 0;

    offers.forEach(offer => {
      offer.redemptions.forEach(r => {
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
        totalOffers: offers.length
      },
      recentRedemptions: offers.flatMap(offer =>
        offer.redemptions.map(r => ({
          ...r.toObject(),
          offerTitle: offer.title
        }))
      ).sort((a, b) => new Date(b.redeemedAt) - new Date(a.redeemedAt)).slice(0, 10)
    });

  } catch (err) {
    console.error("Error fetching brand stats:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

// ==================== BRAND GET SPECIFIC PROMO CODE ====================
// GET /api/promo-codes/brand/code/:code
router.get("/brand/code/:code", auth, async (req, res) => {
  try {
    const { code } = req.params;
    const brandId = req.userId;

    const brand = await User.findById(brandId).lean();
    if (!brand || brand.role !== 'brand') {
      return res.status(403).json({
        success: false,
        message: "Only brands can view this"
      });
    }

    const promoCode = await PromoCode.findOne({
      code: code.toUpperCase().trim()
    })
      .populate('student', 'name email rollNo university')
      .populate('offer', 'title discountPercentage');

    if (!promoCode) {
      return res.status(404).json({
        success: false,
        message: "Promo code not found"
      });
    }

    if (promoCode.brand.toString() !== brandId) {
      return res.status(403).json({
        success: false,
        message: "This promo code does not belong to your brand"
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
        student: {
          name: promoCode.student?.name || 'Unknown',
          email: promoCode.student?.email || '',
          rollNo: promoCode.student?.rollNo || 'N/A',
          university: promoCode.student?.university || 'N/A'
        },
        offer: promoCode.offer
      }
    });

  } catch (err) {
    console.error("Error fetching brand promo code:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});
module.exports = router;