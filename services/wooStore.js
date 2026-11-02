// services/wooStore.js
// A brand's WooCommerce store, through its own REST API (WooCommerce's built-in app authorisation gives us
// read/write keys). Every call goes through utils/safeHttp; keys are kept sealed (utils/secretBox) and only
// opened for the call. Nothing here returns or logs a key, secret or the store's raw error text.
const crypto = require("crypto");
const safeHttp = require("../utils/safeHttp");
const box = require("../utils/secretBox");
const BrandStoreConnection = require("../models/BrandStoreConnection");
const User = require("../models/User");

const enabled = () => String(process.env.STORE_CONNECT_ENABLED || "").trim().toLowerCase() === "true";
const configured = () => enabled() && box.hasKey();
const publicBase = () => String(process.env.PUBLIC_BASE_URL || "https://the-deft-crew-production.up.railway.app").replace(/\/$/, "");
const portalBase = () => String(process.env.BRAND_PORTAL_URL || "https://tdc-admin-portal.vercel.app").replace(/\/$/, "");
const webhookUrl = (connId) => `${publicBase()}/api/webhooks/woocommerce/${connId}`;
const KEY_RE = /^ck_[a-f0-9]{40}$/;
const SECRET_RE = /^cs_[a-f0-9]{40}$/;

// messages a brand can act on; never the store's own error text
const MSG = {
  unreachable: "We couldn't reach the store. Check the address and that the site is online.",
  notWoo: "WooCommerce wasn't found at this address. Check that WooCommerce is active and permalinks aren't set to \"Plain\".",
  keysRejected: "The store rejected the keys. Create new Read/Write keys in WooCommerce and connect again.",
  noWrite: "These keys can't create coupons. Use keys with Read/Write permission.",
  webhookFailed: "Connected, but the order webhook couldn't be added. Use \"test connection\" to try again.",
};

class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const api = (storeUrl, path) => `${storeUrl}/wp-json/wc/v3${path}`;

async function send(storeUrl, keys, method, path, { data, params } = {}) {
  try {
    return await safeHttp.request({ method, url: api(storeUrl, path), auth: keys ? { username: keys.key, password: keys.secret } : undefined, data, params });
  } catch (err) {
    if (err instanceof safeHttp.UnsafeUrlError) throw new StoreError(err.message);
    throw new StoreError(MSG.unreachable, 502);
  }
}

// is there a WooCommerce REST API at this address?
async function detectWoo(storeUrl) {
  let res;
  try {
    res = await safeHttp.request({ method: "GET", url: `${storeUrl}/wp-json/` });
  } catch (err) {
    if (err instanceof safeHttp.UnsafeUrlError) throw new StoreError(err.message);
    throw new StoreError(MSG.unreachable, 502);
  }
  const namespaces = res.status === 200 && res.data && Array.isArray(res.data.namespaces) ? res.data.namespaces : [];
  if (!namespaces.includes("wc/v3")) throw new StoreError(MSG.notWoo);
}

// do the keys work? (a coupon read; write permission is checked from wc-auth or on first coupon)
async function testKeys(storeUrl, keys) {
  const res = await send(storeUrl, keys, "GET", "/coupons", { params: { per_page: 1 } });
  if (res.status === 401 || res.status === 403) throw new StoreError(MSG.keysRejected);
  if (res.status === 404) throw new StoreError(MSG.notWoo);
  if (res.status !== 200) throw new StoreError(MSG.unreachable, 502);
}

async function keysOf(conn) {
  const doc = conn.keyEnc !== undefined && conn.secretEnc !== undefined ? conn : await BrandStoreConnection.findById(conn._id).select("+keyEnc +secretEnc");
  return { key: box.open(doc.keyEnc), secret: box.open(doc.secretEnc) };
}

async function deleteWebhookQuietly(conn, keys) {
  if (!conn.webhookId) return false;
  try {
    const res = await send(conn.storeUrl, keys, "DELETE", `/webhooks/${conn.webhookId}`, { params: { force: true } });
    return res.status === 200 || res.status === 404 || res.status === 410;
  } catch {
    return false;
  }
}

// the order.updated webhook, signed with a secret only this connection knows
async function registerWebhook(conn, keys) {
  await deleteWebhookQuietly(conn, keys);
  const secret = crypto.randomBytes(32).toString("hex");
  const res = await send(conn.storeUrl, keys, "POST", "/webhooks", {
    data: { name: "tdc: student discount orders", topic: "order.updated", delivery_url: webhookUrl(conn._id), secret, status: "active" },
  });
  if (res.status === 401 || res.status === 403) throw new StoreError(MSG.noWrite);
  if ((res.status !== 200 && res.status !== 201) || !res.data?.id) throw new StoreError(MSG.webhookFailed, 502);
  conn.webhookId = Number(res.data.id);
  conn.webhookSecretEnc = box.seal(secret);
  conn.webhookStatus = "active";
}

