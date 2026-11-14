// routes/surplus.routes.js — /api/surplus (services/surplus/). Surprise Box: merchant surplus food, pickup
// only, pay at pickup (tdc never takes money). Behind FLAG_SURPLUS_BOXES: off for the caller = 404, and a
// brand's listings show only while the flag is on for that brand.
// Replies: { success: true, data, requestId } or { success: false, error: { code, message, ... }, requestId }.
//
// Student:
//   GET    /listings                     boxes to pick up (?lat&lng for distance; ?scope=city: the student's own
//                                         city from their profile; ?city=<name>; neither: every city, as before)
//   GET    /listings/:id                 one box with every disclosure
//   POST   /holds                        { listingId, qty, idempotencyKey } -> held for 10 minutes
//   DELETE /holds/:id                    release a hold
//   POST   /orders                       { holdId, idempotencyKey, acceptedTerms: true }
//   GET    /orders/me                    my orders
//   GET    /orders/:id                   one of my orders, with the pickup code + QR while it's awaiting pickup
//   POST   /orders/:id/cancel            until 30 minutes before pickup starts
//   POST   /support-cases                { orderId, reason, description, evidence[] } within 24 hours of pickup
//   GET    /support-cases/me
// Brand (own listings / orders only; branch checked on every write):
//   GET    /merchant/listings            POST /merchant/listings      PATCH /merchant/listings/:id
//   POST   /merchant/listings/:id/image  multipart "image" + "version": the box's photo (images only, 5 MB; locked once ordered)
//   DELETE /merchant/listings/:id/image  { version }: remove the photo
//   POST   /merchant/listings/:id/cancel { reason, version }: cancel the box: closed (no new orders), and every open
//                                         order not yet handed over cancelled with the reason (the student is told);
//                                         handed-over orders stay. Same as the admin cancel, for the brand's own box.
//   GET    /merchant/orders              ?scope=live|today|all
//   POST   /merchant/orders/:id/transition      { to, version, reason?, markPaid? }
//   POST   /merchant/orders/:id/verify-pickup   { code | qr, branchId, markPaid }  (also /merchant/verify-pickup)
//   GET    /merchant/summary             today's numbers
// Admin:
//   GET /admin/orders   GET /admin/no-shows   GET /admin/cases   POST /admin/cases/:id/decide
//   GET /admin/brands   POST /admin/brands/:brandId/block   { blocked, reason }
const express = require("express");
const { roleOf } = require("../utils/userRole");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const Branch = require("../models/Branch");
const SurplusListing = require("../models/SurplusListing");
const SurplusOrder = require("../models/SurplusOrder");
const SurplusSupportCase = require("../models/SurplusSupportCase");
const SurplusBrandBlock = require("../models/SurplusBrandBlock");
const { isEnabled } = require("../config/featureFlags");
const policy = require("../services/surplus/policy");
const inventory = require("../services/surplus/inventory");
const orders = require("../services/surplus/orders");
const adminLog = require("../services/adminActionLog");
const nodePath = require("path");
const { uploadOffer, deleteFromCloudinary } = require("../config/cloudinary");
const cases = require("../services/surplus/cases");
const announcements = require("../services/surplus/announcements");
// "a new box near you": only on a box's first publish (publishedAt from empty to set); never fails the request
const announceIfFirstPublish = (before, after) => { if (!before?.publishedAt && after?.publishedAt && after.status === "published") announcements.onPublished(after); };
const { SurplusError } = inventory;

// the pilot is configured but the pickup-code secret isn't: say so at startup (holds and orders are refused).
// Checked here (the Railway value) and again once admin access has loaded (server.js), logged at most once a minute.
const warnIfNoPickupSecret = (where = "startup") => {
  if (require("../config/featureFlags").pilotConfigured("surplusBoxes") && !require("../services/surplus/pickupCode").configured()) {
    require("../services/surplus/pickupCode").logNotConfigured(where);
  }
};
warnIfNoPickupSecret();

const router = express.Router();
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const same = (a, b) => String(a) === String(b);

const ok = (req, res, data, status = 200) => res.status(status).json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: { code, message, ...extra }, requestId: req.id || null });
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof SurplusError) {
      const { status, code, message, ...extra } = err;
      return fail(req, res, status, code, message, extra);
    }
    console.error("[surplus]", err?.message);
    return fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};

// signed in, the flag on for this user, the role from the database (never from the token alone)
// set up = the Railway value, or any admin access (config/featureFlags.js pilotConfigured)
const pilotConfigured = () => require("../config/featureFlags").pilotConfigured("surplusBoxes");
const gate = (role) => async (req, res, next) => {
  if (req.isGuest || !isId(req.userId)) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const u = await User.findById(req.userId).select("role brandApprovalStatus name").lean();
  if (!u) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const r = roleOf(u); // a missing role is a student
  const on = role === "admin" ? pilotConfigured() : isEnabled("surplusBoxes", { id: String(req.userId), role: r });
  if (!on) return fail(req, res, 404, "SURPLUS_OFF", "Surprise Boxes aren't available for your account yet");
  if (r !== role) return fail(req, res, 403, "FORBIDDEN", "Not allowed for your account");
  if (role === "brand" && u.brandApprovalStatus && u.brandApprovalStatus !== "approved") return fail(req, res, 403, "BRAND_NOT_APPROVED", "Your brand isn't approved yet");
  req.surplusUser = u;
  next();
};
const student = [auth, gate("student")];
const brand = [auth, gate("brand")];
const admin = [auth, gate("admin")];

