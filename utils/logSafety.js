// utils/logSafety.js
// Two things for every line this server writes (Railway keeps logs, and more people can read them
// than can read the database):
//
// 1. Redaction. Everything written to stdout / stderr (console, the chat-service logger, anything) is
//    masked first: e-mail addresses (domain kept), phone numbers, CNICs, JWTs and "Bearer" tokens,
//    Expo push tokens, password hashes, WooCommerce / Shopify keys, and credentials or whole
//    connection strings in database URLs. A log line keeps its meaning without the personal data.
// 2. Request ids. requestId() middleware gives each request an id (the caller's X-Request-Id if it's
//    a sane one, else a new one), returns it in the X-Request-Id response header, and every console
//    line written while handling that request starts with [rid:<id>]. A user reporting a problem can
//    quote the header; the logs for that one request are then one search away.
//
// install() once, first thing in server.js (before anything logs).
const crypto = require("crypto");
const util = require("util");
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

const RULES = [
  // database / broker URLs: the whole MongoDB string (it names the cluster), credentials for the rest
  [/mongodb(?:\+srv)?:\/\/[^\s"'`<>]+/gi, "mongodb://[redacted]"],
  [/\b([a-z][a-z0-9+.-]{1,20}):\/\/[^\s:@\/"'`]+:[^\s@\/"'`]+@/gi, "$1://[redacted]@"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, "$1 [redacted]"],
  [/\b(Expo(?:nent)?PushToken)\[[^\]\s]+\]/g, "$1[redacted]"],
  [/\$2[aby]\$\d{2}\$[.\/A-Za-z0-9]{53}/g, "[hash]"],
  [/\b(ck|cs)_[a-f0-9]{32,}\b/g, "$1_[redacted]"],
  [/\bshp(at|ss|ca|pa)_[a-fA-F0-9]{32,}\b/g, "shp$1_[redacted]"],
  [/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g, "***@$1"],
  [/\b\d{5}-\d{7}-\d\b/g, "[cnic]"],
  // Pakistani mobiles (+92 3xx…, 0092…, 03xx…) and other + international numbers
  [/(?:\+|\b00)92[-\s]?3\d{2}[-\s]?\d{7}\b|\b03\d{2}[-\s]?\d{7}\b/g, "[phone]"],
  [/\+\d[\d\s-]{9,16}\d\b/g, "[phone]"],
];

function redact(text) {
  let out = String(text);
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  // every byte to stdout / stderr is redacted
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, encoding, cb) => {
      if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return write(redact(text), encoding && Buffer.isBuffer(chunk) ? undefined : encoding, cb);
    };
  }
  // console lines inside a request carry its id
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      const rid = als.getStore()?.rid;
      if (!rid) return orig(...args);
      return orig(`[rid:${rid}] ${util.format(...args)}`);
    };
  }
}

const SANE_ID = /^[A-Za-z0-9._-]{8,64}$/;
function requestId() {
  return (req, res, next) => {
    const given = req.get("X-Request-Id");
    const rid = given && SANE_ID.test(given) ? given : crypto.randomBytes(6).toString("hex");
    req.id = rid;
    res.setHeader("X-Request-Id", rid);
    als.run({ rid }, next);
  };
}

const currentRequestId = () => als.getStore()?.rid || null;

module.exports = { install, requestId, redact, currentRequestId };
