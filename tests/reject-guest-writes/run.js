// Signed-out callers can't write (fix/reject-guest-writes), on in-memory data, over EVERY write route the server mounts
// (tests/reject-guest-writes/inventory.js reads them from the routers themselves):
//   - with the guard, every non-allowlisted write route answers a guest 401 SIGN_IN_REQUIRED (no header, "Bearer
//     undefined" / "null" / empty, the app's guest token); nothing behind it runs
//   - every allowlisted route still gets past the guard (sign-up, login, codes, password reset, webhooks, the WooCommerce
//     callback, the Meta build report, guest app events, the streak cron, the chat knowledge search); login and the
//     Meta report still work end to end
//   - the allowlist covers every route that answered a guest before AND is public on purpose; the rest of the formerly
//     reachable routes are now closed (counted)
//   - reads are untouched; a signed-in user's writes go through; a bad token is still the route's own 401
//   - GUEST_WRITES_GUARD=off switches it off
//   node tests/reject-guest-writes/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key"; // resume.routes builds its client at load
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/engagement", "./routes/engagement.routes"]] });
const { check, oid, user, token, fake, coll, reqS } = h;
const http = require("http");
const inventory = require("./inventory");
const guard = reqS("./middleware/rejectGuestWrites");
const bcrypt = reqS("bcryptjs");