// ---------- views ----------
const km = (a, b) => {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
};
const brandsById = async (ids) => new Map((await User.find({ _id: { $in: [...new Set(ids.map(String))] } }).select("brandName companyName name logo").lean()).map((b) => [String(b._id), { id: String(b._id), name: b.brandName || b.companyName || b.name || "brand", logo: b.logo || "" }]));
function listingView(l, brandInfo, here = null, full = false) {
  const coords = l.location?.geo?.coordinates;
  const v = {
    id: String(l._id), title: l.title, brand: brandInfo || { id: String(l.brand), name: "brand", logo: "" },
    branch: { id: String(l.branch), name: l.location?.branchName || "", city: l.location?.city || "", address: l.location?.address || "" },
    price: l.price, listPrice: l.listPrice, currency: l.currency || "PKR",
    quantityLeft: Math.max(0, l.quantityAvailable), quantityTotal: l.quantityTotal,
    pickupStart: l.pickupStart, pickupEnd: l.pickupEnd, orderCutoff: l.orderCutoff,
    contentsMayVary: l.contentsMayVary !== false, allergens: l.allergens || [], dietary: l.dietary || [],
    image: l.image?.url || null, // optional photo; null = no photo
    available: l.status === "published" && l.quantityAvailable > 0,
    status: l.status === "published" && l.quantityAvailable <= 0 ? "sold_out" : l.status,
    distanceKm: here && Array.isArray(coords) && coords.length === 2 ? km(here, coords) : null,
    maxPerOrder: policy.MAX_PER_LISTING,
  };
  if (full) v.disclosures = { ...policy.disclosuresOf(l), branchName: v.branch.name, address: v.branch.address, city: v.branch.city };
  return v;
}
const historyView = (h = []) => h.map((x) => ({ from: x.from, to: x.to, byRole: x.byRole, at: x.at, note: x.byRole === "brand" || x.byRole === "system" ? x.note || "" : "" }));
function studentOrderView(o, extra = {}, now = new Date()) {
  const disputeUntil = cases.DISPUTABLE.includes(o.state) ? new Date(cases.disputeFrom(o).getTime() + policy.DISPUTE_HOURS * 3600e3) : null;
  return {
    id: String(o._id), ref: o.ref, state: o.state, qty: o.qty, price: o.priceSnapshot,
    payment: { mode: o.paymentMode, state: o.paymentState, note: `Pay ${o.priceSnapshot.currency} ${o.priceSnapshot.total} at pickup` },
    listingId: String(o.listing), brandId: String(o.brand), title: o.disclosures?.title || "", pickupStart: o.pickupStart, pickupEnd: o.pickupEnd,
    branch: { name: o.disclosures?.branchName || "", address: o.disclosures?.address || "", city: o.disclosures?.city || "" },
    disclosures: o.disclosures, history: historyView(o.history), version: o.version, cancelReason: o.cancelReason || "",
    canCancel: policy.studentCanCancel(o, now), cancelUntil: policy.cancelUntil(o.pickupStart),
    canDispute: !!disputeUntil && now <= disputeUntil, disputeUntil,
    createdAt: o.createdAt, ...extra,
  };
}
const firstName = (n) => String(n || "student").trim().split(/\s+/)[0];
function merchantOrderView(o, studentName) {
  return {
    id: String(o._id), ref: o.ref, state: o.state, qty: o.qty, total: o.priceSnapshot.total, currency: o.priceSnapshot.currency,
    paymentState: o.paymentState, student: { firstName: firstName(studentName) }, title: o.disclosures?.title || "",
    listingId: String(o.listing), branchId: String(o.branch), branchName: o.disclosures?.branchName || "",
    pickupStart: o.pickupStart, pickupEnd: o.pickupEnd, version: o.version, next: policy.merchantNext(o.state),
    cancelReason: o.cancelReason || "", history: historyView(o.history), codeUsedAt: o.pickupCodeUsedAt || null, createdAt: o.createdAt,
  };
}
const namesOf = async (ids) => new Map((await User.find({ _id: { $in: [...new Set(ids.map(String))] } }).select("name").lean()).map((u) => [String(u._id), u.name]));

// ---------- student ----------
// a city as people type it ("Karachi", " karachi ", "Karachi, Pakistan" are the same): services/surplus/city.js
const { cityName, cityFilter } = require("../services/surplus/city");
router.get("/listings", ...student, handle(async (req, res) => {
  const now = new Date();
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const here = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lng, lat] : null;
  const filter = { status: { $in: ["published", "sold_out"] }, pickupEnd: { $gt: now } };
  // which city: ?city=<name>, or ?scope=city for the student's own (profile location); no city known: every city
  let city = "";
  if (req.query.city) city = cityName(req.query.city);
  else if (req.query.scope === "city") city = cityName((await User.findById(req.userId).select("location").lean())?.location);
  if (city) filter["location.city"] = cityFilter(city);
  let list = await SurplusListing.find(filter).sort({ pickupStart: 1 }).limit(200).lean();
  const blocked = new Set((await SurplusBrandBlock.find({ active: true }).select("brand").lean()).map((b) => String(b.brand)));
  list = list.filter((l) => !blocked.has(String(l.brand)) && inventory.flagOn(l.brand));
  const brands = await brandsById(list.map((l) => l.brand));
  let out = list.map((l) => listingView(l, brands.get(String(l.brand)), here));
  if (here) out = out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  ok(req, res, { listings: out.slice(0, 100), city: city || null, scope: city ? "city" : "all", policy: { holdMinutes: policy.HOLD_MINUTES, maxPerListing: policy.MAX_PER_LISTING, payment: "pay_at_pickup" } });
}));

router.get("/listings/:id", ...student, handle(async (req, res) => {
  const l = isId(req.params.id) ? await SurplusListing.findById(req.params.id).lean() : null;
  if (!l || !["published", "sold_out", "closed"].includes(l.status) || !inventory.flagOn(l.brand) || (await inventory.brandBlocked(l.brand))) return fail(req, res, 404, "NOT_FOUND", "This Surprise Box isn't available");
  const brands = await brandsById([l.brand]);
  ok(req, res, listingView(l, brands.get(String(l.brand)), null, true));
}));

