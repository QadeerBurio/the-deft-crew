const crypto = require("crypto");

const PAYFAST_CONFIG = {
  merchant_id: "YOUR_MERCHANT_ID",
  merchant_key: "YOUR_MERCHANT_KEY",
  passphrase: "YOUR_PASSPHRASE",

  sandbox: true,

  return_url: "https://yourdomain.com/payment/success",
  cancel_url: "https://yourdomain.com/payment/cancel",
  notify_url: "https://yourdomain.com/api/payfast/webhook"
};

function generateSignature(data, passphrase = null) {
  let pfOutput = "";

  for (let key in data) {
    if (data[key] !== "") {
      pfOutput += `${key}=${encodeURIComponent(data[key].trim())}&`;
    }
  }

  let getString = pfOutput.slice(0, -1);

  if (passphrase) {
    getString += `&passphrase=${encodeURIComponent(passphrase.trim())}`;
  }

  return crypto.createHash("md5").update(getString).digest("hex");
}

module.exports = { PAYFAST_CONFIG, generateSignature };