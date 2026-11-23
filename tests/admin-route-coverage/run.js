// Phase A: every admin route has a permission (owner rule), on the real routers, mounted as server.js mounts them.
//   1. behavioural: a route without a permission that an admin passes and a student doesn't = an admin route without a
//      permission → FAIL (every route of every router is called: :params get a valid id, an empty body)
//   2. enforced (FLAG_ADMIN_RBAC_ENFORCE=on): a member admin with no permissions gets 403 ADMIN_PERMISSION_REQUIRED on
//      every mapped route (the check sits after sign-in, also behind a route file's own sign-in); an admin today
//      (no adminAccess) never does; a suspended member gets ADMIN_ACCESS_SUSPENDED
//   3. shadow (the default): the same member passes, and the "would deny" is logged (AdminAccessShadow)
//   4. source: no raw admin role check (`.role === "admin"`, `userRole === "admin"`) outside services/adminAccess.js;
//      the chat service's admin gate checks features.manage
//   node tests/admin-route-coverage/run.js [serverDir]
const fs = require("fs");
const path = require("path");
const http = require("http");
const h = require("../hiring-fixes/harness")(process.argv[2], { models: ["AdminAccessShadow", "AdminActionLog"] });
const { check, oid, user, token, fake, coll, rows, reqS, SERVER } = h;
process.env.MONGO_URI = process.env.BACKEND_MONGO_URI = "mongodb://127.0.0.1:9/coverage"; // only so chat-service config loads
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-only";
const quiet = { log: console.log, warn: console.warn, error: console.error };
// the server's own log lines are quiet; the check results (PASS / FAIL / "n/m passed") still print
console.log = (...a) => { const s = a.join(" "); if (/^(PASS|FAIL) {2}|^\n?\d+\/\d+ passed/.test(s)) quiet.log(...a); }; console.warn = () => {}; console.error = (...a) => { if (process.env.VERBOSE) quiet.error(...a); };
const say = (...a) => quiet.log(...a);

const express = reqS("express");
const src = fs.readFileSync(path.join(SERVER, "server.js"), "utf8");
const mounts = [...src.matchAll(/app\.use\(\s*["'](\/api[^"']*)["']\s*,\s*require\(["']([^"']+)["']\)(?:\.default)?/g)].map((m) => [m[1], m[2]]);
const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } });
app.use(express.json());
const routes = [];
const skipped = [];
for (const [mount, file] of mounts) {
  let router;
  try { router = reqS(file); router = router && router.default && router.default.stack ? router.default : router; } catch (e) { skipped.push(`${file}: ${e.message.slice(0, 60)}`); continue; }
  if (!router || !router.stack) continue;
  app.use(mount, router);
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) {
      const tags = layer.route.stack.map((l) => l.handle).filter((f) => f.permission);
      routes.push({ mount, file, method: m.toUpperCase(), path: layer.route.path, permission: tags[0]?.permission || null, inline: !!tags[0]?.inline });
    }
  }
}

const S = oid(); const A = oid(); const M = oid(); const P = oid();
fake.seed(coll("User"), [
  user(S, "student", "Sana Student"),
  user(A, "admin", "Ada Admin"),
  user(M, "admin", "Mo Member", { adminAccess: { level: "member", permissions: [], status: "active" } }),
  user(P, "admin", "Pat Paused", { adminAccess: { level: "member", permissions: ["students.view"], status: "suspended" } }),
]);
// the probes call every route, including self-delete and edits: the four accounts are put back before each call
const SEED = JSON.stringify(rows("User"));
const reseed = () => { const keep = JSON.parse(SEED, (k, v) => (typeof v === "string" && /^d{4}-dd-ddT/.test(v) ? new Date(v) : v)); const ids = new Set(keep.map((u) => String(u._id))); const list = fake.STORE.get(coll("User")); const others = list.filter((u) => !ids.has(String(u._id))); list.length = 0; list.push(...others, ...keep.map((u) => ({ ...u, _id: new (reqS("mongoose").Types.ObjectId)(String(u._id)) }))); };
const T = { S: token(S, "student"), A: token(A, "admin"), M: token(M, "admin"), P: token(P, "admin") };
const fill = (p) => p.replace(/:([A-Za-z_]+)/g, () => String(oid())).replace(/\(\.\*\)|\*/g, "x");

