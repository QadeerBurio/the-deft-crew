// routes/loyalty.routes.js — /api/loyalty (services/loyalty.js). Behind FLAG_LOYALTY_V2.
// Replies: { success: true, data, requestId } or { success: false, error: { code, message }, requestId }.
//
//   GET   /brands/:brandId/program   the brand's active program (public view)
//   GET   /brands/:brandId/me        student: my visits, tier, next tier, terms
//   GET   /me/credits                student: my loyalty ledger (which redemptions counted as visits)
//   GET   /brands/me/analytics       brand: verified visits, repeat customers, tier counts
//   GET   /programs/mine             brand: my program (any status)
//   POST  /programs                  brand: create my program (own brand only; draft unless status given)
//   PATCH /programs/:id              brand: edit my program; admin: any program (and adminMaxDiscountPct)
//   POST  /programs/:id/restart      brand (own) or admin: an ended program becomes a draft at a new version;
//                                    visits from the ended period never count again
//   POST  /quotes                    brand: what this student's visit gets (tier, %), before confirming
//   GET   /admin/ledger              admin: credits and reversals (exceptions view)
//   POST  /admin/reverse             admin: reverse a credit (refund / void / fraud); reason required
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const Offer = require("../models/Offer");
const LoyaltyProgram = require("../models/LoyaltyProgram");
const LoyaltyLedger = require("../models/LoyaltyLedger");
const { isEnabled } = require("../config/featureFlags");
const loyalty = require("../services/loyalty");

const router = express.Router();
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

const ok = (req, res, data, status = 200) => res.status(status).json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message) => res.status(status).json({ success: false, error: { code, message }, requestId: req.id || null });
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof loyalty.LoyaltyError) return fail(req, res, err.status, err.code, err.message);
    console.error("[loyalty]", err);
    return fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};

// the signed-in user's role, from the database (never from the token alone)
async function me(req) {
  if (req.isGuest || !isId(req.userId)) return null;
  return User.findById(req.userId).select("role").lean();
}
const role = (...roles) => async (req, res, next) => {
  const u = await me(req);
  if (!u) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  if (!roles.includes(u.role)) return fail(req, res, 403, "FORBIDDEN", "Not allowed for your account");
  req.loyaltyRole = u.role;
  next();
};
const flagOn = (id, r) => isEnabled("loyaltyV2", { id: String(id), role: r });

// ---------- student / public ----------
router.get("/brands/me/analytics", auth, role("brand"), handle(async (req, res) => {
  if (!flagOn(req.userId, "brand")) return fail(req, res, 404, "LOYALTY_OFF", "Loyalty is not available for your brand yet");
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) return fail(req, res, 400, "INVALID_DATE", "from / to must be dates");
  ok(req, res, await loyalty.analytics(req.userId, { from, to }));
}));

router.get("/brands/:brandId/program", auth, handle(async (req, res) => {
  const { brandId } = req.params;
  if (!isId(brandId) || !flagOn(brandId, "brand")) return fail(req, res, 404, "NO_PROGRAM", "This brand has no loyalty program");
  const p = await loyalty.activeProgram(brandId);
  if (!p) return fail(req, res, 404, "NO_PROGRAM", "This brand has no loyalty program");
  ok(req, res, loyalty.publicProgram(p));
}));

router.get("/brands/:brandId/me", auth, role("student"), handle(async (req, res) => {
  if (!isId(req.params.brandId)) return fail(req, res, 400, "INVALID_ID", "Invalid brand id");
  ok(req, res, await loyalty.standing(req.params.brandId, req.userId));
}));

router.get("/me/credits", auth, role("student"), handle(async (req, res) => {
  if (!flagOn(req.userId, "student")) return ok(req, res, { enabled: false, credits: [] });
  const rows = await LoyaltyLedger.find({ student: req.userId }).sort({ effectiveAt: -1 }).limit(200).lean();
  const reversed = new Set(rows.filter((r) => r.type === "REVERSAL").map((r) => String(r.reverses)));
  const credits = rows
    .filter((r) => r.type === "CREDIT")
    .map((r) => ({
      redemptionId: String(r.redemptionId),
      brand: String(r.brand),
      offer: r.offer ? String(r.offer) : null,
      // credited: counted as a visit; not-counted: e.g. the daily limit; reversed: refund / correction
      status: r.visitsDelta > 0 ? (reversed.has(String(r._id)) ? "reversed" : "credited") : "not-counted",
      visitNumber: r.visitNumber,
      tierName: r.tierName,
      discountPct: r.discountPct,
      at: r.effectiveAt,
    }));
  ok(req, res, { enabled: true, credits });
}));

// ---------- brand ----------
router.get("/programs/mine", auth, role("brand"), handle(async (req, res) => {
  if (!flagOn(req.userId, "brand")) return fail(req, res, 404, "LOYALTY_OFF", "Loyalty is not available for your brand yet");
  const p = await LoyaltyProgram.findOne({ brand: req.userId }).lean();
  ok(req, res, p ? { ...loyalty.publicProgram(p), brandMaxDiscountPct: p.maxDiscountPct, adminMaxDiscountPct: p.adminMaxDiscountPct } : null);
}));

router.post("/programs", auth, role("brand"), handle(async (req, res) => {
  if (!flagOn(req.userId, "brand")) return fail(req, res, 404, "LOYALTY_OFF", "Loyalty is not available for your brand yet");
  const body = { ...(req.body || {}) };
  delete body.brand; // always the signed-in brand
  delete body.brandId;
  const p = await loyalty.createProgram(req.userId, body, req.userId);
  ok(req, res, loyalty.publicProgram(p), 201);
}));

