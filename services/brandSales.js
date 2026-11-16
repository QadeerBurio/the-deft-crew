// services/brandSales.js
// One list of sales (a bill a student paid a brand through tdc) behind every revenue number: admin "brand revenue",
// the admin brand profile, the brand portal (dashboard "revenue from tdc" / "students saved", savings history),
// the metrics page and the overview (services/analytics/adminMetrics.js).
//
//   a sale = an offer redemption (QR / in-store, promo confirm / verify, store orders: Shopify, WooCommerce)
//          + a used promo code that NO redemption points to (older codes marked used before a redemption was written)
//   A store-webhook order writes both a used promo code and a redemption (with promoCodeId): it counts once.
//   bill = what the student was billed; saved = the discount (a promo's own %); paid = bill - saved
//   Left out: rows of deleted students (their id is a placeholder that no longer exists) and of test accounts
//   (services/analytics/accountRules.js), and brands that are test accounts.
//   Deleted brands: their redemptions kept in RedemptionArchive ("redemption" rows), counted once (includeArchived).
const Offer = require("../models/Offer");
const PromoCode = require("../models/PromoCode");
const RedemptionArchive = require("../models/RedemptionArchive");
const { testRule, liveIds, isId } = require("./analytics/accountRules");

const s = (v) => (v == null ? "" : String(v));
const within = (d, from, to) => (!from || new Date(d) >= from) && (!to || new Date(d) <= to);

/**
 * offers (lean, with redemptions; student as an id or populated), used promo codes (lean), archived redemptions →
 * one row per sale. A promo code a redemption points to (promoCodeId, or the same code at the same brand) is that
 * redemption, not a second sale.
 */
function rowsFrom(offers = [], promos = [], archived = [], { from = null, to = null } = {}) {
  const linkedIds = new Set();
  const linkedCodes = new Set();
  const promoById = new Map(promos.map((p) => [s(p._id), p]));
  const rows = [];
  for (const o of offers) {
    for (const r of o.redemptions || []) {
      if (r.promoCodeId) linkedIds.add(s(r.promoCodeId));
      if (r.promoCode) linkedCodes.add(`${s(o.brand?._id || o.brand)}:${s(r.promoCode).toUpperCase()}`);
      if (!within(r.redeemedAt, from, to)) continue;
      const promo = r.promoCodeId ? promoById.get(s(r.promoCodeId)) : null;
      const online = !!(r.promoCodeId || r.promoCode || r.externalOrderId);
      const bill = r.billAmount || 0;
      const saved = r.savedAmount || 0;
      rows.push({
        kind: "redemption", id: s(r._id), brand: s(o.brand?._id || o.brand), offerId: s(o._id), offerTitle: o.title || "Offer", offerImage: o.image,
        discountPercentage: o.discountPercentage || 0, student: r.student, studentId: s(r.student?._id || r.student),
        bill, saved, paid: bill - saved, at: r.redeemedAt, redemptionType: online ? "promo" : "qr",
        provider: promo?.externalProvider && promo.externalProvider !== "none" ? promo.externalProvider : null,
        promoCode: r.promoCode || null, externalOrderId: r.externalOrderId || null,
      });
    }
  }
  for (const p of promos) {
    if (linkedIds.has(s(p._id)) || linkedCodes.has(`${s(p.brand?._id || p.brand)}:${s(p.code).toUpperCase()}`)) continue;
    const at = p.usedAt || p.updatedAt;
    if (!within(at, from, to)) continue;
    const bill = p.externalAmount || 0;
    const saved = Math.round((bill * (p.discountPercentage || 0)) / 100); // this code's own discount
    rows.push({
      kind: "promo", id: s(p._id), brand: s(p.brand?._id || p.brand), offerId: s(p.offer?._id || p.offer), offerTitle: p.offerTitle || p.offer?.title || "Offer", offerImage: p.offer?.image,
      discountPercentage: p.discountPercentage || 0, student: p.student, studentId: s(p.student?._id || p.student),
      bill, saved, paid: bill - saved, at, redemptionType: "promo",
      provider: p.externalProvider && p.externalProvider !== "none" ? p.externalProvider : null,
      promoCode: p.code, externalOrderId: p.externalOrderId || null,
    });
  }
  for (const a of archived) {
    if (!within(a.redeemedAt, from, to)) continue;
    const bill = a.billAmount || 0;
    const saved = a.savedAmount || 0;
    rows.push({ kind: "archived", id: s(a._id), brand: "deleted", deletionId: a.deletionId, offerId: s(a.offerId), offerTitle: "deleted brand", student: a.student, studentId: s(a.student), bill, saved, paid: bill - saved, at: a.redeemedAt, redemptionType: "qr", provider: null, promoCode: null });
  }
  return rows;
}

