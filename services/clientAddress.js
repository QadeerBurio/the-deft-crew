// services/clientAddress.js
// Who is visiting, for the public pages the portal forwards (gettdc.pk/r/<link>: P3d public resume page).
// The chain through the portal is: visitor → Vercel (gettdc.pk) → Railway's edge → this server. Railway's edge adds
// the address that connected to it, which for a forwarded request is Vercel's, the same for every visitor. Vercel
// publishes no fixed addresses and Railway's handling of X-Forwarded-For is not a stable contract, so a hop count
// can't tell a forwarded request from someone calling this server directly with a made-up header.
// So the portal's forwarder (edu-boost middleware.js) proves itself with a shared secret, PORTAL_PROXY_SECRET (set the
// same value in Vercel and Railway; never in the repo), and passes the visitor address Vercel's own edge set:
//   x-tdc-proxy: <secret>        x-tdc-visitor-ip: <address>
// Only a request with the right secret has its x-tdc-visitor-ip used; every other request (no secret configured,
// a wrong or missing secret, an address that isn't one) gets the edge address, exactly as before.
//   edgeAddress(req)     the address Railway's edge added (the last X-Forwarded-For entry), as loginGuard.clientIp
//   visitorAddress(req)  the forwarded visitor when the portal proved itself, else edgeAddress(req)
const crypto = require("crypto");
const { clientIp } = require("./loginGuard");

const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39}(?::\d{1,3}(?:\.\d{1,3}){3})?)$/i;

const edgeAddress = (req) => clientIp(req);

function fromPortal(req) {
  const secret = String(process.env.PORTAL_PROXY_SECRET || "");
  if (secret.length < 16) return false; // not configured (or too short to be a secret): trust nothing
  const given = String(req.headers?.["x-tdc-proxy"] || "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function visitorAddress(req) {
  if (fromPortal(req)) {
    const ip = String(req.headers?.["x-tdc-visitor-ip"] || "").trim();
    if (IP.test(ip)) return ip;
  }
  return edgeAddress(req);
}

module.exports = { visitorAddress, edgeAddress, fromPortal };