(async () => {
  // ---------- every write route: before (no guard) and after (guard) ----------
  const before = await inventory(h, { guard: false });
  const after = await inventory(h, { guard: true });
  const key = (r) => `${r.method} ${r.path}`;
  const was = new Map(before.routes.map((r) => [key(r), r]));
  check(`the inventory read every router (${after.routes.length} write routes, none failed to load)`, after.routes.length > 250 && after.loaded.every((l) => !l.error), after.loaded.filter((l) => l.error).map((l) => `${l.file}: ${l.error}`).join(" | "));
  const isAllowed = (r) => guard.allowed(r.method, r.path.replace(/^\/api/, "").replace(/:(\w+)/g, "x"));
  // the guard sits on /api; a write route outside /api (the Shopify webhooks at /webhooks, since r8 a router the
  // inventory sees) must refuse a signed-out, unsigned caller itself: 401 / 403
  const outsideApi = after.routes.filter((r) => !r.path.startsWith("/api/"));
  check(`every write route outside /api refuses an unsigned caller itself (${outsideApi.length} routes)`, outsideApi.every((r) => r.status === 401 || r.status === 403), outsideApi.filter((r) => r.status !== 401 && r.status !== 403).map((r) => `${r.status} ${key(r)}`).join(" | "));
  const closed = after.routes.filter((r) => r.path.startsWith("/api/") && !isAllowed(r));
  const notBlocked = closed.filter((r) => !(r.status === 401 && /SIGN_IN_REQUIRED/.test(r.text)));
  check(`every non-allowlisted write route answers a guest 401 SIGN_IN_REQUIRED (${closed.length} routes)`, notBlocked.length === 0, notBlocked.slice(0, 8).map((r) => `${r.status} ${key(r)}`).join(" | "));
  const open = after.routes.filter(isAllowed);
  const blockedOpen = open.filter((r) => r.status === 401 && /SIGN_IN_REQUIRED/.test(r.text));
  check(`every allowlisted route still gets past the guard (${open.length} routes)`, open.length >= 14 && blockedOpen.length === 0, blockedOpen.map(key).join(" | "));
  const unchanged = open.filter((r) => was.get(key(r)) && was.get(key(r)).status === r.status);
  check("…and answers exactly as before the guard", unchanged.length === open.length, open.filter((r) => !unchanged.includes(r)).map((r) => `${key(r)} ${was.get(key(r))?.status}→${r.status}`).join(" | "));
  const reachableBefore = before.routes.filter((r) => r.status !== 401 && r.status !== 403);
  const nowClosed = reachableBefore.filter((r) => !isAllowed(r));
  console.log(`      (before: ${reachableBefore.length} write routes answered a guest; now ${reachableBefore.length - nowClosed.length}, all on the allowlist)`);
  const allowNeverUsed = guard.ALLOW.filter(([m, re]) => !after.routes.some((r) => r.method === m && re.test(r.path.replace(/^\/api/, "").replace(/:(\w+)/g, "x"))) && !String(re).includes("v1"));
  check("every allowlist entry matches a real route (the chat service's is checked by name)", allowNeverUsed.length === 0, allowNeverUsed.map(([m, re]) => `${m} ${re}`).join(" | "));

  // ---------- end to end through the guard ----------
  const express = reqS("express");
  const app = express();
  app.use(express.json());
  app.use("/api", guard);
  app.use("/api/auth", reqS("./routes/auth.routes"));
  app.use("/api/app", reqS("./routes/appFlags.routes"));
  app.use("/api/engagement", reqS("./routes/engagement.routes"));
  app.use("/api/notification", reqS("./routes/notification.routes"));
  const server = app.listen(0);
  const port = server.address().port;
  const call = (method, path, { body, auth } = {}) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...(auth !== undefined ? { authorization: auth } : {}) };
    const q = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); }); });
    q.on("error", (e) => resolve({ status: 0, text: String(e) }));
    if (data) q.write(data); q.end();
  });
  const ids = { S: oid(), A: oid(), R: oid() };
  fake.seed(coll("User"), [{ ...user(ids.S, "student", "Sana Student"), email: "sana@uni.pk", password: bcrypt.hashSync("right-password-1", 4), emailVerified: true }, user(ids.A, "admin", "Admin One"), user(ids.R, "student", "Ravi Recipient")]);
  const TS = token(ids.S, "student");

  for (const [what, auth] of [["no header", undefined], ["Bearer undefined", "Bearer undefined"], ["Bearer null", "Bearer null"], ["the app's guest token", "Bearer guest-token-2024"]]) {
    const r = await call("POST", "/api/notification/send", { auth, body: { recipient: String(ids.R), title: "hi", description: "spam" } });
    check(`a guest (${what}) can't send a notification: 401 SIGN_IN_REQUIRED`, r.status === 401 && r.json?.code === "SIGN_IN_REQUIRED", `${r.status} ${r.text.slice(0, 80)}`);
  }
  check("…and nothing was written", (fake.STORE.get(coll("Notification")) || []).length === 0);
  let r = await call("POST", "/api/auth/login", { body: { email: "sana@uni.pk", password: "right-password-1" } });
  check("login still works signed out (allowlisted): 200 with a token", r.status === 200 && !!r.json?.token, `${r.status}`);
  r = await call("POST", "/api/app/meta-build", { body: { platform: "android", appVersion: "1.2.1", build: "90", enabled: true } });
  check("the Meta build report still works signed out: 204", r.status === 204, `${r.status}`);
  r = await call("POST", "/api/engagement/events", { body: { name: "app_open" } });
  check("a guest's app_open event is still accepted (204, a no-op)", r.status === 204, `${r.status}`);
  r = await call("GET", "/api/app/flags");
  check("reads are untouched for guests (GET /api/app/flags: 200)", r.status === 200);
  r = await call("POST", "/api/engagement/events", { auth: `Bearer ${TS}`, body: { name: "app_open" } });
  check("a signed-in student's write goes through (204)", r.status === 204, `${r.status} ${r.text.slice(0, 80)}`);
  r = await call("POST", "/api/notification/send", { auth: "Bearer not-a-real-jwt", body: {} });
  check("a bad token isn't treated as a guest: the route's own 401 (not SIGN_IN_REQUIRED)", r.status === 401 && r.json?.code !== "SIGN_IN_REQUIRED", `${r.status} ${r.text.slice(0, 80)}`);
  process.env.GUEST_WRITES_GUARD = "off";
  r = await call("POST", "/api/notification/send", { body: {} });
  check("GUEST_WRITES_GUARD=off switches it off (the route answers again)", r.status !== 401 || r.json?.code !== "SIGN_IN_REQUIRED", `${r.status}`);
  delete process.env.GUEST_WRITES_GUARD;
  server.close();

  h.finish(h.start());
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