/** totals for some rows (one brand, or everything): unique students counted once across all of them */
function figures(rows) {
  const sum = (list, k) => list.reduce((t, r) => t + (r[k] || 0), 0);
  const qr = rows.filter((r) => r.redemptionType === "qr");
  const promo = rows.filter((r) => r.redemptionType === "promo");
  const byOffer = new Map();
  for (const r of rows) byOffer.set(r.offerTitle, (byOffer.get(r.offerTitle) || 0) + 1);
  const top = [...byOffer.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    totalRevenue: sum(rows, "paid"), totalBill: sum(rows, "bill"), totalSaved: sum(rows, "saved"), totalRedemptions: rows.length,
    uniqueStudents: new Set(rows.map((r) => r.studentId).filter(Boolean)).size,
    qrRevenue: sum(qr, "paid"), qrBill: sum(qr, "bill"), qrSaved: sum(qr, "saved"), qrCount: qr.length,
    promoRevenue: sum(promo, "paid"), promoBill: sum(promo, "bill"), promoSaved: sum(promo, "saved"), promoCount: promo.length,
    topOffer: top ? top[0] : "—", topOfferCount: top ? top[1] : 0,
  };
}

/** drop rows of deleted / test students and of test brands */
async function keepReal(rows, rule = testRule()) {
  const students = await liveIds(rows.map((r) => r.studentId), rule);
  const brands = await liveIds(rows.map((r) => r.brand).filter(isId), rule);
  return rows.filter((r) => students.has(r.studentId) && (r.brand === "deleted" || brands.has(r.brand)));
}

/**
 * The sales from the database. brandIds: only these brands (null = all); from / to: Dates (null = all time);
 * includeArchived: deleted brands' redemptions too; populate: student name / roll no / university (brand pages).
 */
async function salesRows({ brandIds = null, from = null, to = null, includeArchived = false, populate = false, rule = testRule() } = {}) {
  const brandQ = brandIds ? { brand: { $in: brandIds } } : {};
  const promoQ = { ...brandQ, status: "used", ...(from || to ? { $or: [{ usedAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } }, { usedAt: null }] } : {}) };
  let promos = await PromoCode.find(promoQ).populate("offer", "title image").lean();
  // offers with a redemption in the range, or one pointing to a promo above (so it isn't counted twice)
  const offerQ = from || to
    ? { ...brandQ, $or: [{ "redemptions.redeemedAt": { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } }, { "redemptions.promoCodeId": { $in: promos.map((p) => p._id) } }] }
    : brandQ;
  let q = Offer.find(offerQ).select("brand title image discountPercentage redemptions");
  if (populate) q = q.populate({ path: "redemptions.student", select: "name rollNo university email phone", populate: { path: "university", select: "name" } });
  const offers = await q.lean();
  if (populate) {
    const User = require("../models/User");
    const ids = promos.map((p) => p.student).filter(Boolean);
    const users = new Map((await User.find({ _id: { $in: ids } }).select("name rollNo university email phone").populate("university", "name").lean()).map((u) => [s(u._id), u]));
    promos = promos.map((p) => ({ ...p, student: users.get(s(p.student)) || p.student }));
  }
  const archived = includeArchived ? await RedemptionArchive.find({ kind: "redemption", ...(from || to ? { redeemedAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}) }).lean() : [];
  return keepReal(rowsFrom(offers, promos, archived, { from, to }), rule);
}

module.exports = { rowsFrom, figures, keepReal, salesRows };