const holdView = (h) => ({ id: String(h._id), listingId: String(h.listing), qty: h.qty, state: h.state, expiresAt: h.expiresAt, orderId: h.order ? String(h.order) : null });
router.post("/holds", ...student, handle(async (req, res) => {
  const { listingId, qty, idempotencyKey } = req.body || {};
  if (!isId(listingId)) return fail(req, res, 400, "INVALID_LISTING", "Choose a Surprise Box");
  const { hold, created } = await inventory.createHold({ studentId: req.userId, listingId, qty, idempotencyKey });
  const l = await SurplusListing.findById(hold.listing).lean();
  ok(req, res, { hold: holdView(hold), disclosures: l ? { ...policy.disclosuresOf(l), branchName: l.location?.branchName || "", address: l.location?.address || "" } : null, total: l ? l.price * hold.qty : null }, created ? 201 : 200);
}));

router.delete("/holds/:id", ...student, handle(async (req, res) => {
  if (!isId(req.params.id)) return fail(req, res, 404, "NOT_FOUND", "Hold not found");
  ok(req, res, holdView(await inventory.releaseHold(req.userId, req.params.id)));
}));

router.post("/orders", ...student, handle(async (req, res) => {
  const { holdId, idempotencyKey, acceptedTerms } = req.body || {};
  const { order, created } = await orders.placeOrder({ studentId: req.userId, holdId, idempotencyKey, acceptedTerms });
  ok(req, res, studentOrderView(order, { pickup: orders.pickupFor(order) }), created ? 201 : 200);
}));

router.get("/orders/me", ...student, handle(async (req, res) => {
  const list = await SurplusOrder.find({ student: req.userId }).sort({ createdAt: -1 }).limit(100).lean();
  const brands = await brandsById(list.map((o) => o.brand));
  ok(req, res, list.map((o) => studentOrderView(o, { brand: brands.get(String(o.brand)) || null })));
}));

router.get("/orders/:id", ...student, handle(async (req, res) => {
  const o = isId(req.params.id) ? await SurplusOrder.findOne({ _id: req.params.id, student: req.userId }).lean() : null;
  if (!o) return fail(req, res, 404, "NOT_FOUND", "Order not found");
  const [brands, supportCase] = await Promise.all([brandsById([o.brand]), SurplusSupportCase.findOne({ order: o._id }).select("status decision reason createdAt decidedAt adminNote").lean()]);
  ok(req, res, studentOrderView(o, { brand: brands.get(String(o.brand)) || null, pickup: orders.pickupFor(o), supportCase: supportCase ? { status: supportCase.status, decision: supportCase.decision, reason: supportCase.reason, openedAt: supportCase.createdAt, decidedAt: supportCase.decidedAt, note: supportCase.adminNote || "" } : null }));
}));

router.post("/orders/:id/cancel", ...student, handle(async (req, res) => {
  const o = await orders.cancelByStudent(req.userId, req.params.id, { version: req.body?.version ?? null });
  ok(req, res, studentOrderView(o));
}));

const caseView = (c) => ({ id: String(c._id), orderId: String(c.order), reason: c.reason, description: c.description, evidence: c.evidence, status: c.status, decision: c.decision, note: c.status === "decided" ? c.adminNote : "", createdAt: c.createdAt, decidedAt: c.decidedAt });
router.post("/support-cases", ...student, handle(async (req, res) => {
  const { orderId, reason, description, evidence } = req.body || {};
  ok(req, res, caseView(await cases.openCase(req.userId, { orderId, reason, description, evidence })), 201);
}));
router.get("/support-cases/me", ...student, handle(async (req, res) => {
  ok(req, res, (await SurplusSupportCase.find({ student: req.userId }).sort({ createdAt: -1 }).limit(50).lean()).map(caseView));
}));

// ---------- brand ----------
const merchantListingView = (l, counts = {}) => ({ ...listingView(l, null, null, true), version: l.version, status: l.status, orders: counts[String(l._id)] || 0, publishedAt: l.publishedAt, createdAt: l.createdAt });
const DISCLOSURE_FIELDS = ["title", "description", "contentsMayVary", "allergens", "allergenNotes", "dietary", "bestBefore", "price", "listPrice", "pickupStart", "pickupEnd"];
const strList = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 15).map((x) => x.slice(0, 30));
const date = (v) => (v ? new Date(v) : null);
const validDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());

// the listing fields from a body, checked; `existing` for a PATCH
function listingFields(body, existing = null) {
  const b = body || {};
  const out = {};
  const pick = (k) => b[k] !== undefined;
  if (pick("title") || !existing) { const t = String(b.title || "").trim(); if (t.length < 3) throw new SurplusError(400, "TITLE_REQUIRED", "Give the box a title"); out.title = t.slice(0, 80); }
  if (pick("description")) out.description = String(b.description || "").trim().slice(0, 600);
  if (pick("contentsMayVary")) out.contentsMayVary = b.contentsMayVary !== false;
  if (pick("allergens")) out.allergens = strList(b.allergens);
  if (pick("allergenNotes") || !existing) { const n = String(b.allergenNotes || "").trim(); if (n.length < 3) throw new SurplusError(400, "ALLERGENS_REQUIRED", "Write the allergen notes (e.g. \"contains gluten and dairy; may contain nuts\" or \"none known\")"); out.allergenNotes = n.slice(0, 400); }
  if (pick("dietary")) out.dietary = strList(b.dietary);
  for (const k of ["price", "listPrice"]) if (pick(k) || !existing) { const n = Number(b[k]); if (!Number.isFinite(n) || n < 0 || n > 100000) throw new SurplusError(400, "INVALID_PRICE", `${k} must be a number of rupees`); out[k] = Math.round(n); }
  const price = out.price ?? existing?.price, listPrice = out.listPrice ?? existing?.listPrice;
  if (price > listPrice) throw new SurplusError(400, "INVALID_PRICE", "The price can't be more than the usual price");
  for (const k of ["pickupStart", "pickupEnd", "orderCutoff", "bestBefore"]) if (pick(k)) { const d = date(b[k]); if (b[k] && !validDate(d)) throw new SurplusError(400, "INVALID_DATE", `${k} must be a date`); out[k] = d; }
  const start = out.pickupStart ?? existing?.pickupStart, end = out.pickupEnd ?? existing?.pickupEnd;
  if (!start || !end) throw new SurplusError(400, "PICKUP_WINDOW_REQUIRED", "Set the pickup window");
  if (new Date(end) <= new Date(start)) throw new SurplusError(400, "INVALID_WINDOW", "Pickup must end after it starts");
  if (new Date(end) - new Date(start) > 12 * 3600e3) throw new SurplusError(400, "INVALID_WINDOW", "Pickup windows can be up to 12 hours");
  if (!existing && new Date(end) <= new Date()) throw new SurplusError(400, "INVALID_WINDOW", "The pickup window has already ended");
  if (!existing && out.orderCutoff == null) out.orderCutoff = new Date(new Date(end).getTime() - 30 * 60000);
  const cutoff = out.orderCutoff ?? existing?.orderCutoff;
  if (cutoff && new Date(cutoff) > new Date(end)) throw new SurplusError(400, "INVALID_CUTOFF", "Orders must close before pickup ends");
  const best = out.bestBefore !== undefined ? out.bestBefore : existing?.bestBefore;
  if (best && new Date(best) < new Date(end)) throw new SurplusError(400, "UNSAFE_BEST_BEFORE", "The food must still be good at the end of the pickup window");
  return out;
}