router.patch("/programs/:id", auth, role("brand", "admin"), handle(async (req, res) => {
  if (!isId(req.params.id)) return fail(req, res, 400, "INVALID_ID", "Invalid program id");
  const p = await LoyaltyProgram.findById(req.params.id).lean();
  if (!p) return fail(req, res, 404, "NOT_FOUND", "Program not found");
  const isAdmin = req.loyaltyRole === "admin";
  if (!isAdmin && String(p.brand) !== String(req.userId)) return fail(req, res, 403, "NOT_YOUR_PROGRAM", "This program belongs to another brand");
  if (!isAdmin && !flagOn(req.userId, "brand")) return fail(req, res, 404, "LOYALTY_OFF", "Loyalty is not available for your brand yet");
  const body = { ...(req.body || {}) };
  delete body.brand;
  const updated = await loyalty.updateProgram(p, body, req.userId, isAdmin);
  ok(req, res, { ...loyalty.publicProgram(updated), brandMaxDiscountPct: updated.maxDiscountPct, adminMaxDiscountPct: updated.adminMaxDiscountPct });
}));

router.post("/programs/:id/restart", auth, role("brand", "admin"), handle(async (req, res) => {
  if (!isId(req.params.id)) return fail(req, res, 400, "INVALID_ID", "Invalid program id");
  const p = await LoyaltyProgram.findById(req.params.id).lean();
  if (!p) return fail(req, res, 404, "NOT_FOUND", "Program not found");
  const isAdmin = req.loyaltyRole === "admin";
  if (!isAdmin && String(p.brand) !== String(req.userId)) return fail(req, res, 403, "NOT_YOUR_PROGRAM", "This program belongs to another brand");
  if (!isAdmin && !flagOn(req.userId, "brand")) return fail(req, res, 404, "LOYALTY_OFF", "Loyalty is not available for your brand yet");
  const updated = await loyalty.restartProgram(p, req.body || {}, req.userId, isAdmin);
  ok(req, res, { ...loyalty.publicProgram(updated), brandMaxDiscountPct: updated.maxDiscountPct, adminMaxDiscountPct: updated.adminMaxDiscountPct });
}));

// the brand's own offer only; the student and offer come from the database
router.post("/quotes", auth, role("brand"), handle(async (req, res) => {
  const { studentId, offerId, branchId } = req.body || {};
  if (!isId(studentId) || !isId(offerId)) return fail(req, res, 400, "INVALID_ID", "studentId and offerId are required");
  const offer = await Offer.findById(offerId).select("brand discountPercentage status").lean();
  if (!offer) return fail(req, res, 404, "NOT_FOUND", "Offer not found");
  if (String(offer.brand) !== String(req.userId)) return fail(req, res, 403, "NOT_YOUR_OFFER", "This offer belongs to another brand");
  const q = await loyalty.quoteFor({ brandId: req.userId, studentId, offerId, branchId });
  // discountPercentage: what to apply now (the loyalty % when loyalty applies, else the offer's)
  ok(req, res, { ...q, discountPercentage: q.applies ? q.discountPct : Number(offer.discountPercentage) || 0 });
}));

// ---------- admin ----------
router.get("/admin/ledger", auth, role("admin"), handle(async (req, res) => {
  const q = {};
  if (req.query.brandId) { if (!isId(req.query.brandId)) return fail(req, res, 400, "INVALID_ID", "Invalid brand id"); q.brand = req.query.brandId; }
  if (req.query.studentId) { if (!isId(req.query.studentId)) return fail(req, res, 400, "INVALID_ID", "Invalid student id"); q.student = req.query.studentId; }
  if (["CREDIT", "REVERSAL"].includes(req.query.type)) q.type = req.query.type;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const rows = await LoyaltyLedger.find(q).sort({ effectiveAt: -1 }).limit(limit).lean();
  const reversedIds = new Set((await LoyaltyLedger.find({ type: "REVERSAL", reverses: { $in: rows.map((r) => r._id) } }).select("reverses").lean()).map((r) => String(r.reverses)));
  const userIds = [...new Set(rows.flatMap((r) => [String(r.brand), String(r.student), r.actor ? String(r.actor) : null]).filter(Boolean))];
  const users = new Map((await User.find({ _id: { $in: userIds } }).select("name brandName").lean()).map((u) => [String(u._id), u.brandName || u.name || ""]));
  ok(req, res, {
    rows: rows.map((r) => ({
      id: String(r._id),
      type: r.type,
      visitsDelta: r.visitsDelta,
      redemptionId: String(r.redemptionId),
      brand: String(r.brand), brandName: users.get(String(r.brand)) || "",
      student: String(r.student), studentName: users.get(String(r.student)) || "",
      offer: r.offer ? String(r.offer) : null,
      source: r.source, reason: r.reason, visitNumber: r.visitNumber, tierName: r.tierName, discountPct: r.discountPct,
      billAmount: r.billAmount, savedAmount: r.savedAmount,
      reversed: r.type === "CREDIT" && reversedIds.has(String(r._id)),
      actor: r.actor ? String(r.actor) : null, actorName: r.actor ? users.get(String(r.actor)) || "" : "",
      at: r.effectiveAt,
    })),
  });
}));

router.post("/admin/reverse", auth, role("admin"), handle(async (req, res) => {
  const { redemptionId, reason } = req.body || {};
  const out = await loyalty.reverseRedemption({ redemptionId, reason, actor: req.userId });
  ok(req, res, { reversal: { id: String(out.entry._id), visitsDelta: out.entry.visitsDelta, reason: out.entry.reason }, progress: out.progress }, 201);
}));

module.exports = router;
