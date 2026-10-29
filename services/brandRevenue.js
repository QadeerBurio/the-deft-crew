// services/brandRevenue.js
// The per-brand revenue figures behind /api/offers/admin/brands-revenue. Shared with the account
// deletion service, which stores a deleted brand's figures (RedemptionArchive "brand-totals") so the
// grand totals stay exactly as they were.
//   offers: the brand's offers (lean), redemptions with student as an id (not populated)
//   promos: the brand's used promo codes (lean)

function brandFigures(offers = [], promos = []) {
  let qrRevenue = 0;
  let qrBill = 0;
  let qrSaved = 0;
  let qrCount = 0;
  const uniqueQrStudents = new Set();

  offers.forEach((offer) => {
    (offer.redemptions || []).forEach((r) => {
      const bill = r.billAmount || 0;
      const saved = r.savedAmount || 0;
      qrBill += bill;
      qrSaved += saved;
      qrRevenue += bill - saved;
      qrCount += 1;
      // raw id: a deleted student's redemptions carry a placeholder id and still count
      const sid = r.student?._id || r.student;
      if (sid) uniqueQrStudents.add(sid.toString());
    });
  });

  let promoRevenue = 0;
  let promoBill = 0;
  let promoCount = 0;
  const uniquePromoStudents = new Set();

  promos.forEach((pc) => {
    const bill = pc.externalAmount || 0;
    const saved = Math.round((bill * (pc.discountPercentage || 0)) / 100);
    promoBill += bill;
    promoRevenue += bill - saved;
    promoCount += 1;
    if (pc.student) uniquePromoStudents.add(pc.student.toString());
  });

  const promoSaved = Math.round((promoBill * (promos[0]?.discountPercentage || 0)) / 100);

  let topOffer = "—";
  let topCount = 0;
  offers.forEach((offer) => {
    const count = (offer.redemptions || []).length;
    if (count > topCount) {
      topCount = count;
      topOffer = offer.title || "Offer";
    }
  });

  return {
    totalRevenue: qrRevenue + promoRevenue,
    totalBill: qrBill + promoBill,
    totalSaved: qrSaved + promoSaved,
    totalRedemptions: qrCount + promoCount,
    uniqueStudents: new Set([...uniqueQrStudents, ...uniquePromoStudents]).size,

    qrRevenue,
    qrBill,
    qrSaved,
    qrCount,

    promoRevenue,
    promoBill,
    promoCount,

    topOffer,
    topOfferCount: topCount,
    offersCount: offers.length,
  };
}

// the numbers a RedemptionArchive "brand-totals" row keeps (no offer title)
const TOTAL_KEYS = ["totalRevenue", "totalBill", "totalSaved", "totalRedemptions", "uniqueStudents", "qrRevenue", "qrBill", "qrSaved", "qrCount", "promoRevenue", "promoBill", "promoCount", "offersCount"];
const totalsOnly = (f) => Object.fromEntries(TOTAL_KEYS.map((k) => [k, f[k] || 0]));

module.exports = { brandFigures, totalsOnly, TOTAL_KEYS };
