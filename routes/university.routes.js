// routes/university.routes.js — /api/universities: the shared university list (services/universities.js).
//   GET  /                    public: every approved university, A–Z, with short name, city and aliases (the dropdowns
//                             show it all and filter as the student types). ?search= narrows it on the server.
//                             Cached for a minute, so an admin's addition shows in the app and portal within a minute.
//   PUT  /mine                { universityId } signed-in student: their university (an approved one)
// Students can't add universities: only admins can (routes/adminUniversities.routes.js).
// Replies: { success: true, data } or { success: false, error: { code, message } }. Matching never reads this list.
const express = require("express");
const mongoose = require("mongoose");
const University = require("../models/University");
const User = require("../models/User");
const auth = require("../middleware/auth.middleware");
const unis = require("../services/universities");

const router = express.Router();
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

router.get("/", async (req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=60");
    const q = String(req.query.search || req.query.q || "").slice(0, 100);
    if (!q.trim()) return ok(res, await unis.all());
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 50));
    ok(res, await unis.search(q, { limit }));
  } catch (err) {
    console.error("[universities] list", err?.message);
    fail(res, 500, "SERVER_ERROR", "Couldn't load universities");
  }
});

router.put("/mine", auth, async (req, res) => {
  try {
    if (req.isGuest || !isId(req.userId)) return fail(res, 401, "SIGN_IN", "Sign in first");
    const id = req.body?.universityId;
    if (!isId(id)) return fail(res, 400, "UNIVERSITY_REQUIRED", "Pick your university");
    const u = await University.findById(id).lean();
    if (!u || u.status !== "approved") return fail(res, 400, "UNIVERSITY_NOT_AVAILABLE", "Pick a university from the list");
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
