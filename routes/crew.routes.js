// routes/crew.routes.js
// Plan P2: the ambassador programme for students, mounted at /api/crew (next to /api/admin/crew). Flag ambassadorV2 per
// student (off: 404, as if the routes didn't exist); the weekly squad mission has its own flag squadMission.
//   GET  /invitation                 → { show, moment? }   P2-1 (server decides; records that it was shown)
//   POST /invitation  { answer }     more | not_now | never
//   POST /applications { why, whyChips?, groups?, handle? }    P2-3 (5 an hour)
//   GET  /applications/me            { status: none | pending | approved | rejected, appliedAt, reviewedAt, reviewNote }
//   GET  /campus-count               { count, university }  approved ambassadors at your university
//   GET  /me                         the ambassador hub (approved only): invites, rank, campaigns, credentials
//   GET  /daily-card                 today's campaign to share, or { card: null }
//   POST /credentials/:id/link       → { url } a 10-minute link to the PDF (the app opens it in the browser)
//   GET  /credentials/:id/pdf?t=     the PDF (your own issued credential, with the link's token or your sign-in)
//   POST /moments { caption, imageUrl }   a campus moment (photo + caption) → admin Crew Inbox (image moderated)
//   GET  /squad                      the weekly "bring your squad" progress (flag squadMission)
//   GET  /verify/:id                 PUBLIC, rate-limited: name, role, university, dates, valid / revoked
//   GET  /config                     PUBLIC: { applyInApp } for the web /ambassador page
const express = require("express");
const jwt = require("jsonwebtoken");
const { rateLimit } = require("express-rate-limit");
const auth = require("../middleware/auth.middleware");
const { perUser } = require("../utils/userRateLimit");
const { isEnabled } = require("../config/featureFlags");
const crew = require("../services/crew/ambassador");
const certificate = require("../services/crew/certificate");

const router = express.Router();
const isId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message, error: message });
const ok = (res, data) => res.json({ success: true, data });
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof crew.CrewError) return fail(res, e.status, e.code, e.message);
    console.error("[crew]", e.message);
    return fail(res, 500, "SERVER_ERROR", "something went wrong. try again.");
  }
};
const signedIn = (req, res, next) => (req.isGuest || !isId(req.userId) ? fail(res, 401, "SIGN_IN", "sign in first") : next());
const flag = (name) => (req, res, next) => (isEnabled(name, { id: String(req.userId), role: req.userRole || "student" }) ? next() : fail(res, 404, "NOT_FOUND", "not found"));
const v2 = [auth, signedIn, flag("ambassadorV2")];

// ---------- public: verify a credential (the QR on the PDF) ----------
const verifyLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: () => Math.max(1, Number(process.env.RATE_LIMIT_CREDENTIAL_VERIFY_MAX) || 30),
  standardHeaders: "draft-7", legacyHeaders: false, validate: false,
  keyGenerator: (req) => `credential-verify:${require("../services/loginGuard").clientIp(req)}`,
  handler: (req, res) => fail(res, 429, "RATE_LIMITED", "too many checks. try again in a few minutes."),
});
router.get("/verify/:id", verifyLimit, handle(async (req, res) => {
  const Credential = require("../models/Credential");
  const c = isId(req.params.id) ? await Credential.findOne({ _id: req.params.id, status: { $in: ["issued", "revoked"] } }).lean() : null;
  if (!c) return fail(res, 404, "NOT_FOUND", "no credential with this id.");
  const f = await certificate.facts(c);
  ok(res, { id: f.id, type: c.type, name: f.name, role: f.role, university: f.university, since: f.since, issuedAt: f.issuedAt, status: f.status, revokedAt: f.status === "revoked" ? f.revokedAt : null });
}));

// ---------- public: may the web /ambassador page send students to the app? ----------
// ambassadorV2 as for nobody in particular: on only when FLAG_AMBASSADOR_V2 is "on" for everyone (per-account rules
// can't apply before sign-in). Off: the web page keeps today's form.
router.get("/config", require("../middleware/publicLimit")("crew-config", "RATE_LIMIT_PUBLIC_CONFIG_MAX", 120), (req, res) => { // r8: public, per address
  res.set("Cache-Control", "public, max-age=60");
  res.json({ applyInApp: isEnabled("ambassadorV2", null) });
});

// ---------- P2-1 invitation ----------
router.get("/invitation", ...v2, handle(async (req, res) => ok(res, await crew.invitation(req.userId))));
router.post("/invitation", ...v2, handle(async (req, res) => ok(res, await crew.answer(req.userId, req.body?.answer))));

