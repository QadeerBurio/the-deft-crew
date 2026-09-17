// routes/shopifyApp.routes.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const PromoCode = require("../models/PromoCode");
const Offer = require("../models/Offer");

const verifyApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.SHOPIFY_APP_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

router.get("/brand", verifyApiKey, async (req, res) => {
  const { shop } = req.query;
  const brand = await User.findOne({
    shopifyStoreUrl: shop.toLowerCase().trim(),
    role: "brand",
  });

  if (!brand) {
    return res.status(404).json({ error: "Brand not found" });
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const now = new Date();

  const codes = await PromoCode.find({ brand: brand._id });
  const offers = await Offer.find({ brand: brand._id });
  const redemptions = offers.flatMap((o) => o.redemptions || []);
  const recent = redemptions.filter(
    (r) => r.redeemedAt >= thirtyDaysAgo && r.redeemedAt <= now
  );

  const totalRevenue = recent.reduce((s, r) => s + (r.billAmount || 0), 0);
  const totalDiscount = recent.reduce((s, r) => s + (r.savedAmount || 0), 0);
  const uniqueCustomers = new Set(recent.map((r) => String(r.student))).size;

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
});

module.exports = router;