(async () => {
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const call = (method, url, tok) => new Promise((resolve) => {
    reseed();
    const body = method === "GET" || method === "DELETE" ? null : "{}";
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", ...(body ? { "content-length": 2 } : {}) }, timeout: 4000 }, (res) => {
      let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: "timeout", text: "" }); });
    req.on("error", () => resolve({ status: "error", text: "" }));
    if (body) req.write(body);
    req.end();
  });

  say(`-- ${routes.length} routes in ${mounts.length} mounted files${skipped.length ? `; not loadable here: ${skipped.join(" | ")}` : ""}`);
  const mapped = routes.filter((r) => r.permission);
  check(`routes with a permission: ${mapped.length} (${mapped.filter((r) => r.inline).length} checked inside the handler)`, mapped.length >= 220);

  say("-- 1. no admin route without a permission (behavioural)");
  const blocked = (s) => s === 401 || s === 403;
  const holes = []; const unknown = [];
  for (const r of routes.filter((x) => !x.permission)) {
    const url = r.mount + fill(r.path);
    const st = await call(r.method, url, T.S);
    if (process.env.PROBE_DEBUG && url.includes(process.env.PROBE_DEBUG)) say("DEBUG", r.method, url, st.status, st.text.slice(0, 200));
    if (!blocked(st.status)) continue; // students reach it: not an admin route
    const ad = await call(r.method, url, T.A);
    if (ad.status === "timeout" || ad.status === "error") unknown.push(`${r.method} ${r.mount}${r.path}`);
    else if (!blocked(ad.status)) holes.push(`${r.method} ${r.mount}${r.path} (${ad.status})`);
  }
  check("every route an admin passes and a student doesn't has a permission", holes.length === 0, holes.join(" | "));
  check("…and none of them hung (each one answered)", unknown.length === 0, unknown.join(" | "));

  say("-- 2. enforced: a member without permissions is refused on every mapped route");
  process.env.FLAG_ADMIN_RBAC_ENFORCE = "on";
  const notRefused = []; const legacyRefused = [];
  for (const r of mapped.filter((x) => !x.inline && x.permission !== "self")) { // "self": every admin (own access / sessions)
    const url = r.mount + fill(r.path);
    const m = await call(r.method, url, T.M);
    if (!(m.status === 403 && /ADMIN_PERMISSION_REQUIRED/.test(m.text))) notRefused.push(`${r.method} ${r.mount}${r.path} (${m.status})`);
    const a = await call(r.method, url, T.A);
    if (/ADMIN_PERMISSION_REQUIRED/.test(a.text) && r.permission !== "team.manage") legacyRefused.push(`${r.method} ${r.mount}${r.path}`);
    if (r.permission === "team.manage" && !/ADMIN_PERMISSION_REQUIRED/.test(a.text)) legacyRefused.push(`team.manage open to an admin today: ${r.method} ${r.mount}${r.path}`);
  }
  check(`member without permissions: 403 ADMIN_PERMISSION_REQUIRED on all ${mapped.filter((x) => !x.inline && x.permission !== "self").length} mapped routes`, notRefused.length === 0, notRefused.slice(0, 8).join(" | "));
  check("an admin today (no adminAccess): never refused by a permission, except team.manage (super admins only, always)", legacyRefused.length === 0, legacyRefused.slice(0, 8).join(" | "));
  const one = mapped.find((r) => r.method === "GET" && r.permission === "students.view" && !r.inline);
  const p = await call("GET", one.mount + fill(one.path), T.P);
  check("a suspended member: 403 ADMIN_ACCESS_SUSPENDED (even with the permission)", p.status === 403 && /ADMIN_ACCESS_SUSPENDED/.test(p.text), p.text);
  const s = await call("GET", one.mount + fill(one.path), T.S);
  check("a student on an admin route: the route's own answer, as before (not a permission error)", blocked(s.status) && !/ADMIN_PERMISSION_REQUIRED/.test(s.text));

  say("-- 3. shadow mode (adminRbacEnforce off, the default)");
  delete process.env.FLAG_ADMIN_RBAC_ENFORCE;
  const m = await call("GET", one.mount + fill(one.path), T.M);
  await new Promise((r) => setTimeout(r, 30));
  check("the member passes (not refused by the permission)", !/ADMIN_PERMISSION_REQUIRED/.test(m.text), `${m.status} ${m.text.slice(0, 80)}`);
  check("…and the 'would deny' is logged (admin, permission, route)", rows("AdminAccessShadow").some((x) => String(x.admin) === String(M) && x.permission === "students.view" && x.where.includes(one.path)));

  say("-- 4. source");
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(path.join(SERVER, d), { withFileTypes: true })) { const p2 = path.join(d, e.name); if (e.isDirectory()) walk(p2); else if (e.name.endsWith(".js")) files.push(p2); } })("routes");
  for (const d of ["services", "middleware", "utils", "socket"]) (function walk(dd) { if (!fs.existsSync(path.join(SERVER, dd))) return; for (const e of fs.readdirSync(path.join(SERVER, dd), { withFileTypes: true })) { const p2 = path.join(dd, e.name); if (e.isDirectory()) walk(p2); else if (e.name.endsWith(".js")) files.push(p2); } })(d);
  const RAW = /(\.role|userRole)\s*[!=]==?\s*["']admin["']/;
  const raw = [];
  for (const f of files) {
    if (f.replace(/\\/g, "/") === "services/adminAccess.js") continue;
    fs.readFileSync(path.join(SERVER, f), "utf8").split(/\r?\n/).forEach((l, i) => {
      if (/^\s*\/\//.test(l)) return;
      if (RAW.test(l.replace(/ctx\.role\s*===\s*"admin"/g, ""))) raw.push(`${f}:${i + 1}`);
    });
  }
  check("no raw admin role check outside services/adminAccess.js (isAdminAccount / adminCan / allowedFor instead)", raw.length === 0, raw.join(" | "));
  const chat = fs.readFileSync(path.join(SERVER, "chat-service/dist/middleware/admin.middleware.js"), "utf8");
  check("the chat service's admin gate (knowledge base, sync) checks features.manage", /decide\([^)]*'features\.manage'/.test(chat));

  server.close();
  h.finish({ close() {} });
})().catch((e) => { quiet.error(e); process.exit(1); });
