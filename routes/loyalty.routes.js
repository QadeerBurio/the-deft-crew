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
//   POST  /quotes                    brand: what this student's visit gets (tier, %), before confirming; reward mode:
//                                    stamps and any waiting reward (the visit itself gets the offer's usual %)
//   POST  /rewards/:id/use           brand: apply a student's waiting reward at the till ({ billAmount? });
//                                    once only (Idempotency-Key: a retry gets the same answer)
//   GET   /admin/ledger              admin: credits and reversals (exceptions view)
//   POST  /admin/reverse             admin: reverse a credit (refund / void / fraud); reason required
//   GET   /admin/programs            admin: every brand's program (?status=&q=brand name)
//   GET   /admin/programs/:id        admin: one program: rules, history, restarts, numbers
//   POST  /admin/programs            admin: create a program on a brand's behalf (always a draft); reason required
//   PATCH /admin/programs/:id        admin: edit / publish / pause / end; version + reason required
//   POST  /admin/programs/:id/restart  admin: restart an ended program as a draft; version + reason required
//   Every admin write here is logged in the AdminActionLog, in the same transaction as the change.
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const Offer = require("../models/Offer");
const LoyaltyProgram = require("../models/LoyaltyProgram");
const LoyaltyLedger = require("../models/LoyaltyLedger");
const LoyaltyProgramRestart = require("../models/LoyaltyProgramRestart");
const { withTransaction } = require("../utils/transaction");
const { isEnabled } = require("../config/featureFlags");
const loyalty = require("../services/loyalty");
const adminLog = require("../services/adminActionLog");

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
  if (isAdmin) {
    const changed = Object.keys(body).filter((k) => k !== "version" && k !== "reason");
    await adminLog.recordSafe({ adminId: req.userId, action: "loyalty.program.update", targetType: "LoyaltyProgram", targetId: String(p._id), before: adminLog.pick(p, changed), after: adminLog.pick(updated, changed), reason: body.reason, requestId: req.id });
  }
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
  if (isAdmin) await adminLog.recordSafe({ adminId: req.userId, action: "loyalty.program.restart", targetType: "LoyaltyProgram", targetId: String(p._id), before: { status: p.status, version: p.version }, after: { status: updated.status, version: updated.version }, reason: req.body?.reason, requestId: req.id });
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

// ---------- reward mode: the brand applies a waiting reward ----------
router.post("/rewards/:id/use", auth, role("brand"), handle(async (req, res) => {
  if (!flagOn(req.userId, "brand")) return fail(req, res, 404, "LOYALTY_OFF", "Loyalty is not available for your brand yet");
  const key = (req.get("Idempotency-Key") || req.body?.idempotencyKey || "").trim() || null;
  const out = await loyalty.useReward({ rewardId: req.params.id, brandId: req.userId, actor: req.userId, billAmount: req.body?.billAmount, useKey: key });
  const r = out.reward;
  ok(req, res, { id: String(r._id), status: r.status, label: r.label, kind: r.kind, usedAt: r.usedAt, billAmount: r.billAmount, savedAmount: r.savedAmount, duplicate: out.duplicate }, out.duplicate ? 200 : 201);
}));

router.post("/admin/reverse", auth, role("admin"), handle(async (req, res) => {
  const { redemptionId, reason } = req.body || {};
  const out = await loyalty.reverseRedemption({ redemptionId, reason, actor: req.userId });
  await adminLog.recordSafe({ adminId: req.userId, action: "loyalty.visit.reverse", targetType: "LoyaltyLedger", targetId: String(out.entry.reverses), before: { counted: true }, after: { counted: false, reversalId: String(out.entry._id), visitsDelta: out.entry.visitsDelta }, reason, requestId: req.id });
  ok(req, res, { reversal: { id: String(out.entry._id), visitsDelta: out.entry.visitsDelta, reason: out.entry.reason }, progress: out.progress }, 201);
}));

// ---------- admin: every brand's program ----------
const RULE_KEYS = ["status", "tiers", "eligibleOfferIds", "branchIds", "maxDiscountPct", "adminMaxDiscountPct", "maxVisitsPerDay", "resetMonths", "terms", "startsAt", "endsAt"];
const reasonOf = (req) => {
  const r = String(req.body?.reason || "").trim();
  if (r.length < 5) throw new loyalty.LoyaltyError(400, "REASON_REQUIRED", "Give a reason (at least 5 characters)");
  return r.slice(0, 500);
};
const versionOf = (req) => {
  if (req.body?.version == null) throw new loyalty.LoyaltyError(400, "VERSION_REQUIRED", "Send the version you edited");
  return Number(req.body.version);
};
// the change and its AdminActionLog row together (one transaction where the database supports it)
async function logged(req, reason, work, entry) {
  const { result } = await withTransaction(async (session) => {
    const out = await work(session);
    await adminLog.record({ adminId: req.userId, reason, requestId: req.id, ...entry(out) }, { session });
    return out;
  });
  return result;
}
const brandNames = async (ids) => new Map((await User.find({ _id: { $in: [...new Set(ids.map(String))] }, role: "brand" }).select("brandName name").lean()).map((u) => [String(u._id), u.brandName || u.name || "brand"]));
const adminProgramView = (p, names) => ({
  ...loyalty.publicProgram(p),
  brandName: names.get(String(p.brand)) || "brand",
  inPilot: flagOn(p.brand, "brand"),
  brandMaxDiscountPct: p.maxDiscountPct,
  adminMaxDiscountPct: p.adminMaxDiscountPct ?? null,
  createdAt: p.createdAt, updatedAt: p.updatedAt,
});
const loadProgram = async (req, res) => {
  if (!isId(req.params.id)) { fail(req, res, 400, "INVALID_ID", "Invalid program id"); return null; }
  const p = await LoyaltyProgram.findById(req.params.id).lean();
  if (!p) { fail(req, res, 404, "NOT_FOUND", "Program not found"); return null; }
  return p;
};
const ACTION_FOR_STATUS = { active: "loyalty.program.publish", paused: "loyalty.program.pause", ended: "loyalty.program.end" };

