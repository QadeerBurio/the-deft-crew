// utils/secretBox.js
// Encrypts brand store credentials at rest (WooCommerce keys, webhook secrets). AES-256-GCM with a random
// 12-byte IV per value; the key is STORE_CREDENTIALS_KEY (32 bytes, base64) from the server environment.
// Sealed form: "v1:<iv>:<tag>:<ciphertext>" (base64 parts). Never log or return the sealed or opened value.
const crypto = require("crypto");

const VERSION = "v1";

function key() {
  const raw = process.env.STORE_CREDENTIALS_KEY;
  if (!raw) throw new Error("STORE_CREDENTIALS_KEY is not set");
  const k = Buffer.from(String(raw).trim(), "base64");
  if (k.length !== 32) throw new Error("STORE_CREDENTIALS_KEY must be 32 bytes, base64");
  return k;
}

function hasKey() {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

function seal(plain) {
  if (plain == null || plain === "") return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

// throws if the value was changed or sealed with another key
function open(sealed) {
  if (!sealed) return "";
  const [version, iv, tag, ct] = String(sealed).split(":");
  if (version !== VERSION || !iv || !tag || ct == null) throw new Error("not a sealed value");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

module.exports = { seal, open, hasKey };