router.get("/merchant/listings", ...brand, handle(async (req, res) => {
  const list = await SurplusListing.find({ brand: req.userId }).sort({ pickupStart: -1 }).limit(100).lean();
  const counts = {};
  for (const o of await SurplusOrder.find({ brand: req.userId, listing: { $in: list.map((l) => l._id) } }).select("listing").lean()) counts[String(o.listing)] = (counts[String(o.listing)] || 0) + 1;
  ok(req, res, { listings: list.map((l) => merchantListingView(l, counts)), blocked: !!(await SurplusBrandBlock.exists({ brand: req.userId, active: true })) });
}));

router.post("/merchant/listings", ...brand, handle(async (req, res) => {
  const b = req.body || {};
  const branch = isId(b.branchId) ? await Branch.findOne({ _id: b.branchId, brand: req.userId }).lean() : null;
  if (!branch) return fail(req, res, 403, "WRONG_BRANCH", "Choose one of your branches");
  if (branch.isActive === false) return fail(req, res, 409, "BRANCH_INACTIVE", "This branch is switched off");
  const fields = listingFields(b);
  const qty = Number(b.quantityTotal);
  if (!Number.isInteger(qty) || qty < 1 || qty > 500) return fail(req, res, 400, "INVALID_QTY", "Quantity must be 1 to 500 boxes");
  const publish = b.status === "published";
  if (publish && (await inventory.brandBlocked(req.userId))) return fail(req, res, 403, "BRAND_BLOCKED", "Your Surprise Box listings are paused by tdc. Contact support.");
  const listing = await SurplusListing.create({
    ...fields, brand: req.userId, branch: branch._id, quantityTotal: qty, quantityAvailable: qty,
    status: publish ? "published" : "draft", publishedAt: publish ? new Date() : null,
    location: { city: branch.city || "", address: branch.location || "", branchName: branch.name || "", geo: branch.geo?.coordinates?.length === 2 ? { type: "Point", coordinates: branch.geo.coordinates } : undefined },
  });
  if (publish) announcements.onPublished(listing.toObject());
  ok(req, res, merchantListingView(listing.toObject()), 201);
}));

// one listing edit, the same rules for the brand and for an admin: version check, closed / blocked listings,
// food details locked once a student has ordered, quantity never below what's held or ordered, no publishing
// while the brand is blocked or after the cutoff. Throws SurplusError; returns the listing after the change.
async function patchListing(l, b, { session = null } = {}) {
  if (!Number.isInteger(Number(b.version)) || Number(b.version) !== l.version) throw new SurplusError(409, "STALE_VERSION", "This listing changed meanwhile. Reload it and try again.", { version: l.version });
  if (l.status === "blocked") throw new SurplusError(403, "BRAND_BLOCKED", "This listing is paused by tdc");
  if (l.status === "closed") throw new SurplusError(409, "LISTING_CLOSED", "This listing is closed");
  const hasOrders = !!(await SurplusOrder.exists({ listing: l._id }).session(session));
  if (hasOrders && DISCLOSURE_FIELDS.some((k) => b[k] !== undefined)) throw new SurplusError(409, "DISCLOSURES_LOCKED", "Students have ordered this box: its contents, allergens, price and pickup window can't change. Close it and create a new one.");
  const set = Object.keys(b).some((k) => DISCLOSURE_FIELDS.includes(k) || k === "orderCutoff") ? listingFields(b, l) : {};
  const inc = { version: 1 };
  const filter = { _id: l._id, brand: l.brand, version: l.version };
  if (b.quantityTotal !== undefined) {
    const qty = Number(b.quantityTotal);
    const sold = l.quantityTotal - l.quantityAvailable;
    if (!Number.isInteger(qty) || qty < 1 || qty > 500) throw new SurplusError(400, "INVALID_QTY", "Quantity must be 1 to 500 boxes");
    if (qty < sold) throw new SurplusError(409, "BELOW_SOLD", `${sold} boxes are already held or ordered`);
    const delta = qty - l.quantityTotal;
    inc.quantityTotal = delta;
    inc.quantityAvailable = delta;
    if (delta < 0) filter.quantityAvailable = { $gte: -delta }; // a hold taken meanwhile wins
  }
  if (b.status !== undefined) {
    if (!["published", "paused", "closed", "draft"].includes(b.status)) throw new SurplusError(400, "INVALID_STATUS", "status must be published, paused or closed");
    if (b.status === "published") {
      if (await inventory.brandBlocked(l.brand)) throw new SurplusError(403, "BRAND_BLOCKED", "Your Surprise Box listings are paused by tdc. Contact support.");
      if (new Date(set.orderCutoff || l.orderCutoff) <= new Date()) throw new SurplusError(409, "ORDERS_CLOSED", "The order cutoff has passed");
      set.publishedAt = l.publishedAt || new Date();
    }
    if (b.status === "draft" && hasOrders) throw new SurplusError(409, "HAS_ORDERS", "This listing has orders");
    set.status = b.status;
    if (b.status === "closed") set.closedAt = new Date();
  }
  const updated = await SurplusListing.findOneAndUpdate(filter, { $set: set, $inc: inc }, { returnDocument: "after", session }).lean();
  if (!updated) throw new SurplusError(409, "STALE_VERSION", "This listing changed meanwhile (a student may have just held a box). Reload it and try again.");
  if (updated.status === "published" && updated.quantityAvailable === 0) await SurplusListing.updateOne({ _id: l._id, status: "published", quantityAvailable: 0 }, { $set: { status: "sold_out" } }, { session });
  if (updated.status === "sold_out" && updated.quantityAvailable > 0) await SurplusListing.updateOne({ _id: l._id, status: "sold_out" }, { $set: { status: "published" } }, { session });
  return SurplusListing.findById(l._id).session(session).lean();
}

