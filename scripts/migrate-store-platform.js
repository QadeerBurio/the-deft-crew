// scripts/migrate-store-platform.js
// Gives every brand its real online-store platform. Until now User.platform defaulted to "woocommerce", so
// every brand looked like a WooCommerce store. After this:
//   shopify      the brand has an active ShopifyStore (installed tdc Shopify app)
//   woocommerce  the brand's WooCommerce keys work (they are moved, sealed, into BrandStoreConnection,
//                the order webhook is added on the store and the plain-text keys are removed from User)
//   none         everything else (keys that don't work are still moved, sealed, with status "error",
//                so the brand can test or reconnect from the portal)
//
//   node scripts/migrate-store-platform.js                 # dry run (default): prints what would change, writes NOTHING
//   node scripts/migrate-store-platform.js --apply         # writes; every change is logged with a run id
//   node scripts/migrate-store-platform.js --reverse <id>  # puts back what run <id> changed (platform and keys)
//
// Needs MONGO_URI. --apply and --reverse with WooCommerce keys also need STORE_CREDENTIALS_KEY, and the
// webhook needs PUBLIC_BASE_URL (defaults to the Railway URL). The dry run only reads (one GET to each
// store that has keys, to see if they work). It never prints a key or secret.
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const ShopifyStore = require("../models/ShopifyStore");
const BrandStoreConnection = require("../models/BrandStoreConnection");
const box = require("../utils/secretBox");
const { normalizeStoreUrl } = require("../utils/safeHttp");
const woo = require("../services/wooStore");

const LOG = "platformmigrationlogs";

// the raw stored value (the model would fill in its default)
const rawPlatform = (u) => (u.platform === undefined ? null : u.platform);

async function wooKeysWork(storeUrl, key, secret) {
  const n = normalizeStoreUrl(storeUrl);
  if (n.error) return { ok: false, url: "", reason: n.error };
  try {
    await woo.detectWoo(n.url);
    await woo.testKeys(n.url, { key, secret });
    return { ok: true, url: n.url };
  } catch (err) {
    return { ok: false, url: n.url, reason: err.message };
  }
}

