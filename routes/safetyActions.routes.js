// routes/safetyActions.routes.js
// The one-time links in the safety e-mail (plan P4-1b), mounted at /api/safety:
//   GET  /api/safety/action/:token   a small page: what the link does, and a button. Opening it changes nothing
//                                    (mail scanners open links on their own).
//   POST /api/safety/action/:token   does it, once: "blacklist" (ban the account, block its e-mail and phone from
//                                    signing up) or "restore" (active again, strikes and bans cleared).
// No sign-in: the link's secret is the permission. It works once and expires in 7 days. Every use is written to
// AdminActionLog (admin = the fixed "safety e-mail link" id, since no admin is signed in).
const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const SafetyAction = require("../models/SafetyAction");
const Blocklist = require("../models/Blocklist");
const User = require("../models/User");
const { hashToken } = require("../services/safetyAlerts");
const strikes = require("../services/confessionStrikes");
const actionLog = require("../services/adminActionLog");

const router = express.Router();
// AdminActionLog needs an admin id: clicks on an e-mail link are logged under this fixed id
const EMAIL_LINK_ADMIN = new mongoose.Types.ObjectId("000000000000000000000e11");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="font-family:Arial,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#111"><h2 style="text-transform:lowercase">${esc(title)}</h2>${body}</body></html>`;
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const normEmail = (e) => String(e || "").trim().toLowerCase();
const normPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.startsWith("92") ? `0${d.slice(2)}` : d; };

async function findLink(token) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(token || ""))) return { error: "this link isn't valid." };
  const a = await SafetyAction.findOne({ tokenHash: hashToken(token) }).lean();
  if (!a) return { error: "this link isn't valid." };
  if (a.usedAt) return { error: "this link was already used." };
  if (new Date(a.expiresAt) <= new Date()) return { error: "this link has expired." };
  return { a };
}

const WHAT = {
  blacklist: "ban this account and block its e-mail and phone number from signing up again",
  restore: "undo the suspension and the confession strikes, and make the account active again",
};

router.get("/action/:token", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { a, error } = await findLink(req.params.token);
    if (error) return res.status(410).type("html").send(page("safety link", `<p>${esc(error)}</p>`));
    res.type("html").send(page(`${a.action} this account?`, `<p>This will ${esc(WHAT[a.action])}.</p><p style="color:#555">reason in the e-mail: ${esc(a.reason || "")}</p>
<form method="post"><button type="submit" style="font-size:16px;padding:10px 18px">${esc(a.action)}</button></form>`));
  } catch (e) {
    console.error(`[safety] link page failed: ${e.name}`);
    res.status(500).type("html").send(page("safety link", "<p>something went wrong. try again.</p>"));
  }
});

router.post("/action/:token", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { a, error } = await findLink(req.params.token);
    if (error) return res.status(410).type("html").send(page("safety link", `<p>${esc(error)}</p>`));
    // one use: claim it first (a second click at the same moment finds it used)
    const claimed = await SafetyAction.findOneAndUpdate({ _id: a._id, usedAt: null }, { $set: { usedAt: new Date() } }, { new: true }).lean();
    if (!claimed) return res.status(410).type("html").send(page("safety link", "<p>this link was already used.</p>"));
    const u = await User.findById(a.user).select("email phone role accountStatus").lean();
    if (!u) return res.status(404).type("html").send(page("safety link", "<p>this account no longer exists.</p>"));
    const before = { accountStatus: u.accountStatus || "active" };
    if (a.action === "blacklist") {
      if (!require("../services/adminAccess").isAdminAccount(u)) await User.updateOne({ _id: u._id }, { $set: { accountStatus: "banned", suspensionReason: "confession safety: blacklisted" } });
      for (const [kind, value] of [["email", normEmail(u.email)], ["phone", normPhone(u.phone)]]) {
        if (!value) continue;
        try { await Blocklist.create({ kind, hash: sha(value), user: u._id, reason: String(a.reason || "").slice(0, 200) }); }
        catch (e) { if (e?.code !== 11000) throw e; } // already blocked
      }
    } else {
      await strikes.restore(u._id);
    }
    await actionLog.recordSafe({ admin: EMAIL_LINK_ADMIN, action: `safety.${a.action}`, targetType: "User", targetId: String(u._id), before, after: { accountStatus: a.action === "blacklist" && !require("../services/adminAccess").isAdminAccount(u) ? "banned" : "active" }, reason: `via safety e-mail link: ${a.reason || ""}`.slice(0, 300) });
    res.type("html").send(page("done", `<p>${a.action === "blacklist" ? "the account is banned and its e-mail and phone are blocked." : "the account is active again."}</p>`));
  } catch (e) {
    console.error(`[safety] link action failed: ${e.name}`);
    res.status(500).type("html").send(page("safety link", "<p>something went wrong. try again.</p>"));
  }
});

/** For signup: is this e-mail or phone blocked? */
async function isBlocked({ email, phone }) {
  const hashes = [];
  if (email) hashes.push({ kind: "email", hash: sha(normEmail(email)) });
  if (phone && normPhone(phone)) hashes.push({ kind: "phone", hash: sha(normPhone(phone)) });
  if (!hashes.length) return false;
  return !!(await Blocklist.findOne({ $or: hashes }).lean());
}

module.exports = router;
module.exports.isBlocked = isBlocked;
module.exports.EMAIL_LINK_ADMIN = EMAIL_LINK_ADMIN;
