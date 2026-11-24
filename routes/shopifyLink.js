const { createHash, randomBytes } = require("node:crypto");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const Ticket = require("../models/ShopifyLinkTicket");

const shopPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const opaquePattern = /^[a-f0-9]{64}$/;
const pathPrefix = "/api/shopify-app/link-shop/connect/";
const cookieName = "tdcShopifyLink";
// How long a connection link from Shopify Admin stays usable. Long enough to look up test credentials
// and sign in without the link expiring; still short-lived and single-use.
const LINK_TTL_MS = 30 * 60 * 1000;
// The app's handle in the Shopify Partner Dashboard (shopify.app.toml `handle`).
const DEFAULT_APP_HANDLE = "the-deft-crew-student-deals";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("hex");

function browserOrigin() {
  const url = new URL(process.env.SHOPIFY_CONNECT_ORIGIN);
  if (url.protocol !== "https:" || url.href !== url.origin + "/") {
    throw new Error("SHOPIFY_CONNECT_ORIGIN must be an HTTPS origin");
  }
  return url.origin;
}

// https://admin.shopify.com/store/<store>/apps/<handle>: where the merchant returns after connecting.
// `shop` is always a validated <store>.myshopify.com domain (shopPattern).
function shopifyAdminUrl(shop) {
  if (!shopPattern.test(shop || "")) return null;
  const configured = process.env.SHOPIFY_APP_HANDLE;
  const handle = /^[a-z0-9-]+$/.test(configured || "") ? configured : DEFAULT_APP_HANDLE;
  return "https://admin.shopify.com/store/" + shop.slice(0, -".myshopify.com".length) + "/apps/" + handle;
}

function browserCookie(req) {
  const value = req.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  return opaquePattern.test(value || "") ? value : null;
}

const authorizedBrand = (id) => ({
  _id: id,
  role: "brand",
  brandApprovalStatus: "approved",
  accountStatus: { $nin: ["suspended", "banned", "deactivated"] },
  emailVerified: { $ne: false },
  isBlocked: { $ne: true },
});

class LinkError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function route(handler) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof LinkError) return res.status(error.status).json({ error: error.message });
      if (error.code === 11000) return res.status(409).json({ error: "This Shopify store already has a brand connection." });
      console.error("[shopify-app] link request failed", error.name);
      return res.status(503).json({ error: "TDC is temporarily unavailable. Try again from Shopify Admin." });
    }
  };
}

function ticketId(req) {
  if (!opaquePattern.test(req.params.ticket || "")) throw new LinkError(410, "Start a new connection from Shopify Admin.");
  return digest(req.params.ticket);
}

async function loadTicket(req, session) {
  const ticket = await Ticket.findById(ticketId(req)).session(session || null).lean();
  if (!ticket || ticket.redeemedAt || ticket.expiresAt <= new Date()) {
    throw new LinkError(410, "This link expired or was used. Start a new connection from Shopify Admin.");
  }
  return ticket;
}

function authenticatedBrowser(req) {
  const browser = browserCookie(req);
  if (req.get("Origin") !== browserOrigin() || !req.is("application/json") || !browser) {
    throw new LinkError(403, "Open the connection again from Shopify Admin.");
  }
  if (req.isGuest || !req.user?._id) throw new LinkError(401, "Sign in to your TDC brand account.");
  return digest(browser);
}

