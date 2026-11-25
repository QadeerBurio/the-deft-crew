// routes/invites.routes.js
// P1-2: the invite page (gettdc.pk/i/<CODE>, a static page in the portal) reports each open here. No sign-in.
//   POST /api/invites/:code/open { channel? }   channel: wa | ig | tt | copy | direct (anything else: unknown)
//   → { valid: true, firstName } when the code belongs to a student, else { valid: false }
// A valid open is written to ReferralClick (code, referrer, channel, user agent, and a salted hash of the address,
// never the address itself). At most 60 opens per address per 10 minutes (429), so the log can't be flooded and
// codes can't be tried in bulk. Nothing about the visitor is returned except whether the code is real.
const express = require("express");
const crypto = require("crypto");
const { rateLimit } = require("express-rate-limit");
const User = require("../models/User");
const ReferralClick = require("../models/ReferralClick");
const { clientIp } = require("../services/loginGuard");

const router = express.Router();
const CHANNELS = new Set(["wa", "ig", "tt", "copy", "direct"]);
const CODE = /^[A-Z0-9]{4,12}$/;
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";
// a salted, shortened hash: counts repeat opens from one address without keeping the address
const ipHash = (ip) => crypto.createHash("sha256").update(`${process.env.INVITE_IP_SALT || process.env.JWT_SECRET || "tdc-invites"}:${ip}`).digest("hex").slice(0, 32);

const limit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: () => Math.max(1, Number(process.env.RATE_LIMIT_INVITE_OPEN_MAX) || 60),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `invite-open:${clientIp(req)}`,
  validate: false,
  handler: (req, res) => res.status(429).json({ valid: false, code: "RATE_LIMITED" }),
});

// GET /api/invites/config → { enabled }: may a signed-out phone show the invite features (the "paste invite code"
// button at signup)? growthV2 as for nobody in particular: on only when FLAG_GROWTH_V2 is "on" for everyone (per-account
// rules can't apply before sign-in). Kept apart from GET /api/app/flags, whose reply stays exactly as before.
router.get("/config", require("../middleware/publicLimit")("invites-config", "RATE_LIMIT_PUBLIC_CONFIG_MAX", 120), (req, res) => { // r8: public, per address
  res.set("Cache-Control", "public, max-age=60");
  res.json({ enabled: require("../config/featureFlags").isEnabled("growthV2", null) });
});

router.post("/:code/open", limit, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    if (!CODE.test(code)) return res.json({ valid: false });
    const u = await User.findOne({ referralCode: code }).select("_id name role").lean();
    if (!u || (u.role && u.role !== "student")) return res.json({ valid: false });
    const raw = String(req.body?.channel || "").trim().toLowerCase();
    await ReferralClick.create({
      code,
      referrer: u._id,
      channel: CHANNELS.has(raw) ? raw : "unknown",
      userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
      ip: ipHash(clientIp(req)),
      at: new Date(),
    });
    res.json({ valid: true, firstName: firstName(u.name) });
  } catch (e) {
    console.error(`[invites] open failed (${e.name})`);
    res.status(500).json({ valid: false });
  }
});

module.exports = router;
