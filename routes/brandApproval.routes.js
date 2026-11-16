// routes/brandApproval.routes.js — /api/brand-approval: the admin Brand Approvals page (feat/admin-approvals-metrics).
//   GET  /approved                 public: approved brands (no contact details)
//   GET  /stats                    admin: counts per status + the 10 newest brands
//   GET  /                         admin: search (brand / owner name, email, phone, city, category; case-insensitive),
//                                  filters status | city | category | joinedFrom / joinedTo (YYYY-MM-DD, Karachi),
//                                  sort newest | oldest | name, page (25 per page); counts per status for the tabs
//                                  (with the search and other filters applied), city / category options
//   GET  /:id                      admin: the brand, its branches and offers, and the approve / reject history
//   PUT  /:id/status               admin: { status, reason } — a reason is required to reject
//   POST /:id/request-info         admin: { reason } — asks the brand for more information (status unchanged)
//   PUT  /bulk-status              admin: { brandIds, status, reason } — one reason for all; each brand logged
// Every admin change is written to the admin action log (services/adminActionLog.js, targetType "Brand") and the
// brand is notified. /approved and /stats are declared before /:id (they used to be shadowed by it).
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const User = require("../models/User");
const Branch = require("../models/Branch");
const Offer = require("../models/Offer");
const Notification = require("../models/Notification");
const auth = require("../middleware/auth.middleware");
const { clearOfferCaches } = require("../utils/cache");
const { onlineStoresFor } = require("../services/storeStatus");
const actionLog = require("../services/adminActionLog");

const STATUSES = ["pending", "approved", "rejected", "draft"];
const PAGE_SIZE = 25;
const MAX_BULK = 100;
const LIST_FIELDS = "name email phone brandName logo category city address isOnline isInStore brandApprovalStatus brandApprovalNote brandApprovedAt brandRejectedAt createdAt";
const isId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });
const cleanReason = (r) => String(r ?? "").trim().slice(0, 500);

