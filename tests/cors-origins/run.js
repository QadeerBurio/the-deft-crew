// CORS restricted to tdc's own pages (chore/cors-origins), with the real cors package:
//   - gettdc.pk, www.gettdc.pk, tdc-admin-portal.vercel.app, its Vercel previews and the server's own Railway domains
//     get Access-Control-Allow-Origin (also on a preflight)
//   - any other origin gets none (the browser blocks it); a look-alike domain doesn't pass
//   - no Origin (the app, webhooks, curl): served normally
//   - localhost only on staging or through CORS_EXTRA_ORIGINS; CORS_EXTRA_ORIGINS adds origins
//   - server.js uses it for Express and for socket.io (no more "*")
//   node tests/cors-origins/run.js [serverDir]
const path = require("path");
const http = require("http");
const fs = require("fs");
const Module = require("module");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
for (const k of ["CORS_EXTRA_ORIGINS", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME"]) delete process.env[k];
const express = reqS("express");
const cors = reqS("cors");
const { corsOptions, isAllowedOrigin } = reqS("./config/corsOrigins");
let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { ok ? passed++ : failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };

const app = express();
app.use(cors(corsOptions));
app.get("/api/ping", (req, res) => res.json({ ok: true }));
app.post("/api/ping", (req, res) => res.json({ ok: true }));
const server = app.listen(0);
const port = server.address().port;
const req = (method, origin, extra = {}) => new Promise((resolve) => {
  const headers = { ...(origin ? { origin } : {}), ...extra };
  const q = http.request({ host: "127.0.0.1", port, method, path: "/api/ping", headers }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, acao: res.headers["access-control-allow-origin"], body: t })); });
  q.end();
});

(async () => {
  for (const o of ["https://gettdc.pk", "https://www.gettdc.pk", "https://tdc-admin-portal.vercel.app", "https://tdc-admin-portal-enu9moxyn-abdul-qadeers-projects-04dc2951.vercel.app", "https://the-deft-crew-production.up.railway.app", "https://tdc-server-staging.up.railway.app"]) {
    const r = await req("GET", o);
    check(`${o}: allowed (Access-Control-Allow-Origin = itself)`, r.status === 200 && r.acao === o, `${r.status} ${r.acao}`);
  }
  let r = await req("OPTIONS", "https://gettdc.pk", { "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" });
  check("a preflight from gettdc.pk is answered with the origin", r.status === 204 && r.acao === "https://gettdc.pk", `${r.status} ${r.acao}`);
  for (const o of ["https://evil.example", "https://gettdc.pk.evil.example", "https://notgettdc.pk", "http://gettdc.pk", "https://tdc-admin-portal-x-someone-else.vercel.app", "null"]) {
    r = await req("GET", o);
    check(`${o}: no CORS header (the browser blocks it)`, !r.acao, `${r.acao}`);
  }
  r = await req("GET", null);
  check("no Origin (the mobile app, webhooks, curl): served normally", r.status === 200 && JSON.parse(r.body).ok === true);
  r = await req("GET", "http://localhost:3000");
  check("localhost on production: not allowed", !r.acao);
  process.env.APP_ENV = "staging";
  r = await req("GET", "http://localhost:3000");
  check("localhost on staging: allowed", r.acao === "http://localhost:3000", `${r.acao}`);
  delete process.env.APP_ENV;
  process.env.CORS_EXTRA_ORIGINS = "https://new.gettdc.pk, http://localhost:3000/";
  check("CORS_EXTRA_ORIGINS adds origins (trailing slash ignored)", isAllowedOrigin("https://new.gettdc.pk") && isAllowedOrigin("http://localhost:3000") && !isAllowedOrigin("https://other.gettdc.pk"));
  delete process.env.CORS_EXTRA_ORIGINS;

  const src = fs.readFileSync(path.join(SERVER, "server.js"), "utf8");
  check("server.js: Express uses the allowlist (no bare cors())", /app\.use\(cors\(require\("\.\/config\/corsOrigins"\)\.corsOptions\)\)/.test(src) && !/app\.use\(cors\(\)\)/.test(src));
  check("server.js: socket.io uses the allowlist (no origin \"*\")", /cors: \{ origin: require\("\.\/config\/corsOrigins"\)\.corsOptions\.origin \}/.test(src) && !/origin: "\*"/.test(src));
  server.close();
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