// keys are in place (sealed): test them, add the webhook, mark the brand connected
async function finalize(connId) {
  const conn = await BrandStoreConnection.findById(connId).select("+keyEnc +secretEnc +webhookSecretEnc");
  if (!conn) return null;
  const keys = await keysOf(conn);
  conn.lastCheckAt = new Date();
  try {
    await testKeys(conn.storeUrl, keys);
    await registerWebhook(conn, keys);
    conn.status = "connected";
    conn.lastError = "";
    conn.connectedAt = conn.connectedAt || new Date();
    await conn.save();
    await User.updateOne({ _id: conn.brand }, { $set: { platform: "woocommerce" } });
  } catch (err) {
    conn.status = "error";
    conn.lastError = err instanceof StoreError ? err.message : MSG.unreachable;
    if (conn.webhookStatus === "active" && !conn.webhookId) conn.webhookStatus = "error";
    await conn.save();
    await User.updateOne({ _id: conn.brand, platform: "woocommerce" }, { $set: { platform: "none" } });
  }
  return conn;
}

// check keys and webhook again (the "test connection" button)
async function recheck(conn) {
  const full = await BrandStoreConnection.findById(conn._id).select("+keyEnc +secretEnc +webhookSecretEnc");
  const keys = await keysOf(full);
  full.lastCheckAt = new Date();
  try {
    await testKeys(full.storeUrl, keys);
    let hook = full.webhookId ? await send(full.storeUrl, keys, "GET", `/webhooks/${full.webhookId}`) : null;
    if (!hook || hook.status !== 200 || hook.data?.status !== "active" || hook.data?.delivery_url !== webhookUrl(full._id)) {
      await registerWebhook(full, keys);
    } else {
      full.webhookStatus = "active";
    }
    full.status = "connected";
    full.lastError = "";
    await full.save();
    await User.updateOne({ _id: full.brand }, { $set: { platform: "woocommerce" } });
  } catch (err) {
    full.status = "error";
    full.lastError = err instanceof StoreError ? err.message : MSG.unreachable;
    await full.save();
    await User.updateOne({ _id: full.brand, platform: "woocommerce" }, { $set: { platform: "none" } });
  }
  return full;
}

// remove the webhook from the store (best effort), forget the keys, brand back to "none"
async function disconnect(conn) {
  const full = await BrandStoreConnection.findById(conn._id).select("+keyEnc +secretEnc +webhookSecretEnc");
  let webhookRemoved = false;
  if (full.keyEnc && full.secretEnc && box.hasKey()) {
    try {
      webhookRemoved = await deleteWebhookQuietly(full, await keysOf(full));
    } catch {
      webhookRemoved = false;
    }
  }
  full.keyEnc = "";
  full.secretEnc = "";
  full.webhookSecretEnc = "";
  full.stateHash = "";
  full.webhookStatus = "none";
  full.status = "disconnected";
  full.disconnectedAt = new Date();
  full.lastError = "";
  const wcKeyId = full.wcKeyId;
  full.wcKeyId = null;
  full.webhookId = null;
  await full.save();
  await User.updateOne({ _id: full.brand }, { $set: { platform: "none" } });
  return { conn: full, webhookRemoved, wcKeyId };
}

// ---------- coupons and orders (used by promo codes and the order webhook) ----------
async function connectedStore(brandId) {
  if (!configured()) return null;
  return BrandStoreConnection.findOne({ brand: brandId, status: "connected" }).select("+keyEnc +secretEnc");
}

// a single-use percentage coupon; { success, couponId } or { success: false, reason }
async function createCoupon(conn, { code, percent, expiresAt, description }) {
  try {
    const res = await send(conn.storeUrl, await keysOf(conn), "POST", "/coupons", {
      data: {
        code,
        discount_type: "percent",
        amount: String(percent),
        individual_use: true,
        usage_limit: 1,
        usage_limit_per_user: 1,
        date_expires: expiresAt ? new Date(expiresAt).toISOString() : null,
        description: description || "Student discount via tdc",
      },
    });
    if ((res.status === 200 || res.status === 201) && res.data?.id) return { success: true, couponId: String(res.data.id) };
    return { success: false, reason: res.status === 401 || res.status === 403 ? "keys_rejected" : `store_status_${res.status}` };
  } catch {
    return { success: false, reason: "store_unreachable" };
  }
}

async function deleteCoupon(conn, couponId) {
  if (!couponId) return false;
  try {
    const res = await send(conn.storeUrl, await keysOf(conn), "DELETE", `/coupons/${encodeURIComponent(couponId)}`, { params: { force: true } });
    return res.status === 200 || res.status === 404 || res.status === 410;
  } catch {
    return false;
  }
}

async function getOrder(conn, orderId) {
  if (!/^\d{1,20}$/.test(String(orderId))) return null;
  const res = await send(conn.storeUrl, await keysOf(conn), "GET", `/orders/${orderId}`);
  return res.status === 200 ? res.data : null;
}

// what a brand (or admin) may see about a connection
function publicView(conn) {
  if (!conn) return null;
  return {
    platform: conn.platform,
    storeUrl: conn.storeUrl,
    status: conn.status,
    connectMethod: conn.connectMethod,
    webhookStatus: conn.webhookStatus,
    lastCheckAt: conn.lastCheckAt,
    lastError: conn.lastError || "",
    connectedAt: conn.connectedAt,
  };
}

module.exports = {
  enabled, configured, publicBase, portalBase, webhookUrl, KEY_RE, SECRET_RE, StoreError, MSG,
  detectWoo, testKeys, finalize, recheck, disconnect, connectedStore, createCoupon, deleteCoupon, getOrder, publicView, keysOf,
};
