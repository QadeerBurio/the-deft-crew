// routes/adminUniversities.routes.js — /api/admin/universities: the admin's university list (admins only, checked
// against the database). Every change is logged in AdminActionLog (action "university.*").
//   GET    /?search=&city=&status=   all entries (approved / pending / hidden / unmatched) with student counts, newest pending first
//   GET    /pending-count            for the menu badge
//   GET    /cities                   cities in the list (filter)
//   POST   /                         { name, shortName?, city, aliases? }  add (approved)
//   PATCH  /:id                      { name?, shortName?, city?, aliases? } edit
//   POST   /:id/hide | /:id/show
//   POST   /:id/approve              a pending request (optionally edited: same fields as PATCH)
//   POST   /:id/reject               { reason, mergeInto? }  hidden with the reason; mergeInto moves its students there
//   POST   /merge                    { fromId, toId }  every student / offer / confession moves, the old name becomes an alias
//   GET    /unmatched                old typed names students have that aren't on the list, with counts and a suggestion
//   POST   /unmatched/:id/match      { toId }  = merge into that university
//   POST   /unmatched/:id/add        { name?, shortName?, city, aliases? }  becomes an approved university as it is
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const University = require("../models/University");
const unis = require("../services/universities");
const log = require("../services/adminActionLog");

const router = express.Router();
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const ok = (req, res, data, status = 200) => res.status(status).json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message) => res.status(status).json({ success: false, error: { code, message }, requestId: req.id || null });

async function requireAdmin(req, res, next) {
  try {
    if (req.isGuest || !isId(req.userId)) return fail(req, res, 401, "SIGN_IN", "Sign in first");
    const u = await User.findById(req.userId).select("role").lean();
    if (!u || u.role !== "admin") return fail(req, res, 403, "FORBIDDEN", "Admins only");
    next();
  } catch (err) {
    console.error("[admin-universities]", err?.message);
    fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
}
router.use(auth, requireAdmin);
const handle = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (err?.status) return fail(req, res, err.status, err.code, err.message);
  if (err?.code === 11000) return fail(req, res, 409, "NAME_TAKEN", "A university with this name already exists: merge into it instead");
  console.error("[admin-universities]", err?.message);
  fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
});

const clean = (s, max = 150) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanAliases = (a) => (Array.isArray(a) ? a : String(a || "").split(",")).map((x) => clean(x, 150)).filter(Boolean).slice(0, 60);
const FIELDS = ["name", "shortName", "city", "aliases", "status", "rejectReason", "mergedInto"];
const snap = (u) => (u ? log.pick(u.toObject ? u.toObject() : u, FIELDS) : null);
const row = (u, counts) => ({
  id: String(u._id), name: u.name, shortName: u.shortName || "", city: u.city || "", province: u.province || "", aliases: u.aliases || [],
  status: u.status || "unmatched", source: u.source || "signup", students: counts.get(String(u._id)) || 0,
  rejectReason: u.rejectReason || "", mergedInto: u.mergedInto ? String(u.mergedInto) : null, requestedAt: u.createdAt || null,
});
const audit = (req, action, u, before, after, reason = "") => log.record({ admin: req.userId, action, targetType: "University", targetId: String(u._id), before, after, reason, requestId: req.id });

function applyFields(u, body) {
  if (body.name !== undefined) { const n = clean(body.name); if (n.length < 3) throw Object.assign(new Error("Name is too short"), { status: 400, code: "NAME_REQUIRED" }); u.name = n; u.key = unis.keyOf(n); }
  if (body.shortName !== undefined) u.shortName = clean(body.shortName, 30);
  if (body.city !== undefined) u.city = clean(body.city, 80);
  if (body.aliases !== undefined) u.aliases = cleanAliases(body.aliases);
}
const load = async (id) => {
  if (!isId(id)) throw Object.assign(new Error("University not found"), { status: 404, code: "NOT_FOUND" });
  const u = await University.findById(id);
  if (!u) throw Object.assign(new Error("University not found"), { status: 404, code: "NOT_FOUND" });
  return u;
};

router.get("/", handle(async (req, res) => {
  const q = unis.keyOf(req.query.search || "");
  const filter = {};
  const status = String(req.query.status || "");
  if (status === "unmatched") filter.$or = [{ status: { $exists: false } }, { status: null }];
  else if (["approved", "pending", "hidden"].includes(status)) filter.status = status;
  if (req.query.city) filter.city = String(req.query.city).slice(0, 80);
  let list = await University.find(filter).lean();
  if (q) list = list.filter((u) => [u.name, u.shortName, ...(u.aliases || [])].some((x) => unis.keyOf(x).includes(q)) || unis.keyOf(u.city).startsWith(q));
  const counts = await unis.countsFor(list.map((u) => u._id));
  const order = { pending: 0, unmatched: 1, approved: 2, hidden: 3 };
  ok(req, res, list.map((u) => row(u, counts)).sort((a, b) => order[a.status] - order[b.status] || b.students - a.students || a.name.localeCompare(b.name)));
}));

