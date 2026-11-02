// routes/storeWebhook.routes.js
// POST /api/webhooks/woocommerce/:connectionId: WooCommerce's own order webhook for a connected brand
// (registered by services/wooStore). Signed by WooCommerce: X-WC-Webhook-Signature = base64 HMAC-SHA256 of
// the raw body with the secret only that connection has. The body is never trusted for amounts: the order
// is read back from the store with the brand's keys, and only processing/completed orders count.
// Anything we don't act on still gets a 200, because WooCommerce switches a webhook off after repeated
// failures; unsigned or wrongly signed requests get a plain 401.
const express = require("express");
const crypto = require("crypto");
const { rateLimit } = require("express-rate-limit");
const BrandStoreConnection = require("../models/BrandStoreConnection");
const box = require("../utils/secretBox");
const woo = require("../services/wooStore");
const { recordWooOrder } = require("../services/storeOrders");

const router = express.Router();
const NOT_ACCEPTED = { success: false, message: "Not accepted" };

const hookLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: () => Number(process.env.STORE_WEBHOOK_RATE_LIMIT) || 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.headers["x-forwarded-for"] || "").split(",").pop().trim() || req.ip || "unknown",
  message: { success: false, message: "Too many requests" },
});

function signatureMatches(rawBody, secret, incoming) {
  if (typeof incoming !== "string" || !incoming || !rawBody) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(incoming.trim(), "base64");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

router.post("/:connectionId", hookLimit, async (req, res) => {
  try {
    // WooCommerce checks a new webhook with a form-encoded ping ("webhook_id=…") and needs a 2xx
    if (req.is("application/x-www-form-urlencoded") && req.body && req.body.webhook_id && Object.keys(req.body).length === 1) {
      return res.json({ success: true, ping: true });
    }
    if (!woo.configured()) return res.status(503).json({ success: false, message: "Not available" });
    if (!/^[a-f0-9]{24}$/.test(req.params.connectionId)) return res.status(401).json(NOT_ACCEPTED);

    const conn = await BrandStoreConnection.findOne({ _id: req.params.connectionId, status: { $in: ["connected", "error"] } }).select("+webhookSecretEnc +keyEnc +secretEnc");
    if (!conn || !conn.webhookSecretEnc) return res.status(401).json(NOT_ACCEPTED);
    if (!signatureMatches(req.rawBody, box.open(conn.webhookSecretEnc), req.headers["x-wc-webhook-signature"])) {
      return res.status(401).json(NOT_ACCEPTED);
    }

    const topic = String(req.headers["x-wc-webhook-topic"] || "");
    if (topic !== "order.updated" && topic !== "order.created") return res.json({ success: true, ignored: "topic" });
    const orderId = req.body?.id;
    if (!/^\d{1,20}$/.test(String(orderId ?? ""))) return res.json({ success: true, ignored: "no order id" });
    if (!(req.body.coupon_lines || []).length) return res.json({ success: true, ignored: "no coupon" });

    let order;
    try {
      order = await woo.getOrder(conn, orderId);
    } catch {
      order = null;
    }
    if (!order) return res.status(502).json({ success: false, message: "Could not read the order from the store" });
    const out = await recordWooOrder(conn.brand, order);
    res.json({ success: true, counted: out.counted, ...(out.ignored ? { ignored: out.ignored } : {}) });
  } catch (err) {
    console.error("[store webhook] error:", err.message);
    res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
});

module.exports = router;
