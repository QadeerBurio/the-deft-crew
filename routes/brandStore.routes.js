// routes/brandStore.routes.js: a brand connects its own online store (WooCommerce for now).
//   GET    /api/brand/store                     status (always answers; enabled: false while switched off)
//   POST   /api/brand/store/woocommerce/start   { storeUrl } -> { authorizeUrl } (WooCommerce's app authorisation)
//   POST   /api/brand/store/woocommerce/callback  WooCommerce posts the new keys here (no login; one-time state)
//   POST   /api/brand/store/woocommerce/manual  { storeUrl, consumerKey, consumerSecret } (fallback)
//   POST   /api/brand/store/test                check keys and the order webhook again
//   DELETE /api/brand/store                     disconnect: webhook removed, keys forgotten, platform "none"
// Everything but status and disconnect needs STORE_CONNECT_ENABLED=true and STORE_CREDENTIALS_KEY.
// No response ever holds a key or secret.
const express = require("express");
const crypto = require("crypto");
const { rateLimit } = require("express-rate-limit");
const auth = require("../middleware/auth.middleware");
const BrandStoreConnection = require("../models/BrandStoreConnection");
const Offer = require("../models/Offer");
const box = require("../utils/secretBox");
const { normalizeStoreUrl } = require("../utils/safeHttp");
const woo = require("../services/wooStore");

const router = express.Router();
const STATE_TTL_MS = 15 * 60 * 1000;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",").pop().trim() || req.ip || "unknown";

const brandLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: () => Number(process.env.STORE_CONNECT_RATE_LIMIT) || 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `brand:${req.userId || clientIp(req)}`,
  message: { success: false, message: "Too many attempts. Try again in a few minutes." },
});
const callbackLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: () => Number(process.env.STORE_CALLBACK_RATE_LIMIT) || 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { success: false, message: "Too many requests" },
});

function brandOnly(req, res, next) {
  if (req.isGuest || req.user?.role !== "brand") return res.status(403).json({ success: false, message: "Only brand accounts can connect a store" });
  next();
}
function switchedOn(req, res, next) {
  if (!woo.enabled()) return res.status(503).json({ success: false, message: "Online store connections aren't switched on yet" });
  if (!box.hasKey()) return res.status(503).json({ success: false, message: "Online store connections aren't set up on the server yet" });
  next();
}
const fail = (res, err) => {
  if (err instanceof woo.StoreError) return res.status(err.status).json({ success: false, message: err.message });
  console.error("[brand store] error:", err.message);
  return res.status(500).json({ success: false, message: "Something went wrong. Try again." });
};

async function statusPayload(brandId, conn) {
  const onlineOffers = await Offer.countDocuments({ brand: brandId, isOnline: true });
  return { success: true, enabled: woo.enabled() && box.hasKey(), connection: woo.publicView(conn), onlineOffers };
}

router.get("/", auth, brandOnly, async (req, res) => {
  try {
    const conn = await BrandStoreConnection.findOne({ brand: req.userId });
    res.json(await statusPayload(req.userId, conn && conn.status !== "disconnected" ? conn : null));
  } catch (err) {
    fail(res, err);
  }
});

// step 1: check the address, then send the brand to WooCommerce to approve the keys
router.post("/woocommerce/start", auth, brandOnly, switchedOn, brandLimit, async (req, res) => {
  try {
    const n = normalizeStoreUrl(req.body?.storeUrl);
    if (n.error) return res.status(400).json({ success: false, message: n.error });
    const existing = await BrandStoreConnection.findOne({ brand: req.userId });
    if (existing && (existing.status === "connected" || existing.status === "error")) {
      return res.status(409).json({ success: false, message: "A store is already connected. Disconnect it first." });
    }
    await woo.detectWoo(n.url);

    const state = crypto.randomBytes(24).toString("hex");
    const conn = await BrandStoreConnection.findOneAndUpdate(
      { brand: req.userId },
      {
        $set: { platform: "woocommerce", storeUrl: n.url, status: "pending", connectMethod: "wc-auth", stateHash: sha256(state), stateExpiresAt: new Date(Date.now() + STATE_TTL_MS), lastError: "" },
        $setOnInsert: { brand: req.userId },
      },
      { upsert: true, new: true }
    );
    const params = new URLSearchParams({
      app_name: "tdc",
      scope: "read_write",
      user_id: `${conn._id}.${state}`,
      return_url: `${woo.portalBase()}/settings?store=woocommerce`,
      callback_url: `${woo.publicBase()}/api/brand/store/woocommerce/callback`,
    });
    res.json({ success: true, authorizeUrl: `${n.url}/wc-auth/v1/authorize?${params}` });
  } catch (err) {
    fail(res, err);
  }
});

