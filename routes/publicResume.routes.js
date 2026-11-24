// routes/publicResume.routes.js
// P3d public resume page, mounted at /r (the portal forwards gettdc.pk/r/* here, like /i/). No sign-in.
//   GET /r/fonts/<file>   the OFL fonts the page uses (and their licences), cached for a year
//   GET /r/<link>         the page (services/publicResume.js); the same "not available" page for an unknown link, a page
//                         that is off, an owner without the flags, or an account that is suspended / banned / deleted
// Headers like the event ticket page: noindex, no-store, no referrer, a strict content security policy (no scripts at
// all; styles inline; fonts from here; images only https, for the photo), rate-limited per visitor. The visitor: the
// address the portal's forwarder passes, only when it proves itself with PORTAL_PROXY_SECRET (services/clientAddress.js).
const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { isEnabled } = require("../config/featureFlags");
const pub = require("../services/publicResume");

const router = express.Router();
const pageLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: () => Math.max(1, Number(process.env.RATE_LIMIT_RESUME_PAGE_MAX) || 120),
  standardHeaders: "draft-7", legacyHeaders: false, validate: false,
  keyGenerator: (req) => `resume-page:${require("../services/clientAddress").visitorAddress(req)}`, // the real visitor behind the portal (services/clientAddress.js)
  handler: (req, res) => res.status(429).type("text/plain").send("too many requests. try again in a minute."),
});
const headers = (res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
};
const notFound = (res) => { headers(res); return res.status(404).type("html").send(pub.notFoundHtml()); };
const CLOSED = new Set(["suspended", "banned", "deleted", "deactivated"]);

router.get("/fonts/:file", (req, res) => {
  const f = String(req.params.file || "");
  if (!pub.FONT_FILES.has(f) && !pub.LICENCES.has(f)) return res.status(404).type("text/plain").send("not found");
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Access-Control-Allow-Origin", "*");
  res.type(f.endsWith(".ttf") ? "font/ttf" : "text/plain; charset=utf-8");
  res.sendFile(path.join(pub.FONT_DIR, f));
});

router.get("/:slug", pageLimit, async (req, res) => {
  const slug = String(req.params.slug || "");
  if (!pub.SLUG.test(slug)) return notFound(res);
  try {
    const Resume = require("../models/Resume");
    const resume = await Resume.findOne({ "publicPage.slug": slug, "publicPage.on": true }).select("+publicPage.slug +publicPage.selfKey").lean();
    if (!resume) return notFound(res);
    const who = { id: String(resume.user), role: "student" };
    if (!isEnabled("resumeV2", who) || !isEnabled("resumePublicPage", who)) return notFound(res);
    const owner = await require("../models/User").findById(resume.user).select("accountStatus role").lean();
    if (!owner || CLOSED.has(String(owner.accountStatus || "").toLowerCase())) return notFound(res);
    let verified = null;
    if (resume.settings?.verifiedLine === true && isEnabled("resumeVerified", who)) verified = await require("../services/verifiedFacts").factsFor(resume.user).catch(() => null);
    const html = pub.pageHtml(resume, { verified });
    if (pub.countsAsView({ method: req.method, userAgent: req.get("user-agent"), selfKeyGiven: req.query.k, selfKey: resume.publicPage.selfKey, ip: require("../services/clientAddress").visitorAddress(req), slug })) {
      await Resume.updateOne({ _id: resume._id }, { $inc: { "publicPage.views": 1 } }).catch(() => {}); // a failed count never fails the page
    }
    headers(res);
    return res.status(200).type("html").send(html);
  } catch (e) {
    console.error("[resume-page]", e.message);
    return notFound(res);
  }
});

module.exports = router;