router.get("/admin/programs", auth, role("admin"), handle(async (req, res) => {
  const filter = {};
  if (req.query.status && ["draft", "active", "paused", "ended"].includes(String(req.query.status))) filter.status = String(req.query.status);
  const list = await LoyaltyProgram.find(filter).sort({ updatedAt: -1 }).limit(500).lean();
  const names = await brandNames(list.map((p) => p.brand));
  const q = String(req.query.q || "").trim().toLowerCase().slice(0, 80);
  const rows = list.map((p) => adminProgramView(p, names)).filter((p) => !q || p.brandName.toLowerCase().includes(q));
  ok(req, res, { programs: rows });
}));

router.get("/admin/programs/:id", auth, role("admin"), handle(async (req, res) => {
  const p = await loadProgram(req, res);
  if (!p) return;
  const [names, restarts, numbers] = await Promise.all([
    brandNames([p.brand]),
    LoyaltyProgramRestart.find({ program: p._id }).sort({ endedVersion: -1 }).lean(),
    loyalty.analytics(p.brand),
  ]);
  ok(req, res, {
    program: adminProgramView(p, names),
    history: (p.history || []).slice().reverse().map((h) => ({ version: h.version, status: h.status, tiers: h.tiers, maxDiscountPct: h.maxDiscountPct, adminMaxDiscountPct: h.adminMaxDiscountPct ?? null, startsAt: h.startsAt || null, endsAt: h.endsAt || null, changedAt: h.changedAt, restarted: !!h.restarted })),
    restarts: restarts.map((r) => ({ endedVersion: r.endedVersion, newVersion: r.newVersion, restartedAt: r.restartedAt, byAdmin: !!r.byAdmin })),
    numbers: { verifiedVisits: numbers.verifiedVisits || 0, members: numbers.members || 0, repeatCustomers: numbers.repeatCustomers || 0, reversals: numbers.reversals || 0, tierCounts: numbers.tierCounts || {} },
  });
}));

router.post("/admin/programs", auth, role("admin"), handle(async (req, res) => {
  const reason = reasonOf(req);
  const { brandId } = req.body || {};
  const brand = isId(brandId) ? await User.findOne({ _id: brandId, role: "brand" }).select("_id").lean() : null;
  if (!brand) return fail(req, res, 404, "BRAND_NOT_FOUND", "Brand not found");
  const body = { ...(req.body || {}) };
  for (const k of ["brandId", "brand", "reason", "status", "version"]) delete body[k]; // always a draft: the brand or an admin publishes
  const p = await logged(req, reason,
    (session) => loyalty.createProgram(brand._id, body, req.userId, { session, isAdmin: true }),
    (out) => ({ action: "loyalty.program.create", targetType: "LoyaltyProgram", targetId: String(out._id), before: null, after: adminLog.pick(out, RULE_KEYS) }));
  ok(req, res, adminProgramView(p, await brandNames([p.brand])), 201);
}));

router.patch("/admin/programs/:id", auth, role("admin"), handle(async (req, res) => {
  const p = await loadProgram(req, res);
  if (!p) return;
  const reason = reasonOf(req);
  const version = versionOf(req);
  const body = { ...(req.body || {}), version };
  for (const k of ["brand", "brandId", "reason"]) delete body[k];
  const changed = Object.keys(body).filter((k) => RULE_KEYS.includes(k));
  if (!changed.length) return fail(req, res, 400, "NOTHING_TO_CHANGE", "Nothing to change");
  const updated = await logged(req, reason,
    (session) => loyalty.updateProgram(p, body, req.userId, true, { session }),
    (out) => ({ action: changed.length === 1 && changed[0] === "status" && ACTION_FOR_STATUS[out.status] ? ACTION_FOR_STATUS[out.status] : "loyalty.program.update", targetType: "LoyaltyProgram", targetId: String(p._id), before: { ...adminLog.pick(p, changed), version: p.version }, after: { ...adminLog.pick(out, changed), version: out.version } }));
  ok(req, res, adminProgramView(updated, await brandNames([updated.brand])));
}));

router.post("/admin/programs/:id/restart", auth, role("admin"), handle(async (req, res) => {
  const p = await loadProgram(req, res);
  if (!p) return;
  const reason = reasonOf(req);
  const version = versionOf(req);
  const updated = await logged(req, reason,
    (session) => loyalty.restartProgram(p, { version }, req.userId, true, { session }),
    (out) => ({ action: "loyalty.program.restart", targetType: "LoyaltyProgram", targetId: String(p._id), before: { status: p.status, version: p.version }, after: { status: out.status, version: out.version } }));
  ok(req, res, adminProgramView(updated, await brandNames([updated.brand])));
}));

module.exports = router;
