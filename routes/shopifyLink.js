const { createHash, randomBytes } = require("node:crypto");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const Ticket = require("../models/ShopifyLinkTicket");

const shopPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const opaquePattern = /^[a-f0-9]{64}$/;
const pathPrefix = "/api/shopify-app/link-shop/connect/";
const cookieName = "tdcShopifyLink";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("hex");

function browserOrigin() {
  const url = new URL(process.env.SHOPIFY_CONNECT_ORIGIN);
  if (url.protocol !== "https:" || url.href !== url.origin + "/") {
    throw new Error("SHOPIFY_CONNECT_ORIGIN must be an HTTPS origin");
  }
  return url.origin;
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
    await Ticket.create({ _id: digest(ticket), shop, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    res.json({ authorizationUrl: origin + pathPrefix + ticket });
  }));

  router.get("/link-shop/connect/:ticket", route(async (req, res) => {
    await loadTicket(req);
    const nonce = random();
    if (!browserCookie(req)) {
      res.cookie(cookieName, random(), {
        httpOnly: true, secure: true, sameSite: "lax", maxAge: 10 * 60 * 1000,
        path: pathPrefix + req.params.ticket,
      });
    }
    res.set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-" + nonce +
      "'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
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
    });
    res.json({ success: true });
  }));
}

function connectionPage(nonce) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your TDC account</title>
<main><h1>Connect your TDC account</h1>
<form id="login">
<label>Email <input name="email" type="email" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button>Sign in</button></form>
<section id="review" hidden><p id="selection"></p><button id="confirm">Confirm store connection</button></section>
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
  const data = await response.json();
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
    await post(location.pathname + "/confirm", {brandId: selected.brandId}, true);
    token = null;
    review.hidden = true;
    status.textContent = "Store connected. Return to Shopify Admin, open Apps, and select tdc.";
  } catch (error) {
    status.textContent = error.message;
    confirm.disabled = false;
  }
});
</script></html>`;
}

module.exports = { registerShopifyLink, digest, shopPattern };
