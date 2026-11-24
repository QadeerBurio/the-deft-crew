// services/confessionShare.js
// P4c (flags confessionsV2 + confessionShare): share a confession as an image card, with its gettdc.pk/c/<id> page.
// Owner rules: public confessions only; not campus-only, held, hidden, removed, or with an open report on it; no handle
// on the card or the page. The page is text only (no comments, no image, no campus, no handle), noindex, and shows only
// while the confession still passes the rules and the latest sharer still has the flag.
//   refusal(c, { openReport })  → null (may be shared) | { status, code, message }
//   openReports(ids)            → Set of confession ids with a pending / under-review report on the confession itself
//   pageUrl(id)                 → https://gettdc.pk/c/<id> (PORTAL_URL)
//   pageHtml(c) / notFoundHtml()
const Confession = require("../models/Confession");

const isLive = (c) => !!c && (!c.status || c.status === "live");

async function openReports(ids) {
  if (!ids?.length) return new Set();
  const Report = require("../models/Report");
  const rows = await Report.find({ contentType: "Confession", contentId: { $in: ids }, status: { $in: ["pending", "under_review"] }, $or: [{ commentId: null }, { commentId: { $exists: false } }] }).select("contentId").lean();
  return new Set(rows.map((r) => String(r.contentId)));
}

function refusal(c, { openReport = false } = {}) {
  if (!isLive(c)) return { status: 404, code: "NOT_FOUND", message: "this confession isn't available." };
  if (c.visibility === "campus") return { status: 409, code: "CAMPUS_ONLY", message: "campus-only confessions stay on campus." };
  if (openReport) return { status: 409, code: "UNDER_REVIEW", message: "this confession can't be shared while it's being reviewed." };
  return null;
}

const pageUrl = (id) => `${String(process.env.PORTAL_URL || "https://gettdc.pk").replace(/\/$/, "")}/c/${id}`;
const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const PLAY = "https://play.google.com/store/apps/details?id=com.aqkhan110.tdc";
const APPLE = "https://apps.apple.com/app/id6765877675";
const HEAD = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>
  body { margin: 0; background: #111111; color: #FFFFFF; font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; }
  main { max-width: 480px; margin: 0 auto; padding: 32px 16px 48px; }
  .logo { display: inline-block; background: #F9C349; color: #111111; font-weight: 800; padding: 6px 12px; border-radius: 12px; }
  blockquote { margin: 28px 0 8px; font-size: 22px; line-height: 1.4; font-weight: 700; white-space: pre-wrap; overflow-wrap: anywhere; }
  .muted { color: #BDBAB2; font-size: 14px; }
  a.btn { display: block; text-align: center; min-height: 48px; line-height: 48px; border-radius: 24px; font-weight: 700; text-decoration: none; margin-top: 12px; }
  .primary { background: #F9C349; color: #111111; }
  .secondary { background: #2A2A2A; color: #FFFFFF; }
</style></head>`;

function pageHtml(c) {
  const id = String(c._id);
  return `${HEAD("a confession on tdc")}<body><main>
<span class="logo" aria-label="tdc">tdc</span>
<blockquote>&ldquo;${esc(String(c.text || "").slice(0, 1000))}&rdquo;</blockquote>
<p class="muted">sent from tdc confessions. anonymous: nobody knows who wrote it.</p>
<a class="btn primary" href="tdcapp://confession/${esc(id)}">read the replies in the app</a>
<a class="btn secondary" href="${PLAY}" rel="noopener">get tdc on google play</a>
<a class="btn secondary" href="${APPLE}" rel="noopener">get tdc on the app store</a>
</main></body></html>`;
}

function notFoundHtml() {
  return `${HEAD("not available · tdc")}<body><main>
<span class="logo" aria-label="tdc">tdc</span>
<h1 style="font-size:24px;margin:24px 0 8px;">this confession isn't available</h1>
<p class="muted">it may have been removed, or it's only for its campus.</p>
<a class="btn secondary" href="${PLAY}" rel="noopener">get tdc on google play</a>
<a class="btn secondary" href="${APPLE}" rel="noopener">get tdc on the app store</a>
</main></body></html>`;
}

/** the confession for its page, or null (the page shows "not available") */
async function forPage(id) {
  const c = await Confession.findById(id).select("+sharedBy text visibility status sharedAt").lean();
  if (!c || !c.sharedAt || refusal(c)) return null;
  if ((await openReports([c._id])).size) return null;
  const sharer = c.sharedBy ? String(c.sharedBy) : null;
  const flags = require("../config/featureFlags");
  if (!sharer || !flags.isEnabled("confessionsV2", { id: sharer, role: "student" }) || !flags.isEnabled("confessionShare", { id: sharer, role: "student" })) return null;
  return c;
}

module.exports = { refusal, openReports, pageUrl, pageHtml, notFoundHtml, forPage };