function registerShopifyLink(router, verifyApiKey) {
  router.post("/link-shop", verifyApiKey, (_req, res) =>
    res.status(410).json({ error: "Start the connection from Shopify Admin." }));

  router.post("/link-shop/start", verifyApiKey, route(async (req, res) => {
    const shop = req.body?.shop;
    if (typeof shop !== "string" || !shopPattern.test(shop)) throw new LinkError(400, "Invalid Shopify shop.");
    const origin = browserOrigin();
    if (await User.exists({ role: "brand", shopifyStoreUrl: shop })) {
      throw new LinkError(409, "This Shopify store already has a brand connection.");
    }
    const ticket = random();
    await Ticket.create({ _id: digest(ticket), shop, expiresAt: new Date(Date.now() + LINK_TTL_MS) });
    res.json({ authorizationUrl: origin + pathPrefix + ticket });
  }));

  // A person opens this URL in the browser, so failures are shown as a page, not raw JSON.
  router.get("/link-shop/connect/:ticket", route(async (req, res) => {
    const nonce = random();
    res.set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-" + nonce +
      "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    try {
      await loadTicket(req);
    } catch (error) {
      if (!(error instanceof LinkError)) throw error;
      // The shop is known while an expired or used ticket is still stored: offer the way back to it.
      const stored = opaquePattern.test(req.params.ticket || "")
        ? await Ticket.findById(digest(req.params.ticket)).select("shop redeemedAt").lean() : null;
      const adminUrl = shopifyAdminUrl(stored?.shop);
      const page = stored?.redeemedAt
        ? messagePage(nonce, "Store already connected", "This store connection is complete. Return to Shopify to continue in tdc.", adminUrl)
        : messagePage(nonce, "Link expired", "This connection link expired. Return to Shopify Admin, open tdc, and click Connect your TDC account again.", adminUrl);
      return res.status(error.status).type("html").send(page);
    }
    if (!browserCookie(req)) {
      res.cookie(cookieName, random(), {
        httpOnly: true, secure: true, sameSite: "lax", maxAge: LINK_TTL_MS,
        path: pathPrefix + req.params.ticket,
      });
    }
    res.type("html").send(connectionPage(nonce));
  }));

  router.post("/link-shop/connect/:ticket/session", auth, route(async (req, res) => {
    const browserDigest = authenticatedBrowser(req);
    const ticket = await loadTicket(req);
    const brand = await User.findOne(authorizedBrand(req.user._id)).select("brandName name").lean();
    if (!brand) throw new LinkError(403, "Use an approved TDC brand account with permission to connect its store.");
    const bound = await Ticket.updateOne({
      _id: ticket._id,
      expiresAt: { $gt: new Date() },
      redeemedAt: { $exists: false },
      $or: [
        { brandId: { $exists: false } },
        { brandId: brand._id, browserDigest },
      ],
    }, { $set: { brandId: brand._id, browserDigest } });
    if (!bound.matchedCount) throw new LinkError(409, "Start a new connection from Shopify Admin.");
    res.json({ shop: ticket.shop, brandId: String(brand._id), brandName: brand.brandName || brand.name });
  }));

  router.post("/link-shop/connect/:ticket/confirm", auth, route(async (req, res) => {
    const browserDigest = authenticatedBrowser(req);
    const brandId = req.body?.brandId;
    if (brandId !== String(req.user._id)) throw new LinkError(403, "You can only connect your own TDC brand.");
    let shop;
    await mongoose.connection.transaction(async (session) => {
      const ticket = await loadTicket(req, session);
      if (String(ticket.brandId) !== brandId || ticket.browserDigest !== browserDigest) {
        throw new LinkError(403, "Sign in again from the original connection page.");
      }
      const brand = await User.findOneAndUpdate({
        ...authorizedBrand(req.user._id),
        shopifyStoreUrl: { $in: ["", null, ticket.shop] },
      }, { $set: { shopifyStoreUrl: ticket.shop } }, { session, returnDocument: "after" });
      if (!brand) throw new LinkError(409, "Your brand no longer has permission or is connected to another store.");
      const redeemed = await Ticket.updateOne({
        _id: ticket._id, redeemedAt: { $exists: false }, expiresAt: { $gt: new Date() },
      }, { $set: { redeemedAt: new Date() } }, { session });
      if (!redeemed.matchedCount) throw new LinkError(410, "Start a new connection from Shopify Admin.");
      shop = ticket.shop;
    });
    res.json({ success: true, shop, shopifyAdminUrl: shopifyAdminUrl(shop) });
  }));
}

