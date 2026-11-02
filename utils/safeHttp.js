// utils/safeHttp.js
// Outgoing requests to addresses a brand typed in (their store URL). Guards against the server being used
// to reach internal systems (SSRF): https only, standard port, no user:password in the URL, the host must
// resolve only to public addresses, and the connection is pinned to the address that was checked (so a
// second DNS answer can't swap in an internal one). No redirects, short timeouts, small responses.
const dns = require("dns");
const net = require("net");
const https = require("https");
const axios = require("axios");

const MAX_RESPONSE = 2 * 1024 * 1024;

class UnsafeUrlError extends Error {}

function v4Private(ip) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 and 192.0.2.0/24
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) || (a === 203 && b === 0)
  );
}
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return v4Private(ip);
  if (!net.isIPv6(ip)) return true;
  const x = ip.toLowerCase();
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]);
  return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("2001:db8") || x.startsWith("64:ff9b");
}

// the store URL as typed -> { url: "https://host/path" (no trailing slash, no query) } or { error }
function normalizeStoreUrl(input) {
  let u;
  try {
    u = new URL(String(input || "").trim());
  } catch {
    return { error: "Enter the full address, starting with https://" };
  }
  if (u.protocol !== "https:") return { error: "The store must use https://" };
  if (u.username || u.password) return { error: "Remove the user name and password from the address" };
  if (u.port && u.port !== "443") return { error: "Use the standard https port" };
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { error: "That address isn't a public website" };
  }
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) return { error: "Use the store's domain name, not an IP address" };
  const path = u.pathname.replace(/\/+$/, "");
  return { url: `https://${host}${path}` };
}

// one public address for the host, or throws UnsafeUrlError
async function resolvePublic(hostname) {
  let answers;
  try {
    answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError("The store's address could not be found");
  }
  if (!answers.length || answers.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError("That address isn't a public website");
  return answers[0];
}

// GET/POST/PUT/DELETE to an https URL on a public host. Returns { status, data } for any HTTP status;
// throws UnsafeUrlError for unsafe targets and Error for network failures.
async function request({ method = "GET", url, auth, data, params, timeout = 10000 }) {
  const n = normalizeStoreUrl(url);
  if (n.error) throw new UnsafeUrlError(n.error);
  const target = new URL(url);
  const addr = await resolvePublic(target.hostname);
  const agent = new https.Agent({
    keepAlive: false,
    lookup: (host, opts, cb) => {
      if (opts && opts.all) return cb(null, [{ address: addr.address, family: addr.family }]);
      return cb(null, addr.address, addr.family);
    },
  });
  const res = await axios.request({
    method,
    url: target.toString(),
    auth,
    data,
    params,
    timeout,
    httpsAgent: agent,
    proxy: false,
    maxRedirects: 0,
    maxContentLength: MAX_RESPONSE,
    maxBodyLength: 256 * 1024,
    validateStatus: () => true,
    headers: { Accept: "application/json", "User-Agent": "tdc-store-connector/1.0" },
  });
  return { status: res.status, data: res.data };
}

module.exports = { request, normalizeStoreUrl, isPrivateAddress, resolvePublic, UnsafeUrlError };
