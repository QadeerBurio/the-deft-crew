// routes/publicConfession.routes.js
// P4c confession page, mounted at /c (the portal forwards gettdc.pk/c/* here, like /r/). No sign-in.
//   GET /c/<id>   a shared confession's text (services/confessionShare.js); the same "not available" page for an
//                 unknown id, a confession never shared, campus-only, held / hidden / removed, with an open report, or
//                 whose latest sharer no longer has the flag
// Headers like the resume page: noindex, no-store, no referrer, a CSP without scripts, rate-limited per visitor (the
// real visitor behind the portal only with PORTAL_PROXY_SECRET: services/clientAddress.js).
const express = require("express");
const rateLimit = require("express-rate-limit");
const share = require("../services/confessionShare");

const router = express.Router();
const pageLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: () => Math.max(1, Number(process.env.RATE_LIMIT_CONFESSION_PAGE_MAX) || 120),
  standardHeaders: "draft-7", legacyHeaders: false, validate: false,
  keyGenerator: (req) => `confession-page:${require("../services/clientAddress").visitorAddress(req)}`,
  handler: (req, res) => res.status(429).type("text/plain").send("too many requests. try again in a minute."),
});
const headers = (res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
};
const notFound = (res) => { headers(res); return res.status(404).type("html").send(share.notFoundHtml()); };

router.get("/:id", pageLimit, async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[0-9a-f]{24}$/i.test(id)) return notFound(res);
  try {
    const c = await share.forPage(id);
    if (!c) return notFound(res);
    headers(res);
    return res.status(200).type("html").send(share.pageHtml(c));
  } catch (e) {
    console.error("[confession-page]", e.message);
    return notFound(res);
  }
});

module.exports = router;
