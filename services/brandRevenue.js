// services/brandRevenue.js
// A brand's revenue figures from its offers and used promo codes, built on services/brandSales.js (one sale per
// store order, each promo code's own discount). Used by account deletion to keep a deleted brand's totals
// (RedemptionArchive "brand-totals"); the live pages use brandSales directly (with deleted / test accounts left out).
//   offers: the brand's offers (lean), redemptions with student as an id (not populated)
//   promos: the brand's used promo codes (lean)
const { rowsFrom, figures } = require("./brandSales");

function brandFigures(offers = [], promos = []) {
  return { ...figures(rowsFrom(offers, promos)), offersCount: offers.length };
}

// the numbers a RedemptionArchive "brand-totals" row keeps (no offer title)
const TOTAL_KEYS = ["totalRevenue", "totalBill", "totalSaved", "totalRedemptions", "uniqueStudents", "qrRevenue", "qrBill", "qrSaved", "qrCount", "promoRevenue", "promoBill", "promoCount", "offersCount"];
const totalsOnly = (f) => Object.fromEntries(TOTAL_KEYS.map((k) => [k, f[k] || 0]));

module.exports = { brandFigures, totalsOnly, TOTAL_KEYS };
