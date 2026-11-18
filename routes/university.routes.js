// routes/university.routes.js — /api/universities: the shared university list (services/universities.js).
//   GET  /?search=&limit=     public: approved universities matching name, short name or aliases (case / spaces don't matter)
//   POST /request             { name, city } signed in or during signup (no account yet): "my university isn't listed".
//                             An existing match comes back as { match } ("did you mean …?"); else a pending entry
//                             { university } the student can use right away. 5 an hour per account / device.
//   PUT  /mine                { universityId } signed-in student: their university (approved, or the pending one they asked for)
// Replies: { success: true, data } or { success: false, error: { code, message } }. Matching never reads this list.
const express = require("express");
const mongoose = require("mongoose");
const { rateLimit } = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const University = require("../models/University");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");
const unis = require("../services/universities");

const router = express.Router();
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: { code, message, ...extra } });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

// the caller's account if a real token is sent (signup has none): only for the rate-limit key and requestedBy
function optionalUser(req) {
  const h = String(req.headers.authorization || "");
  const t = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!t || ["undefined", "null", "guest-token-2024"].includes(t)) return null;
  try { const p = jwt.verify(t, process.env.JWT_SECRET); return p?.id && isId(p.id) ? String(p.id) : null; } catch { return null; }
}

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    res.set("Cache-Control", "public, max-age=60");
    ok(res, await unis.search(String(req.query.search || req.query.q || "").slice(0, 100), { limit }));
  } catch (err) {
    console.error("[universities] search", err?.message);
    fail(res, 500, "SERVER_ERROR", "Couldn't load universities");
  }
});

const MAX_REQUESTS = () => Math.max(1, Number(process.env.RATE_LIMIT_UNIVERSITY_REQUEST_MAX) || 5);
const requestLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: () => MAX_REQUESTS(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `uni-request:${optionalUser(req) || req.ip}`,
  handler: (req, res) => fail(res, 429, "RATE_LIMITED", "Too many requests. Try again in an hour, or pick your university from the list."),
});

router.post("/request", requestLimit, async (req, res) => {
  try {
    const userId = optionalUser(req);
    const r = await unis.request({ name: req.body?.name, city: req.body?.city, userId });
    if (r.match) return ok(res, { match: r.match, message: `Did you mean ${r.match.name}${r.match.city ? ` (${r.match.city})` : ""}?` });
    if (r.hidden) return fail(res, 409, "NOT_AVAILABLE", "This university can't be added. Pick one from the list or contact us.");
    ok(res, { university: r.university, created: r.created, message: "Thanks: we'll check it. You can continue with it now; it shows as pending review." }, r.created ? 201 : 200);
  } catch (err) {
    if (err.status) return fail(res, err.status, err.code, err.message);
    console.error("[universities] request", err?.message);
    fail(res, 500, "SERVER_ERROR", "Couldn't send your request");
  }
});

router.put("/mine", auth, async (req, res) => {
  try {
    if (req.isGuest || !isId(req.userId)) return fail(res, 401, "SIGN_IN", "Sign in first");
    const id = req.body?.universityId;
    if (!isId(id)) return fail(res, 400, "UNIVERSITY_REQUIRED", "Pick your university");
    const u = await University.findById(id).lean();
    // approved, or a pending one (the student just asked for it); never a hidden / old unmatched entry
    if (!u || !["approved", "pending"].includes(u.status)) return fail(res, 400, "UNIVERSITY_NOT_AVAILABLE", "Pick a university from the list");
    const me = await User.findById(req.userId).select("role university").lean();
    if (!me || me.role !== "student") return fail(res, 403, "STUDENTS_ONLY", "Only students have a university");
    await User.updateOne({ _id: req.userId }, { $set: { university: u._id, universityName: u.name } });
    await unis.recount([me.university, u._id]);
    ok(res, { university: unis.view(u) });
  } catch (err) {
    console.error("[universities] mine", err?.message);
    fail(res, 500, "SERVER_ERROR", "Couldn't save your university");
  }
});

module.exports = router;