router.post("/merchant/listings/:id/cancel", ...brand, handle(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 5) return fail(req, res, 400, "REASON_REQUIRED", "Tell the students why (at least 5 characters)");
  const l = isId(req.params.id) ? await SurplusListing.findOne({ _id: req.params.id, brand: req.userId }).lean() : null;
  if (!l) return fail(req, res, 404, "NOT_FOUND", "Listing not found");
  if (l.status === "blocked") return fail(req, res, 403, "BRAND_BLOCKED", "This listing is paused by tdc");
  if (l.status !== "closed" && Number(req.body?.version) !== l.version) return fail(req, res, 409, "STALE_VERSION", "This listing changed meanwhile. Reload it and try again.", { version: l.version });
  // 1. close it (no new holds or orders)
  if (l.status !== "closed") {
    const closed = await SurplusListing.findOneAndUpdate({ _id: l._id, brand: req.userId, version: l.version, status: { $nin: ["closed", "blocked"] } }, { $set: { status: "closed", closedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: "after" }).lean();
    if (!closed) return fail(req, res, 409, "STALE_VERSION", "This listing changed meanwhile. Reload it and try again.");
  }
  // 2. each open order the brand can still cancel: the brand's own cancel (reason to the student, push + in-app)
  const open = await SurplusOrder.find({ listing: l._id, brand: req.userId, state: { $in: policy.ACTIVE } }).lean();
  const cancelled = [], stayed = [], failed = [];
  for (const o of open) {
    if (!policy.merchantNext(o.state).includes("MERCHANT_CANCELLED")) { stayed.push(o.ref); continue; }
    try {
      await orders.merchantTransition(req.userId, o._id, { to: "MERCHANT_CANCELLED", version: o.version, reason: reason.slice(0, 300) });
      cancelled.push(o.ref);
    } catch (err) { failed.push({ ref: o.ref, code: err.code || "ERROR", message: err.message }); }
  }
  ok(req, res, { listingId: String(l._id), closed: true, cancelled, stayed, failed });
}));

router.patch("/merchant/listings/:id", ...brand, handle(async (req, res) => {
  const l = isId(req.params.id) ? await SurplusListing.findOne({ _id: req.params.id, brand: req.userId }).lean() : null;
  if (!l) return fail(req, res, 404, "NOT_FOUND", "Listing not found");
  const updated = await patchListing(l, req.body || {});
  announceIfFirstPublish(l, updated);
  ok(req, res, merchantListingView(updated));
}));

const dayBounds = (now = new Date()) => {
  const k = new Date(now.getTime() + 5 * 3600e3); // Karachi, UTC+5 all year
  const start = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - 5 * 3600e3);
  return { start, end: new Date(start.getTime() + 864e5) };
};
router.get("/merchant/orders", ...brand, handle(async (req, res) => {
  const scope = ["live", "today", "all"].includes(req.query.scope) ? req.query.scope : "live";
  const filter = { brand: req.userId };
  if (scope === "live") filter.state = { $in: policy.ACTIVE };
  if (scope === "today") { const d = dayBounds(); filter.pickupStart = { $gte: d.start, $lt: d.end }; }
  const list = await SurplusOrder.find(filter).sort({ pickupStart: 1 }).limit(300).lean();
  const names = await namesOf(list.map((o) => o.student));
  ok(req, res, list.map((o) => merchantOrderView(o, names.get(String(o.student)))));
}));

router.post("/merchant/orders/:id/transition", ...brand, handle(async (req, res) => {
  const { to, version, reason, markPaid } = req.body || {};
  const o = await orders.merchantTransition(req.userId, req.params.id, { to, version, reason, markPaid });
  const names = await namesOf([o.student]);
  ok(req, res, merchantOrderView(o, names.get(String(o.student))));
}));

const verify = handle(async (req, res) => {
  const { code, qr, branchId, markPaid } = req.body || {};
  if (req.params.id) {
    const mine = isId(req.params.id) && (await SurplusOrder.exists({ _id: req.params.id, brand: req.userId }));
    if (!mine) return fail(req, res, 404, "NOT_FOUND", "Order not found");
  }
  const o = await orders.verifyPickup(req.userId, { code, qr, branchId, markPaid: markPaid === true });
  if (req.params.id && !same(o._id, req.params.id)) return fail(req, res, 409, "CODE_FOR_ANOTHER_ORDER", "This code belongs to another order");
  const names = await namesOf([o.student]);
  ok(req, res, merchantOrderView(o, names.get(String(o.student))));
});
router.post("/merchant/orders/:id/verify-pickup", ...brand, verify);
router.post("/merchant/verify-pickup", ...brand, verify); // code / QR first, order found from it