const pageStyle = (nonce) => `<style nonce="${nonce}">
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f6f7;color:#202223}
main{max-width:28rem;margin:3rem auto;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
h1{font-size:1.4rem;margin:0 0 1rem}label{display:block;margin:0 0 1rem}
input{display:block;box-sizing:border-box;width:100%;margin-top:.25rem;padding:.6rem;font:inherit;border:1px solid #8c9196;border-radius:8px}
button,.button{display:inline-block;padding:.65rem 1.1rem;font:inherit;font-weight:600;color:#fff;background:#008060;border:0;border-radius:8px;text-decoration:none;cursor:pointer}
button:disabled{opacity:.6;cursor:default}#status{color:#d72c0d}[hidden]{display:none!important}
@media (max-width:480px){main{margin:0;border-radius:0;min-height:100vh;padding:1.5rem 1rem}}
</style>`;

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function messagePage(nonce, title, message, adminUrl) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${pageStyle(nonce)}
<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
${adminUrl ? `<p><a class="button" href="${escapeHtml(adminUrl)}">Return to Shopify</a></p>` : ""}</main></html>`;
}

function connectionPage(nonce) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your TDC account</title>${pageStyle(nonce)}
<main><section id="start"><h1>Connect your TDC account</h1>
<form id="login">
<label>Email <input name="email" type="email" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button>Sign in</button></form>
<section id="review" hidden><p id="selection"></p><button id="confirm">Confirm store connection</button></section></section>
<section id="done" hidden><h1>Connected</h1><p id="doneText"></p>
<p><a id="back" class="button" href="https://admin.shopify.com/">Return to Shopify</a></p></section>
<p id="status" role="status"></p></main>
<script nonce="${nonce}">
const form = document.querySelector("#login");
const status = document.querySelector("#status");
const review = document.querySelector("#review");
const confirm = document.querySelector("#confirm");
let token, selected;
async function post(url, body, auth) {
  const headers = {"Content-Type": "application/json"};
  if (auth) headers.Authorization = "Bearer " + token;
  const response = await fetch(url, {method: "POST", headers, body: JSON.stringify(body)});
  if (response.status >= 500) throw new Error("TDC is temporarily unavailable. Try again shortly.");
  const data = await response.json().catch(() => ({}));
  if (data.needsVerification) throw new Error("This TDC account's email address isn't verified yet. Verify it in the tdc app, then sign in again.");
  if (!response.ok) throw new Error(data.error || data.message || "Try again from Shopify Admin.");
  return data;
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(form));
  const submit = form.querySelector("button");
  submit.disabled = true;
  status.textContent = "";
  try {
    ({token} = await post("/api/auth/login", fields, false));
    form.reset();
    selected = await post(location.pathname + "/session", {}, true);
    document.querySelector("#selection").textContent = "Connect " + selected.shop + " to " + selected.brandName + "?";
    form.hidden = true;
    review.hidden = false;
  } catch (error) {
    token = null;
    status.textContent = error.message;
  } finally { submit.disabled = false; }
});
confirm.addEventListener("click", async () => {
  confirm.disabled = true;
  status.textContent = "";
  try {
    const result = await post(location.pathname + "/confirm", {brandId: selected.brandId}, true);
    token = null;
    document.querySelector("#start").hidden = true;
    document.querySelector("#doneText").textContent = selected.shop + " is now connected to " + selected.brandName +
      ". Return to Shopify to open tdc and create your student discounts.";
    if (String(result.shopifyAdminUrl || "").startsWith("https://admin.shopify.com/store/")) {
      document.querySelector("#back").href = result.shopifyAdminUrl;
    }
    document.querySelector("#done").hidden = false;
  } catch (error) {
    status.textContent = error.message;
    confirm.disabled = false;
  }
});
</script></html>`;
}

module.exports = { registerShopifyLink, digest, shopPattern };