// step 2: WooCommerce posts { key_id, user_id, consumer_key, consumer_secret, key_permissions }.
// Answer fast (WooCommerce waits for it before sending the brand back); test + webhook run after.
const NOT_ACCEPTED = { success: false, message: "Not accepted" };
router.post("/woocommerce/callback", callbackLimit, switchedOn, async (req, res) => {
  try {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const [connId, state] = String(b.user_id || "").split(".");
    if (!/^[a-f0-9]{24}$/.test(connId || "") || !/^[a-f0-9]{48}$/.test(state || "")) return res.status(400).json(NOT_ACCEPTED);
    if (!woo.KEY_RE.test(String(b.consumer_key || "")) || !woo.SECRET_RE.test(String(b.consumer_secret || "")) || b.key_permissions !== "read_write") {
      return res.status(400).json(NOT_ACCEPTED);
    }
    // one-time: the state is cleared in the same update that stores the keys
    const conn = await BrandStoreConnection.findOneAndUpdate(
      { _id: connId, status: "pending", stateHash: sha256(state), stateExpiresAt: { $gt: new Date() } },
      {
        $set: {
          keyEnc: box.seal(b.consumer_key),
          secretEnc: box.seal(b.consumer_secret),
          wcKeyId: Number.isFinite(Number(b.key_id)) ? Number(b.key_id) : null,
          keyPermissions: "read_write",
          stateHash: "",
          stateExpiresAt: null,
        },
      },
      { new: true }
    );
    if (!conn) return res.status(400).json(NOT_ACCEPTED);
    res.json({ success: true });
    setImmediate(() => woo.finalize(conn._id).catch((e) => console.error("[brand store] finalize failed:", e.message)));
  } catch (err) {
    console.error("[brand store] callback error:", err.message);
    res.status(400).json(NOT_ACCEPTED);
  }
});

// fallback: keys made by hand in WooCommerce > Settings > Advanced > REST API (Read/Write)
router.post("/woocommerce/manual", auth, brandOnly, switchedOn, brandLimit, async (req, res) => {
  try {
    const n = normalizeStoreUrl(req.body?.storeUrl);
    if (n.error) return res.status(400).json({ success: false, message: n.error });
    const key = String(req.body?.consumerKey || "").trim();
    const secret = String(req.body?.consumerSecret || "").trim();
    if (!woo.KEY_RE.test(key) || !woo.SECRET_RE.test(secret)) {
      return res.status(400).json({ success: false, message: "The key starts with ck_ and the secret with cs_, each followed by 40 characters" });
    }
    const existing = await BrandStoreConnection.findOne({ brand: req.userId });
    if (existing && (existing.status === "connected" || existing.status === "error")) {
      return res.status(409).json({ success: false, message: "A store is already connected. Disconnect it first." });
    }
    await woo.detectWoo(n.url);
    await woo.testKeys(n.url, { key, secret }); // nothing is stored if the keys don't work
    const conn = await BrandStoreConnection.findOneAndUpdate(
      { brand: req.userId },
      {
        $set: { platform: "woocommerce", storeUrl: n.url, status: "pending", connectMethod: "manual", keyEnc: box.seal(key), secretEnc: box.seal(secret), wcKeyId: null, keyPermissions: "", stateHash: "", stateExpiresAt: null, lastError: "" },
        $setOnInsert: { brand: req.userId },
      },
      { upsert: true, new: true }
    );
    const done = await woo.finalize(conn._id);
    res.status(done.status === "connected" ? 200 : 502).json({ ...(await statusPayload(req.userId, done)), success: done.status === "connected", message: done.status === "connected" ? "Store connected" : done.lastError });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/test", auth, brandOnly, switchedOn, brandLimit, async (req, res) => {
  try {
    const conn = await BrandStoreConnection.findOne({ brand: req.userId, status: { $in: ["connected", "error"] } });
    if (!conn) return res.status(404).json({ success: false, message: "No store is connected" });
    const done = await woo.recheck(conn);
    res.json({ ...(await statusPayload(req.userId, done)), success: done.status === "connected", message: done.status === "connected" ? "Connection works" : done.lastError });
  } catch (err) {
    fail(res, err);
  }
});

// always allowed (also while switched off), so a brand can always remove its keys
router.delete("/", auth, brandOnly, async (req, res) => {
  try {
    const conn = await BrandStoreConnection.findOne({ brand: req.userId, status: { $ne: "disconnected" } });
    if (!conn) return res.status(404).json({ success: false, message: "No store is connected" });
    const { webhookRemoved } = await woo.disconnect(conn);
    res.json({
      ...(await statusPayload(req.userId, null)),
      webhookRemoved,
      message: "Disconnected. Also delete the tdc key in WooCommerce > Settings > Advanced > REST API.",
    });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