router.get("/merchant/summary", ...brand, handle(async (req, res) => {
  const d = dayBounds();
  const list = await SurplusOrder.find({ brand: req.userId, pickupStart: { $gte: d.start, $lt: d.end } }).select("state qty priceSnapshot paymentState").lean();
  const by = {};
  for (const o of list) by[o.state] = (by[o.state] || 0) + 1;
  const sum = (f) => list.filter(f).reduce((s, o) => s + o.priceSnapshot.total, 0);
  const listings = await SurplusListing.find({ brand: req.userId, pickupEnd: { $gte: d.start }, pickupStart: { $lt: d.end } }).select("quantityTotal quantityAvailable status").lean();
  ok(req, res, {
    date: d.start, orders: list.length, byState: by,
    boxesOrdered: list.filter((o) => !["CUSTOMER_CANCELLED", "MERCHANT_CANCELLED"].includes(o.state)).reduce((s, o) => s + o.qty, 0),
    toCollectAtPickup: sum((o) => policy.AWAITING_PICKUP.includes(o.state)),
    collectedAtPickup: sum((o) => o.paymentState === "paid_at_pickup"),
    noShows: by.NO_SHOW || 0,
    boxesLeft: listings.filter((l) => ["published", "sold_out"].includes(l.status)).reduce((s, l) => s + l.quantityAvailable, 0),
  });
}));

// ---------- admin ----------
router.get("/admin/orders", ...admin, handle(async (req, res) => {
  const filter = {};
  if (req.query.state) filter.state = String(req.query.state);
  if (isId(req.query.brand)) filter.brand = req.query.brand;
  const list = await SurplusOrder.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  const [names, brands] = await Promise.all([namesOf(list.map((o) => o.student)), brandsById(list.map((o) => o.brand))]);
  ok(req, res, list.map((o) => ({ ...merchantOrderView(o, names.get(String(o.student))), studentId: String(o.student), brand: brands.get(String(o.brand)) || null })));
}));

router.get("/admin/no-shows", ...admin, handle(async (req, res) => {
  const since = new Date(Date.now() - 90 * 864e5);
  // a no-show the student later disputed still counts (the case decides whether it was one)
  const list = await SurplusOrder.find({ $or: [{ state: "NO_SHOW" }, { stateBeforeDispute: "NO_SHOW" }], pickupEnd: { $gte: since } }).select("student brand pickupEnd ref").lean();
  const by = new Map();
  for (const o of list) {
    const k = String(o.student);
    const e = by.get(k) || { studentId: k, count: 0, last: null, refs: [] };
    e.count += 1; e.refs.push(o.ref);
    if (!e.last || new Date(o.pickupEnd) > new Date(e.last)) e.last = o.pickupEnd;
    by.set(k, e);
  }
  const names = await namesOf([...by.keys()]);
  ok(req, res, { since, note: "Recorded only; nobody is banned automatically.", students: [...by.values()].sort((a, b) => b.count - a.count).map((e) => ({ ...e, name: names.get(e.studentId) || "student", refs: e.refs.slice(0, 10) })) });
}));

router.get("/admin/cases", ...admin, handle(async (req, res) => {
  const filter = req.query.status === "decided" ? { status: "decided" } : req.query.status === "all" ? {} : { status: "open" };
  const list = await SurplusSupportCase.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  const [ordersById, names, brands] = await Promise.all([
    SurplusOrder.find({ _id: { $in: list.map((c) => c.order) } }).lean().then((os) => new Map(os.map((o) => [String(o._id), o]))),
    namesOf(list.map((c) => c.student)), brandsById(list.map((c) => c.brand)),
  ]);
  ok(req, res, list.map((c) => {
    const o = ordersById.get(String(c.order));
    return { ...caseView(c), adminNote: c.adminNote, student: { id: String(c.student), name: names.get(String(c.student)) || "student" }, brand: brands.get(String(c.brand)) || null, order: o ? { ref: o.ref, stateBefore: o.stateBeforeDispute, title: o.disclosures?.title || "", total: o.priceSnapshot.total, pickupStart: o.pickupStart, history: historyView(o.history) } : null, history: c.history };
  }));
}));

router.post("/admin/cases/:id/decide", ...admin, handle(async (req, res) => {
  if (!isId(req.params.id)) return fail(req, res, 404, "NOT_FOUND", "Case not found");
  const { decision, note } = req.body || {};
  const decided = caseView(await cases.decideCase(req.userId, req.params.id, { decision, note }));
  await adminLog.recordSafe({ adminId: req.userId, action: "surplus.case.decide", targetType: "SurplusSupportCase", targetId: String(req.params.id), before: { status: "open" }, after: { status: decided.status, decision: decided.decision }, reason: note, requestId: req.id });
  ok(req, res, decided);
}));

router.get("/admin/brands", ...admin, handle(async (req, res) => {
  const [blocks, upheld, noShows, listings] = await Promise.all([
    SurplusBrandBlock.find({}).lean(),
    SurplusSupportCase.find({ decision: "upheld" }).select("brand").lean(),
    SurplusOrder.find({ $or: [{ state: "NO_SHOW" }, { stateBeforeDispute: "NO_SHOW" }] }).select("brand").lean(),
    SurplusListing.find({}).select("brand").lean(),
  ]);
  const ids = new Set([...blocks, ...upheld, ...listings].map((x) => String(x.brand)));
  const count = (rows, id) => rows.filter((r) => String(r.brand) === id).length;
  const brands = await brandsById([...ids]);
  ok(req, res, [...ids].map((id) => {
    const b = blocks.find((x) => String(x.brand) === id);
    return { ...(brands.get(id) || { id, name: "brand" }), blocked: !!b?.active, reason: b?.active ? b.reason : "", upheldCases: count(upheld, id), studentNoShows: count(noShows, id), listings: count(listings, id) };
  }).sort((a, b) => b.upheldCases - a.upheldCases));
}));