router.get("/pending-count", handle(async (req, res) => ok(req, res, { pending: await University.countDocuments({ status: "pending" }) })));
router.get("/cities", handle(async (req, res) => ok(req, res, [...new Set((await University.find({ city: { $ne: "" } }).select("city").lean()).map((u) => u.city))].sort())));

router.post("/", handle(async (req, res) => {
  const u = new University({ status: "approved", source: "admin" });
  applyFields(u, req.body || {});
  if (!u.name) return fail(req, res, 400, "NAME_REQUIRED", "Add the university's name");
  if (!u.city) return fail(req, res, 400, "CITY_REQUIRED", "Add the city");
  await u.save();
  await audit(req, "university.add", u, null, snap(u));
  unis.bust();
  ok(req, res, row(u, new Map()), 201);
}));

router.patch("/:id", handle(async (req, res) => {
  const u = await load(req.params.id);
  const before = snap(u);
  applyFields(u, req.body || {});
  await u.save();
  await audit(req, "university.edit", u, before, snap(u));
  unis.bust();
  if (req.body?.name !== undefined) await User.updateMany({ university: u._id }, { $set: { universityName: u.name } });
  ok(req, res, row(u, await unis.countsFor([u._id])));
}));

for (const [path, status, action] of [["hide", "hidden", "university.hide"], ["show", "approved", "university.show"]]) {
  router.post(`/:id/${path}`, handle(async (req, res) => {
    const u = await load(req.params.id);
    const before = snap(u);
    if (status === "approved" && u.mergedInto) return fail(req, res, 400, "MERGED", "This entry was merged into another university");
    u.status = status;
    await u.save();
    await audit(req, action, u, before, snap(u), clean(req.body?.reason, 500));
    unis.bust();
    ok(req, res, row(u, await unis.countsFor([u._id])));
  }));
}

router.post("/:id/approve", handle(async (req, res) => {
  const u = await load(req.params.id);
  if (u.status !== "pending") return fail(req, res, 409, "NOT_PENDING", "Only a pending request can be approved");
  const before = snap(u);
  applyFields(u, req.body || {});
  u.status = "approved";
  await u.save();
  await User.updateMany({ university: u._id }, { $set: { universityName: u.name } });
  await audit(req, "university.approve", u, before, snap(u));
  unis.bust();
  ok(req, res, row(u, await unis.countsFor([u._id])));
}));

router.post("/:id/reject", handle(async (req, res) => {
  const u = await load(req.params.id);
  if (u.status !== "pending") return fail(req, res, 409, "NOT_PENDING", "Only a pending request can be rejected");
  const reason = clean(req.body?.reason, 300);
  if (!reason) return fail(req, res, 400, "REASON_REQUIRED", "Say why (the student sees it)");
  const before = snap(u);
  let merged = null;
  if (req.body?.mergeInto) merged = await unis.merge(u._id, (await load(req.body.mergeInto))._id); // students move to the real one
  const fresh = await load(u._id);
  fresh.status = "hidden";
  fresh.rejectReason = reason;
  await fresh.save();
  await audit(req, "university.reject", fresh, before, { ...snap(fresh), ...(merged ? { movedTo: merged.to.name, moved: merged.moved } : {}) }, reason);
  unis.bust();
  ok(req, res, { ...row(fresh, await unis.countsFor([fresh._id])), merged });
}));

async function mergeAndLog(req, fromId, toId, action) {
  const from = await load(fromId);
  const to = await load(toId);
  const before = { from: snap(from), to: snap(to) };
  const r = await unis.merge(from._id, to._id);
  await audit(req, action, from, before, { from: snap(await load(from._id)), to: snap(await load(to._id)), moved: r.moved });
  return r;
}
router.post("/merge", handle(async (req, res) => ok(req, res, await mergeAndLog(req, req.body?.fromId, req.body?.toId, "university.merge"))));

router.get("/unmatched", handle(async (req, res) => ok(req, res, await unis.unmatched())));
router.post("/unmatched/:id/match", handle(async (req, res) => {
  const u = await load(req.params.id);
  if (u.status) return fail(req, res, 409, "NOT_UNMATCHED", "This name is already on the list");
  ok(req, res, await mergeAndLog(req, u._id, req.body?.toId, "university.match"));
}));
router.post("/unmatched/:id/add", handle(async (req, res) => {
  const u = await load(req.params.id);
  if (u.status) return fail(req, res, 409, "NOT_UNMATCHED", "This name is already on the list");
  const before = snap(u);
  applyFields(u, req.body || {});
  if (!u.city) return fail(req, res, 400, "CITY_REQUIRED", "Add the city");
  u.status = "approved";
  u.source = u.source || "signup";
  if (!u.key) u.key = unis.keyOf(u.name);
  await u.save();
  await User.updateMany({ university: u._id }, { $set: { universityName: u.name } });
  await audit(req, "university.add_unmatched", u, before, snap(u));
  unis.bust();
  ok(req, res, row(u, await unis.countsFor([u._id])));
}));

module.exports = router;