// mode: "dry-run" | "apply"; returns { runId, rows, counts }
async function plan({ mode = "dry-run", say = console.log } = {}) {
  const apply = mode === "apply";
  const runId = apply ? `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}` : "dry-run";
  const brands = await User.collection.find({ role: "brand" }).project({ _id: 1, brandName: 1, name: 1, platform: 1, websiteUrl: 1, shopifyStoreUrl: 1, wooConsumerKey: 1, wooConsumerSecret: 1, webhookSecret: 1 }).toArray();
  const activeShopify = new Set((await ShopifyStore.find({ status: "active" }).select("brandId").lean()).map((s) => String(s.brandId)));
  const existingConn = new Map((await BrandStoreConnection.find({}).select("brand status").lean()).map((c) => [String(c.brand), c.status]));

  const rows = [];
  for (const b of brands) {
    const id = String(b._id);
    const before = rawPlatform(b);
    const hasKeys = !!(b.wooConsumerKey && b.wooConsumerSecret && b.websiteUrl);
    let after = "none";
    let reason = "no working store connection";
    let woo_ = null;
    if (activeShopify.has(id)) {
      after = "shopify";
      reason = "active Shopify app install";
    } else if (existingConn.get(id) === "connected") {
      after = "woocommerce";
      reason = "already connected";
    } else if (hasKeys) {
      woo_ = await wooKeysWork(b.websiteUrl, b.wooConsumerKey, b.wooConsumerSecret);
      after = woo_.ok ? "woocommerce" : "none";
      reason = woo_.ok ? "WooCommerce keys work" : `WooCommerce keys don't work: ${woo_.reason}`;
    }
    rows.push({ id, name: b.brandName || b.name || "", before, after, reason, hasKeys, wooUrl: woo_?.url || "", wooOk: !!woo_?.ok, hasWebhookSecret: !!b.webhookSecret });
  }

  const counts = { brands: rows.length, before: {}, after: {}, changed: 0, wooKeys: rows.filter((r) => r.hasKeys).length, wooKeysWorking: rows.filter((r) => r.wooOk).length };
  for (const r of rows) {
    counts.before[r.before ?? "(not set)"] = (counts.before[r.before ?? "(not set)"] || 0) + 1;
    counts.after[r.after] = (counts.after[r.after] || 0) + 1;
    if (r.before !== r.after) counts.changed += 1;
  }

  if (apply) {
    if (rows.some((r) => r.hasKeys) && !box.hasKey()) throw new Error("STORE_CREDENTIALS_KEY is needed to move WooCommerce keys; nothing was written");
    const log = mongoose.connection.collection(LOG);
    for (const r of rows) {
      const raw = brands.find((b) => String(b._id) === r.id);
      const entry = { runId, brand: raw._id, before: { platform: r.before }, after: { platform: r.after }, movedWooKeys: false, connectionCreated: false, at: new Date() };
      if (r.hasKeys && !existingConn.has(r.id)) {
        const conn = await BrandStoreConnection.create({
          brand: raw._id,
          platform: "woocommerce",
          storeUrl: r.wooUrl || String(raw.websiteUrl || ""),
          status: "pending",
          connectMethod: "migrated",
          keyEnc: box.seal(raw.wooConsumerKey),
          secretEnc: box.seal(raw.wooConsumerSecret),
        });
        entry.movedWooKeys = true;
        entry.connectionCreated = true;
        entry.connectionId = conn._id;
        entry.before.keys = { key: box.seal(raw.wooConsumerKey), secret: box.seal(raw.wooConsumerSecret), webhookSecret: raw.webhookSecret ? box.seal(raw.webhookSecret) : "" };
        if (r.wooOk) {
          const done = await woo.finalize(conn._id); // adds the webhook; sets platform woocommerce or none
          r.after = done.status === "connected" ? "woocommerce" : "none";
          entry.after.platform = r.after;
        } else {
          await BrandStoreConnection.updateOne({ _id: conn._id }, { $set: { status: "error", lastError: r.reason.replace(/^WooCommerce keys don't work: /, "") } });
        }
        await User.collection.updateOne({ _id: raw._id }, { $unset: { wooConsumerKey: "", wooConsumerSecret: "", webhookSecret: "" } });
      }
      await User.collection.updateOne({ _id: raw._id }, { $set: { platform: r.after } });
      await log.insertOne(entry);
    }
  }

  say(`${apply ? "APPLIED" : "DRY RUN (nothing written)"}: ${counts.brands} brands, ${counts.changed} change`);
  say(`  platform before: ${JSON.stringify(counts.before)}`);
  say(`  platform after:  ${JSON.stringify(counts.after)}`);
  say(`  WooCommerce keys on record: ${counts.wooKeys}, working: ${counts.wooKeysWorking}`);
  for (const r of rows.filter((x) => x.before !== x.after || x.hasKeys)) say(`  ${r.id}  ${r.name.slice(0, 30).padEnd(30)}  ${String(r.before ?? "(not set)").padEnd(11)} -> ${r.after.padEnd(11)}  ${r.reason}`);
  if (apply) say(`run id: ${runId}  (undo: node scripts/migrate-store-platform.js --reverse ${runId})`);
  return { runId, rows, counts };
}

async function reverse(runId, { say = console.log } = {}) {
  const log = mongoose.connection.collection(LOG);
  const entries = await log.find({ runId, reversedAt: { $exists: false } }).toArray();
  if (!entries.length) throw new Error(`no un-reversed entries for run ${runId}`);
  for (const e of entries) {
    if (e.connectionCreated && e.connectionId) {
      const conn = await BrandStoreConnection.findById(e.connectionId);
      if (conn) {
        try {
          await woo.disconnect(conn); // removes the webhook it added on the store
        } catch {}
        await BrandStoreConnection.deleteOne({ _id: e.connectionId });
      }
    }
    const set = {};
    const unset = {};
    if (e.before.platform === null) unset.platform = "";
    else set.platform = e.before.platform;
    if (e.before.keys) {
      set.wooConsumerKey = box.open(e.before.keys.key);
      set.wooConsumerSecret = box.open(e.before.keys.secret);
      if (e.before.keys.webhookSecret) set.webhookSecret = box.open(e.before.keys.webhookSecret);
    }
    await User.collection.updateOne({ _id: e.brand }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    await log.updateOne({ _id: e._id }, { $set: { reversedAt: new Date() }, $unset: { "before.keys": "" } });
  }
  say(`REVERSED ${entries.length} brands from ${runId}`);
  return { reversed: entries.length };
}

module.exports = { plan, reverse };

if (require.main === module) {
  (async () => {
    require("dotenv").config();
    const connectDB = require("../config/db");
    const { useServerDns } = require("../config/dns");
    if (typeof useServerDns === "function") useServerDns();
    const args = process.argv.slice(2);
    await connectDB();
    try {
      if (args[0] === "--reverse") {
        if (!args[1]) throw new Error("usage: --reverse <runId>");
        await reverse(args[1]);
      } else {
        await plan({ mode: args.includes("--apply") ? "apply" : "dry-run" });
      }
    } catch (err) {
      console.error("stopped:", err.message);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect();
    }
  })();
}