// ---------- a box's photo (optional) ----------
// POST /merchant/listings/:id/image (multipart "image" + "version"), DELETE /merchant/listings/:id/image { version }.
// The existing offer-image upload and its limits (images only: jpg, png, webp, heic...; at most 5 MB). Like the
// food details, the photo can't change once a student has ordered. A refused upload's file is deleted again.
const uploadsRoot = nodePath.join(__dirname, "..", "uploads");
const imageUrlOf = (file) => {
  const p = String(file?.path || file?.secure_url || "");
  if (/^https:\/\//i.test(p)) return p;
  const rel = nodePath.relative(uploadsRoot, p);
  return p && rel && !rel.startsWith("..") && !nodePath.isAbsolute(rel) ? `/uploads/${rel.split(nodePath.sep).join("/")}` : "";
};
const dropFile = (publicId) => (publicId ? Promise.resolve(deleteFromCloudinary(publicId)).catch(() => {}) : Promise.resolve());
const imageUpload = (req, res, next) => uploadOffer.single("image")(req, res, (err) => {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") return fail(req, res, 413, "IMAGE_TOO_LARGE", "The photo can be at most 5 MB");
  return fail(req, res, 400, "INVALID_IMAGE", String(err.message || "Only image files are allowed").slice(0, 200));
});
async function ownListingForPhoto(req, res) {
  const l = isId(req.params.id) ? await SurplusListing.findOne({ _id: req.params.id, brand: req.userId }).lean() : null;
  if (!l) { fail(req, res, 404, "NOT_FOUND", "Listing not found"); return null; }
  if (!Number.isInteger(Number(req.body?.version)) || Number(req.body.version) !== l.version) { fail(req, res, 409, "STALE_VERSION", "This listing changed meanwhile. Reload it and try again.", { version: l.version }); return null; }
  if (["closed", "blocked"].includes(l.status)) { fail(req, res, 409, l.status === "closed" ? "LISTING_CLOSED" : "BRAND_BLOCKED", "This listing can't be changed"); return null; }
  if (await SurplusOrder.exists({ listing: l._id })) { fail(req, res, 409, "DISCLOSURES_LOCKED", "Students have ordered this box: its photo can't change. Close it and create a new one."); return null; }
  return l;
}
router.post("/merchant/listings/:id/image", ...brand, imageUpload, handle(async (req, res) => {
  const uploaded = req.file?.filename || "";
  if (!req.file) return fail(req, res, 400, "NO_IMAGE", "Choose a photo");
  const l = await ownListingForPhoto(req, res);
  if (!l) return dropFile(uploaded);
  const url = imageUrlOf(req.file);
  if (!url) { await dropFile(uploaded); return fail(req, res, 400, "INVALID_IMAGE", "The photo couldn't be stored"); }
  const updated = await SurplusListing.findOneAndUpdate({ _id: l._id, version: l.version }, { $set: { image: { url, publicId: uploaded } }, $inc: { version: 1 } }, { returnDocument: "after" }).lean();
  if (!updated) { await dropFile(uploaded); return fail(req, res, 409, "STALE_VERSION", "This listing changed meanwhile. Reload it and try again."); }
  if (l.image?.publicId && l.image.publicId !== uploaded) await dropFile(l.image.publicId); // the replaced photo
  ok(req, res, merchantListingView(updated));
}));
router.delete("/merchant/listings/:id/image", ...brand, handle(async (req, res) => {
  const l = await ownListingForPhoto(req, res);
  if (!l) return;
  const updated = await SurplusListing.findOneAndUpdate({ _id: l._id, version: l.version }, { $set: { image: { url: "", publicId: "" } }, $inc: { version: 1 } }, { returnDocument: "after" }).lean();
  if (!updated) return fail(req, res, 409, "STALE_VERSION", "This listing changed meanwhile. Reload it and try again.");
  await dropFile(l.image?.publicId);
  ok(req, res, merchantListingView(updated));
}));

// ---------- admin: every brand's listings ----------
// GET /admin/listings (?status=&brandId=&q=), GET /admin/listings/:id (with its orders), PATCH /admin/listings/:id
// (edit / publish / pause / close, the brand's own rules), POST /admin/listings/:id/cancel (close it and cancel its
// open orders). Every write needs a reason (5+ characters) and writes its AdminActionLog row in the same
// transaction as the change; each cancelled order is its own logged write.
const { withTransaction } = require("../utils/transaction");
const adminReason = (b) => {
  const r = String(b?.reason || "").trim();
  if (r.length < 5) throw new SurplusError(400, "REASON_REQUIRED", "Give a reason (at least 5 characters)");
  return r.slice(0, 500);
};
const ADMIN_LISTING_FIELDS = [...DISCLOSURE_FIELDS, "orderCutoff", "quantityTotal", "status"];
const listingSummary = (l) => (l ? { status: l.status, title: l.title, price: l.price, listPrice: l.listPrice, quantityTotal: l.quantityTotal, quantityAvailable: l.quantityAvailable, pickupStart: l.pickupStart, pickupEnd: l.pickupEnd, version: l.version } : null);
const orderCounts = async (ids) => {
  const by = {};
  for (const o of await SurplusOrder.find({ listing: { $in: ids } }).select("listing state").lean()) {
    const k = String(o.listing);
    by[k] = by[k] || { total: 0, open: 0 };
    by[k].total += 1;
    if (policy.ACTIVE.includes(o.state)) by[k].open += 1;
  }
  return by;
};
const adminListingView = (l, brands, counts) => ({ ...merchantListingView(l, { [String(l._id)]: counts[String(l._id)]?.total || 0 }), brand: brands.get(String(l.brand)) || { id: String(l.brand), name: "brand", logo: "" }, openOrders: counts[String(l._id)]?.open || 0 });

router.get("/admin/listings", ...admin, handle(async (req, res) => {
  const filter = {};
  if (req.query.status && ["draft", "published", "paused", "sold_out", "closed", "blocked"].includes(String(req.query.status))) filter.status = String(req.query.status);
  if (req.query.brandId) { if (!isId(req.query.brandId)) return ok(req, res, { listings: [] }); filter.brand = String(req.query.brandId); }
  const list = await SurplusListing.find(filter).sort({ pickupStart: -1 }).limit(300).lean();
  const [brands, counts] = await Promise.all([brandsById(list.map((l) => l.brand)), orderCounts(list.map((l) => l._id))]);
  const q = String(req.query.q || "").trim().toLowerCase().slice(0, 80);
  const rows = list.map((l) => adminListingView(l, brands, counts)).filter((l) => !q || l.title.toLowerCase().includes(q) || l.brand.name.toLowerCase().includes(q));
  ok(req, res, { listings: rows });
}));

router.get("/admin/listings/:id", ...admin, handle(async (req, res) => {
  const l = isId(req.params.id) ? await SurplusListing.findById(req.params.id).lean() : null;
  if (!l) return fail(req, res, 404, "NOT_FOUND", "Listing not found");
  const orders = await SurplusOrder.find({ listing: l._id }).sort({ createdAt: -1 }).limit(300).lean();
  const [brands, counts, names] = await Promise.all([brandsById([l.brand]), orderCounts([l._id]), namesOf(orders.map((o) => o.student))]);
  ok(req, res, { listing: adminListingView(l, brands, counts), orders: orders.map((o) => merchantOrderView(o, names.get(String(o.student)))) });
}));

router.patch("/admin/listings/:id", ...admin, handle(async (req, res) => {
  const reason = adminReason(req.body);
  const l = isId(req.params.id) ? await SurplusListing.findById(req.params.id).lean() : null;
  if (!l) return fail(req, res, 404, "NOT_FOUND", "Listing not found");
  const b = { ...(req.body || {}) };
  delete b.reason;
  const changed = Object.keys(b).filter((k) => ADMIN_LISTING_FIELDS.includes(k));
  if (!changed.length) return fail(req, res, 400, "NOTHING_TO_CHANGE", "Nothing to change");
  const action = changed.length === 1 && changed[0] === "status" ? `surplus.listing.${{ published: "publish", paused: "pause", closed: "close", draft: "unpublish" }[b.status] || "update"}` : "surplus.listing.update";
  const { result } = await withTransaction(async (session) => {
    const updated = await patchListing(l, b, { session });
    await adminLog.record({ adminId: req.userId, action, targetType: "SurplusListing", targetId: String(l._id), before: adminLog.pick(listingSummary(l), [...changed, "version"]), after: adminLog.pick(listingSummary(updated), [...changed, "version"]), reason, requestId: req.id }, { session });
    return updated;
  });
  announceIfFirstPublish(l, result);
  const [brands, counts] = await Promise.all([brandsById([result.brand]), orderCounts([result._id])]);
  ok(req, res, adminListingView(result, brands, counts));
}));

router.post("/admin/listings/:id/cancel", ...admin, handle(async (req, res) => {
  const reason = adminReason(req.body);
  const l = isId(req.params.id) ? await SurplusListing.findById(req.params.id).lean() : null;
  if (!l) return fail(req, res, 404, "NOT_FOUND", "Listing not found");
  if (l.status !== "closed" && Number(req.body?.version) !== l.version) return fail(req, res, 409, "STALE_VERSION", "This listing changed meanwhile. Reload it and try again.", { version: l.version });
  // 1. close it (no new orders), logged with the reason
  if (l.status !== "closed") {
    await withTransaction(async (session) => {
      const closed = await SurplusListing.findOneAndUpdate({ _id: l._id, version: l.version, status: { $ne: "closed" } }, { $set: { status: "closed", closedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: "after", session }).lean();
      if (!closed) throw new SurplusError(409, "STALE_VERSION", "This listing changed meanwhile. Reload it and try again.");
      await adminLog.record({ adminId: req.userId, action: "surplus.listing.cancel", targetType: "SurplusListing", targetId: String(l._id), before: { status: l.status, version: l.version }, after: { status: "closed", version: closed.version }, reason, requestId: req.id }, { session });
    });
  }
  // 2. cancel each open order that can still be cancelled, each with its own logged write; handed-over ones stay
  const open = await SurplusOrder.find({ listing: l._id, state: { $in: policy.ACTIVE } }).lean();
  const cancelled = [], stayed = [], failed = [];
  for (const o of open) {
    if (!policy.merchantNext(o.state).includes("MERCHANT_CANCELLED")) { stayed.push(o.ref); continue; }
    try {
      const { result: done } = await withTransaction(async (session) => {
        const u = await orders.adminCancel(req.userId, o._id, { version: o.version, reason, session });
        await adminLog.record({ adminId: req.userId, action: "surplus.order.cancel", targetType: "SurplusOrder", targetId: String(o._id), before: { state: o.state }, after: { state: u.state, listing: String(l._id) }, reason, requestId: req.id }, { session });
        return u;
      });
      await orders.notifyCancelled(done).catch(() => {});
      cancelled.push(o.ref);
    } catch (err) { failed.push({ ref: o.ref, code: err.code || "ERROR", message: err.message }); }
  }
  ok(req, res, { listingId: String(l._id), closed: true, cancelled, stayed, failed });
}));

router.post("/admin/brands/:brandId/block", ...admin, handle(async (req, res) => {
  const { blocked, reason } = req.body || {};
  const target = isId(req.params.brandId) ? await User.findOne({ _id: req.params.brandId, role: "brand" }).select("_id").lean() : null;
  if (!target) return fail(req, res, 404, "NOT_FOUND", "Brand not found");
  const r = await cases.setBrandBlock(req.userId, req.params.brandId, { blocked: blocked === true, reason });
  await adminLog.recordSafe({ adminId: req.userId, action: blocked === true ? "surplus.brand.block" : "surplus.brand.unblock", targetType: "Brand", targetId: String(req.params.brandId), before: { blocked: blocked !== true }, after: { blocked: r.block.active, listingsChanged: r.listingsChanged }, reason, requestId: req.id });
  ok(req, res, { brandId: String(req.params.brandId), blocked: r.block.active, reason: r.block.active ? r.block.reason : "", listingsChanged: r.listingsChanged });
}));

module.exports = router;
module.exports.warnIfNoPickupSecret = warnIfNoPickupSecret;