// ---------- P2-3 application ----------
router.post("/applications", ...v2, perUser("crew_apply"), handle(async (req, res) => ok(res, await crew.apply(req.userId, req.body || {}))));
router.get("/applications/me", ...v2, handle(async (req, res) => ok(res, await crew.status(req.userId))));
router.get("/campus-count", ...v2, handle(async (req, res) => ok(res, await crew.campusCount(req.userId))));

// ---------- P2-5 hub ----------
router.get("/me", ...v2, handle(async (req, res) => ok(res, await crew.hub(req.userId))));
router.get("/daily-card", ...v2, handle(async (req, res) => ok(res, { card: await crew.dailyCard(req.userId) })));

async function ownIssued(id, userId) {
  if (!isId(id)) return null;
  const c = await require("../models/Credential").findOne({ _id: id, user: userId, status: "issued" }).lean();
  return c && certificate.printable(c) ? c : null;
}
router.post("/credentials/:id/link", ...v2, handle(async (req, res) => {
  const c = await ownIssued(req.params.id, req.userId);
  if (!c) return fail(res, 404, "NOT_FOUND", "no printable credential with this id.");
  const t = jwt.sign({ cred: String(c._id), user: String(req.userId), purpose: "credential-pdf" }, process.env.JWT_SECRET, { expiresIn: "10m" });
  const base = String(process.env.PUBLIC_BASE_URL || "https://the-deft-crew-production.up.railway.app").replace(/\/$/, "");
  ok(res, { url: `${base}/api/crew/credentials/${c._id}/pdf?t=${encodeURIComponent(t)}`, expiresInSeconds: 600 });
}));
router.get("/credentials/:id/pdf", require("../middleware/publicLimit")("credential-pdf", "RATE_LIMIT_CREDENTIAL_PDF_MAX", 30), handle(async (req, res) => { // r8: signed link, per-address limit
  let userId = null;
  if (req.query.t) {
    try {
      const d = jwt.verify(String(req.query.t), process.env.JWT_SECRET);
      if (d.purpose === "credential-pdf" && d.cred === String(req.params.id)) userId = d.user;
    } catch { userId = null; }
  }
  if (!userId) return fail(res, 401, "LINK_EXPIRED", "this link has expired. open it again from the app.");
  if (!isEnabled("ambassadorV2", { id: String(userId), role: "student" })) return fail(res, 404, "NOT_FOUND", "not found");
  const c = await ownIssued(req.params.id, userId);
  if (!c) return fail(res, 404, "NOT_FOUND", "no printable credential with this id.");
  const pdf = await certificate.render(c);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="tdc-${c.type}-${c._id}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.end(pdf);
}));

// ---------- P2-5 campus moments ----------
router.post("/moments", ...v2, perUser("crew_moment"), handle(async (req, res) => {
  if (!(await crew.isAmbassador(req.userId))) return fail(res, 403, "NOT_AMBASSADOR", "campus moments are for approved ambassadors.");
  const caption = String(req.body?.caption || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const imageUrl = String(req.body?.imageUrl || "").trim();
  if (!/^https:\/\/res\.cloudinary\.com\//.test(imageUrl)) return fail(res, 400, "PHOTO_REQUIRED", "add a photo.");
  if (caption.length < 3) return fail(res, 400, "CAPTION_REQUIRED", "add a caption.");
  // the photo and caption go through the confession image / text moderation (P4-1)
  const check = await require("../services/confessionCheck").check({ text: caption, image: imageUrl });
  if (check.verdict === "edit" || check.verdict === "selfharm") {
    setImmediate(() => require("../services/confessionImages").deleteImage(imageUrl, "campus moment blocked").catch(() => {}));
    return res.status(422).json({ success: false, code: "NEEDS_EDIT", reasons: check.reasons, message: "this photo or caption can't be posted. change it and try again.", error: "this photo or caption can't be posted. change it and try again." });
  }
  const PartnerPost = require("../models/PartnerPost");
  const post = await PartnerPost.create({ user: req.userId, kind: "moment", caption, imageUrl, status: "pending" });
  ok(res, { id: String(post._id), status: "pending", held: check.verdict === "hold" });
}));

// ---------- P2-7 bring your squad ----------
router.get("/squad", auth, signedIn, flag("squadMission"), handle(async (req, res) => {
  const squad = require("../services/crew/squad");
  await squad.evaluate(req.userId);
  ok(res, await squad.progress(req.userId));
}));

module.exports = router;