const isAdmin = async (req, res, next) => {
  try {
    if (!isId(req.userId)) return fail(res, 403, "FORBIDDEN", "Access denied. Admins only.");
    const user = await User.findById(req.userId).select("role").lean();
    if (user && user.role === "admin") return next();
    return fail(res, 403, "FORBIDDEN", "Access denied. Admins only.");
  } catch (err) {
    console.error("[brand-approval] admin check:", err?.message);
    return fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
};

// ==========================================
// GET APPROVED BRANDS (Public)
// ==========================================
router.get("/approved", async (req, res) => {
  try {
    const brands = await User.find({
      role: "brand",
      brandApprovalStatus: "approved"
    })
    .select("name brandName logo category address isOnline isInStore") // public list: no email or phone
    .sort({ createdAt: -1 });
    res.json({ success: true, brands });
  } catch (err) {
    console.error("Error fetching approved brands:", err?.message);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

const statusCounts = async (base = {}) => {
  const out = { total: 0 };
  for (const s of STATUSES) { out[s] = await User.countDocuments({ ...base, role: "brand", brandApprovalStatus: s }); out.total += out[s]; }
  out.all = await User.countDocuments({ ...base, role: "brand" });
  out.total = out.all;
  return out;
};

// ==========================================
// GET BRAND STATS FOR DASHBOARD
// ==========================================
router.get("/stats", auth, isAdmin, async (req, res) => {
  try {
    const stats = await statusCounts();
    const recentBrands = await User.find({ role: "brand" })
      .select("name brandName brandApprovalStatus createdAt")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    res.json({ success: true, stats, recentBrands });
  } catch (err) {
    console.error("Error fetching brand stats:", err?.message);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

/** the list filter (everything except status) from the query; throws 400 on a bad date */
function listFilter(q) {
  const filter = { role: "brand" };
  const and = [];
  const search = String(q.q ?? q.search ?? "").trim().slice(0, 100);
  if (search) {
    const re = { $regex: escapeRe(search), $options: "i" };
    and.push({ $or: ["brandName", "name", "email", "phone", "city", "category"].map((k) => ({ [k]: re })) });
  }
  if (q.city && q.city !== "all") and.push({ city: { $regex: `^${escapeRe(String(q.city).trim().slice(0, 80))}$`, $options: "i" } });
  if (q.category && q.category !== "all") and.push({ category: { $regex: `^${escapeRe(String(q.category).trim().slice(0, 80))}$`, $options: "i" } });
  const day = (v, end) => {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw Object.assign(new Error("dates must be YYYY-MM-DD"), { status: 400, code: "INVALID_DATE" });
    const d = new Date(`${v}T${end ? "23:59:59.999" : "00:00:00"}+05:00`);
    if (Number.isNaN(d.getTime())) throw Object.assign(new Error("not a real date"), { status: 400, code: "INVALID_DATE" });
    return d;
  };
  const from = day(q.joinedFrom, false);
  const to = day(q.joinedTo, true);
  if (from || to) and.push({ createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } });
  if (and.length) filter.$and = and;
  return filter;
}

/** branches and live offers per brand */
async function countsFor(brandIds) {
  const branches = new Map();
  const offers = new Map();
  if (!brandIds.length) return { branches, offers };
  for (const b of await Branch.find({ brand: { $in: brandIds } }).select("brand").lean()) branches.set(String(b.brand), (branches.get(String(b.brand)) || 0) + 1);
  for (const o of await Offer.find({ brand: { $in: brandIds }, status: { $ne: "archived" } }).select("brand").lean()) offers.set(String(o.brand), (offers.get(String(o.brand)) || 0) + 1);
  return { branches, offers };
}

// ==========================================
// GET BRANDS: search, filters, sort, page
// ==========================================
router.get("/", auth, isAdmin, async (req, res) => {
  try {
    const q = req.query || {};
    const base = listFilter(q);
    const status = STATUSES.includes(q.status) ? q.status : "all";
    const filter = status === "all" ? base : { ...base, brandApprovalStatus: status };
    const sort = q.sort === "oldest" ? { createdAt: 1, _id: 1 } : q.sort === "name" ? { brandName: 1, name: 1, _id: 1 } : { createdAt: -1, _id: -1 };
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || PAGE_SIZE, 1), 100);
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const total = await User.countDocuments(filter);
    const brands = await User.find(filter)
      .select(LIST_FIELDS)
      .collation({ locale: "en", strength: 2 }) // name sort ignores case
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    const ids = brands.map((b) => b._id);
    const { branches, offers } = await countsFor(ids);
    // the online store each brand really has: platform and connection status (no keys)
    const stores = await onlineStoresFor(ids);
    for (const b of brands) {
      b.onlineStore = stores.get(String(b._id));
      b.branchesCount = branches.get(String(b._id)) || 0;
      b.offersCount = offers.get(String(b._id)) || 0;
    }
    const cities = (await User.distinct("city", { role: "brand" })).filter(Boolean).map(String).sort((a, b) => a.localeCompare(b));
    const categories = (await User.distinct("category", { role: "brand" })).filter(Boolean).map(String).sort((a, b) => a.localeCompare(b));
    res.json({
      success: true,
      brands,
      page, limit, total, pages: Math.max(Math.ceil(total / limit), 1),
      counts: await statusCounts(base.$and ? { $and: base.$and } : {}), // the tabs, with the search and filters applied
      stats: await statusCounts(), // every brand (older clients)
      options: { cities: [...new Set(cities)], categories: [...new Set(categories)] },
    });
  } catch (err) {
    if (err.status && err.code) return fail(res, err.status, err.code, err.message);
    console.error("Error fetching brands:", err?.message);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

/** the approve / reject / request-info history: the admin action log, plus the dates kept before logging began */
async function historyOf(brand) {
  const AdminActionLog = require("../models/AdminActionLog");
  const rows = await AdminActionLog.find({ targetType: "Brand", targetId: String(brand._id) }).sort({ at: -1 }).limit(100).lean();
  const admins = new Map((await User.find({ _id: { $in: [...new Set(rows.map((r) => String(r.admin)))] } }).select("name").lean()).map((u) => [String(u._id), u.name || "admin"]));
  const history = rows.map((r) => ({ id: String(r._id), action: r.action, status: r.after?.brandApprovalStatus ?? null, previousStatus: r.before?.brandApprovalStatus ?? null, reason: r.reason || "", admin: { id: String(r.admin), name: admins.get(String(r.admin)) || "admin" }, at: r.at }));
  // decisions made before this log existed: only the date (and the last note) were kept, not the admin
  const logged = (a) => history.some((h) => h.action === a);
  if (brand.brandApprovedAt && !logged("brand.approve")) history.push({ id: "legacy-approved", action: "brand.approve", status: "approved", reason: "", admin: null, at: brand.brandApprovedAt, legacy: true });
  if (brand.brandRejectedAt && !logged("brand.reject")) history.push({ id: "legacy-rejected", action: "brand.reject", status: "rejected", reason: brand.brandApprovalNote || "", admin: null, at: brand.brandRejectedAt, legacy: true });
  return history.sort((a, b) => new Date(b.at) - new Date(a.at));
}

// ==========================================
// GET SINGLE BRAND DETAILS
// ==========================================
router.get("/:id", auth, isAdmin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 404, "NOT_FOUND", "Brand not found");
    const brand = await User.findOne({ _id: req.params.id, role: "brand" }).select("-password").lean();
    if (!brand) return fail(res, 404, "NOT_FOUND", "Brand not found");
    const branches = await Branch.find({ brand: brand._id }).select("name city location phone isActive discountPercentage createdAt").sort({ createdAt: -1 }).limit(100).lean();
    const offers = await Offer.find({ brand: brand._id }).select("title discountPercentage status archivedAt createdAt isOnline isInStore").sort({ createdAt: -1 }).limit(100).lean();
    const stores = await onlineStoresFor([brand._id]);
    brand.onlineStore = stores.get(String(brand._id));
    brand.branchesCount = branches.length;
    brand.offersCount = offers.filter((o) => o.status !== "archived").length;
    res.json({ success: true, brand, branches, offers, history: await historyOf(brand) });
  } catch (err) {
    console.error("Error fetching brand:", err?.message);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

const MESSAGES = {
  approved: (n) => ["🎉 Brand Approved!", `Your brand "${n}" has been approved and is now visible to students!`],
  rejected: (n, reason) => ["Brand Application Update", `Your brand "${n}" application was not approved. Reason: ${reason}`],
  draft: (n) => ["Brand Saved as Draft", `Your brand "${n}" has been saved as a draft. It is not visible to students yet.`],
  pending: (n) => ["Brand Status Updated", `Your brand "${n}" is under review. We'll notify you once it's approved.`],
};
async function notify(brand, title, description) {
  try {
    await Notification.create({ recipient: brand._id, title, description, type: "Brand", icon: "information", link: "/brands/my-brand" });
  } catch (e) {
    console.error("[brand-approval] notification:", e?.message);
  }
}

/** one brand's status change: saved, logged, notified. Returns the updated row. */
async function setStatus(brand, status, reason, req) {
  const before = { brandApprovalStatus: brand.brandApprovalStatus || "pending" };
  const now = new Date();
  const set = { brandApprovalStatus: status, brandApprovedAt: status === "approved" ? now : null, brandRejectedAt: status === "rejected" ? now : null };
  if (reason) set.brandApprovalNote = reason;
  await User.updateOne({ _id: brand._id, role: "brand" }, { $set: set });
  const action = { approved: "brand.approve", rejected: "brand.reject", pending: "brand.set_pending", draft: "brand.set_draft" }[status];
  await actionLog.record({ adminId: req.userId, action, targetType: "Brand", targetId: String(brand._id), before, after: { brandApprovalStatus: status }, reason, requestId: req.id });
  const name = brand.brandName || brand.name || "your brand";
  await notify(brand, ...MESSAGES[status](name, reason));
  return User.findById(brand._id).select(LIST_FIELDS).lean();
}

const checkStatusAndReason = (status, reason) => {
  if (!STATUSES.includes(status)) return ["INVALID_STATUS", `Invalid status. Must be one of: ${STATUSES.join(", ")}`];
  if (status === "rejected" && reason.length < 3) return ["REASON_REQUIRED", "Give a reason to reject (the brand sees it)"];
  return null;
};

// ==========================================
// BULK UPDATE BRAND STATUSES (before /:id/...)
// ==========================================
router.put("/bulk-status", auth, isAdmin, async (req, res) => {
  try {
    const { brandIds, status } = req.body || {};
    const reason = cleanReason(req.body?.reason ?? req.body?.note);
    if (!Array.isArray(brandIds) || brandIds.length === 0) return fail(res, 400, "NO_BRANDS", "Please provide brand IDs");
    if (brandIds.length > MAX_BULK) return fail(res, 400, "TOO_MANY", `At most ${MAX_BULK} brands at a time`);
    const bad = checkStatusAndReason(status, reason);
    if (bad) return fail(res, 400, ...bad);
    const ids = [...new Set(brandIds.map(String).filter(isId))];
    const brands = await User.find({ _id: { $in: ids }, role: "brand" }).select("name brandName brandApprovalStatus").lean();
    const updated = [];
    for (const b of brands) updated.push(await setStatus(b, status, reason, req));
    await clearOfferCaches(); // public brand lists (GET /brands) show the change at once
    res.json({ success: true, message: `${updated.length} brands updated`, updatedCount: updated.length, brands: updated, notFound: ids.length - brands.length });
  } catch (err) {
    console.error("Error bulk updating brands:", err?.message);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

// ==========================================
// UPDATE BRAND APPROVAL STATUS
// ==========================================
router.put("/:id/status", auth, isAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    const reason = cleanReason(req.body?.reason ?? req.body?.note);
    const bad = checkStatusAndReason(status, reason);
    if (bad) return fail(res, 400, ...bad);
    if (!isId(req.params.id)) return fail(res, 404, "NOT_FOUND", "Brand not found");
    const brand = await User.findOne({ _id: req.params.id, role: "brand" }).select("name brandName brandApprovalStatus").lean();
    if (!brand) return fail(res, 404, "NOT_FOUND", "Brand not found");
    const updated = await setStatus(brand, status, reason, req);
    await clearOfferCaches();
    res.json({ success: true, message: `Brand status updated to ${status}`, brand: updated });
  } catch (err) {
    console.error("Error updating brand status:", err?.message);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

// ==========================================
// REQUEST MORE INFORMATION (status unchanged)
// ==========================================
router.post("/:id/request-info", auth, isAdmin, async (req, res) => {
  try {
    const reason = cleanReason(req.body?.reason);
    if (reason.length < 3) return fail(res, 400, "REASON_REQUIRED", "Say what the brand needs to send or fix");
    if (!isId(req.params.id)) return fail(res, 404, "NOT_FOUND", "Brand not found");
    const brand = await User.findOne({ _id: req.params.id, role: "brand" }).select("name brandName brandApprovalStatus").lean();
    if (!brand) return fail(res, 404, "NOT_FOUND", "Brand not found");
    await User.updateOne({ _id: brand._id }, { $set: { brandApprovalNote: reason } }); // the brand's dashboard shows the latest note
    const st = brand.brandApprovalStatus || "pending";
    await actionLog.record({ adminId: req.userId, action: "brand.request_info", targetType: "Brand", targetId: String(brand._id), before: { brandApprovalStatus: st }, after: { brandApprovalStatus: st }, reason, requestId: req.id });
    await notify(brand, "More information needed", `To review "${brand.brandName || brand.name || "your brand"}" we need: ${reason}`);
    res.json({ success: true, message: "Request sent to the brand", brand: await User.findById(brand._id).select(LIST_FIELDS).lean() });
  } catch (err) {
    console.error("Error requesting brand info:", err?.message);
    fail(res, 500, "SERVER_ERROR", "Something went wrong");
  }
});

module.exports = router;
module.exports._test = { listFilter, escapeRe };
