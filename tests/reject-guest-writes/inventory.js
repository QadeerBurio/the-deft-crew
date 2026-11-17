// Inventory: every write route (POST / PUT / PATCH / DELETE) the server mounts, called signed out (no token) with the
// guest guard OFF, on in-memory data. A route answering anything but 401 / 403 is reachable by a signed-out caller
// today: it must be on the allowlist (public on purpose) or the guard closes it.
//   node tests/reject-guest-writes/inventory.js [serverDir] [--json out.json]
const fs = require("fs");
const path = require("path");
const http = require("http");

module.exports = async function inventory(h, { guard = false } = {}) {
  const { SERVER, reqS, mongoose } = h;
  const srv = fs.readFileSync(path.join(SERVER, "server.js"), "utf8");
  const mounts = [...srv.matchAll(/app\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*require\(\s*["'`](\.\/routes\/[^"'`]+)["'`]\s*\)(\.default)?\s*\)/g)] // (/api/v1, the chat service, needs its own database to load: checked separately)
    .map((m) => ({ base: m[1], file: m[2] }));
  const express = reqS("express");
  const app = express();
  app.set("io", { to: () => ({ emit() {} }), emit() {} });
  app.use(express.json());
  if (guard) app.use("/api", reqS("./middleware/rejectGuestWrites"));
  const loaded = [];
  for (const { base, file } of mounts) {
    let router;
    try { const mod = reqS(file); router = mod && mod.default ? mod.default : mod; } catch (e) { loaded.push({ base, file, error: e.message }); continue; }
    app.use(base, router);
    loaded.push({ base, file, router });
  }
  // the routes, from each router's own table
  const routes = [];
  const walk = (stack, prefix) => {
    for (const layer of stack || []) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          if (!["post", "put", "patch", "delete"].includes(method)) continue;
          for (const p of [].concat(layer.route.path)) if (typeof p === "string") routes.push({ method: method.toUpperCase(), path: prefix + (p === "/" ? "" : p) });
        }
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix); // a nested router (mounted without a path of its own)
      }
    }
  };
  for (const l of loaded) if (l.router) walk(l.router.stack, l.base);
  const server = app.listen(0);
  const port = server.address().port;
  const id = String(new mongoose.Types.ObjectId());
  const send = (method, url) => new Promise((resolve) => {
    const body = "{}";
    const q = http.request({ host: "127.0.0.1", port, method, path: url, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 8000 }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, text: t.slice(0, 160) }));
    });
    q.on("timeout", () => { q.destroy(); resolve({ status: 0, text: "timeout" }); });
    q.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
    q.write(body); q.end();
  });
  const seen = new Set();
  const results = [];
  for (const r of routes) {
    const url = r.path.replace(/:(\w+)(\([^)]*\))?\??/g, (m, name) => (/token|code|kind|type|flag|status|connectionId/i.test(name) ? "x" : id));
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const res = await send(r.method, url);
    results.push({ ...r, url, status: res.status, text: res.text });
  }
  server.close();
  return { routes: results, loaded: loaded.map((l) => ({ base: l.base, file: l.file, error: l.error })) };
};

if (require.main === module) {
  const h = require("../hiring-fixes/harness")(process.argv[2]);
  module.exports(h).then(({ routes, loaded }) => {
    const bad = loaded.filter((l) => l.error);
    if (bad.length) console.log("NOT LOADED:", bad.map((l) => `${l.file}: ${l.error}`).join(" | "));
    const open = routes.filter((r) => r.status !== 401 && r.status !== 403);
    console.log(`${routes.length} write routes; ${open.length} reachable signed out:`);
    for (const r of open) console.log(`${String(r.status).padEnd(4)} ${r.method.padEnd(6)} ${r.path}   ${r.text.replace(/\s+/g, " ").slice(0, 90)}`);
    const out = process.argv.indexOf("--json");
    if (out > 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify(routes, null, 1));
    process.exit(0);
  }).catch((e) => { console.error("FATAL", e); process.exit(2); });
}
