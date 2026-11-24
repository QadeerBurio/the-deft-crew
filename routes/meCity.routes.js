// routes/meCity.routes.js — P5b "is your city right?" (flag cityCheck; signed-in students; off: 404, as if absent).
// Mounted at /api/me.
//   POST /api/me/city { confirm: true }   → the city stays, cityConfirmedAt = now
//   POST /api/me/city { city: "Lahore" }  → the city is set (2-60 letters, spaces, dots, hyphens), cityConfirmedAt = now
//   → 200 { city, cityConfirmedAt }
// An old account may still carry the old automatic "Karachi" (before P3b every new student got it): the app asks once,
// and this records the answer. Nothing else on the account changes.
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const flags = require("../config/featureFlags");

const router = express.Router();
const guest = (req) => !!req.isGuest || req.userId === "guest-user";
const meOf = (req) => String(req.user?._id || req.userId || "");
const notFound = (res) => res.status(404).json({ error: "Not found", message: "Not found" });
const bad = (res, message) => res.status(400).json({ error: message, message });
const CITY = /^[\p{L}][\p{L} .'-]{1,59}$/u;

router.post("/city", auth, async (req, res) => {
  try {
    const id = meOf(req);
    if (guest(req) || !mongoose.Types.ObjectId.isValid(id) || !flags.isEnabled("cityCheck", { id, role: req.userRole })) return notFound(res);
    const user = await User.findById(id).select("role city").lean();
    if (!user || user.role !== "student") return notFound(res);
    const body = req.body || {};
    let city = user.city || "";
    if (body.confirm === true) {
      if (!city) return bad(res, "pick your city first.");
    } else {
      city = typeof body.city === "string" ? body.city.replace(/\s+/g, " ").trim() : "";
      if (!CITY.test(city)) return bad(res, "that doesn't look like a city name.");
    }
    // only these two fields are written (no full-document save: an old account's other fields stay as they are)
    const cityConfirmedAt = new Date();
    await User.updateOne({ _id: id }, { $set: { city, cityConfirmedAt } });
    res.json({ city, cityConfirmedAt });
  } catch (e) {
    console.error("[me-city]", e.message);
    res.status(500).json({ error: "something went wrong. try again.", message: "something went wrong. try again." });
  }
});

module.exports = router;
