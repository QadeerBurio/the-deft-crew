// services/storeStatus.js
// The online store a brand really has, for admin and brand lists:
//   { platform: "none" | "woocommerce" | "shopify", status: "none" | "connected" | "error" | "pending", storeUrl }
// WooCommerce comes from BrandStoreConnection, Shopify from an active ShopifyStore. No keys, ever.
const BrandStoreConnection = require("../models/BrandStoreConnection");
const ShopifyStore = require("../models/ShopifyStore");

async function onlineStoresFor(brandIds) {
  const ids = brandIds.filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  const [conns, shops] = await Promise.all([
    BrandStoreConnection.find({ brand: { $in: ids }, status: { $ne: "disconnected" } }).select("brand status storeUrl").lean(),
    ShopifyStore.find({ brandId: { $in: ids }, status: "active" }).select("brandId shop").lean(),
  ]);
  for (const id of ids) out.set(String(id), { platform: "none", status: "none", storeUrl: "" });
  for (const s of shops) out.set(String(s.brandId), { platform: "shopify", status: "connected", storeUrl: s.shop ? `https://${s.shop}` : "" });
  for (const c of conns) {
    if (out.get(String(c.brand))?.platform === "shopify") continue;
    out.set(String(c.brand), { platform: "woocommerce", status: c.status, storeUrl: c.storeUrl || "" });
  }
  return out;
}

module.exports = { onlineStoresFor };
