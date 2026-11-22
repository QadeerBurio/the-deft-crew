// Socket identity and the chat service's lock-out (upgrade/p4-1-safety, plan P4-1b), on in-memory data:
//   socket 'user_online' (socket/socketIdentity.js):
//     - a valid token (handshake auth, or the 2nd argument) → the token's account; a different client-sent id is ignored
//     - flag accountStatusEnforce OFF: no / bad token → the client-sent id, as older apps expect; a locked account with
//       a token is NOT refused (nothing is locked while the flag is off)
//     - flag ON: no / bad token → refused; a suspended / banned account → refused; an admin → allowed
//   chat service (chat-service/dist/middleware/auth.middleware.js, the file that runs):
//     - flag off: a banned student passes as before; flag on: 401 ACCOUNT_BANNED; an admin passes
//   server.js wires 'user_online' through resolveOnline and never trusts the first argument alone
//   node tests/socket-identity/run.js [serverDir]
const path = require("path");
const fs = require("fs");
const Module = require("module");
const h = require("../hiring-fixes/harness")(process.argv[2], {});
const { SERVER, reqS, check, oid, user, token, fake, coll } = h;
const { resolveOnline } = reqS("./socket/socketIdentity");

const ids = { s: oid(), other: oid(), banned: oid(), adminB: oid() };
fake.seed(coll("User"), [
  user(ids.s, "student", "Sami Student"), user(ids.other, "student", "Other Person"),
  user(ids.banned, "student", "Banned Bano", { accountStatus: "banned" }), user(ids.adminB, "admin", "Banned Admin", { accountStatus: "banned" }),
]);
const T = { s: token(ids.s, "student"), banned: token(ids.banned, "student"), adminB: token(ids.adminB, "admin") };
const sock = (tok) => ({ handshake: { auth: tok ? { token: tok } : {} } });

(async () => {
  delete process.env.FLAG_ACCOUNT_STATUS_ENFORCE;
  console.log("-- socket, flag off");
  let r = await resolveOnline(sock(T.s), String(ids.other));
  check("handshake token → the token's account, the client-sent (other) id ignored", r.userId === String(ids.s) && r.verified === true, JSON.stringify(r));
  r = await resolveOnline(sock(null), String(ids.other), T.s);
  check("token as the 2nd argument → the token's account", r.userId === String(ids.s) && r.verified === true, JSON.stringify(r));
  r = await resolveOnline(sock(null), String(ids.other));
  check("no token (older app) → the client-sent id, as before", r.userId === String(ids.other) && r.verified === false, JSON.stringify(r));
  r = await resolveOnline(sock("garbage"), String(ids.other));
  check("bad token → treated as no token (older behaviour while the flag is off)", r.userId === String(ids.other) && r.verified === false);
  r = await resolveOnline(sock(T.banned), String(ids.banned));
  check("banned account with a token, flag off → allowed (nothing is locked yet)", r.userId === String(ids.banned));
  r = await resolveOnline(sock(null), "not-an-id");
  check("no token and a junk id → refused", r.refused === true);

  console.log("-- socket, flag on");
  process.env.FLAG_ACCOUNT_STATUS_ENFORCE = "on";
  r = await resolveOnline(sock(null), String(ids.other));
  check("no token → refused (the client-sent id is never trusted)", r.refused === true, JSON.stringify(r));
  r = await resolveOnline(sock("garbage"), String(ids.other));
  check("bad token → refused", r.refused === true);
  r = await resolveOnline(sock(T.banned), String(ids.banned));
  check("banned account → refused", r.refused === true && /locked/.test(r.why));
  r = await resolveOnline(sock(T.adminB), String(ids.adminB));
  check("banned admin → allowed (admins are never locked out)", r.userId === String(ids.adminB));
  r = await resolveOnline(sock(T.s), String(ids.other));
  check("valid token → the token's account", r.userId === String(ids.s));
  delete process.env.FLAG_ACCOUNT_STATUS_ENFORCE;

  console.log("-- socket/chatHandlers.js wiring");
  const src = fs.readFileSync(path.join(SERVER, "socket/chatHandlers.js"), "utf8"); // moved from server.js (SEC-1)
  check("user_online (socket/chatHandlers.js) goes through resolveOnline and returns when refused", /socket\.on\('user_online', async \(clientUserId, tokenArg\) => \{[\s\S]{0,300}resolveOnline\(socket, clientUserId, tokenArg\)[\s\S]{0,120}if \(who\.refused\) return;\s*const userId = who\.userId;/.test(src));

  console.log("-- chat service middleware (dist, the file that runs)");
  const users = { [String(ids.banned)]: { _id: ids.banned, role: "student", accountStatus: "banned", email: "b@test.local", name: "Banned Bano" }, [String(ids.adminB)]: { _id: ids.adminB, role: "admin", accountStatus: "banned", email: "a@test.local", name: "Banned Admin" } };
  const dist = path.join(SERVER, "chat-service", "dist", "middleware", "auth.middleware.js");
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === dist && request === "../config/db") return { backendDbConnection: { db: { collection: () => ({ findOne: async (q) => users[String(q._id)] || null }) } } };
    if (parent && parent.filename === dist && request === "../config/envValidator") return { env: { JWT_SECRET: "test-only" } };
    return orig.apply(this, arguments);
  };
  delete require.cache[dist];
  const mw = require(dist).authMiddleware || require(dist).default;
  Module._load = orig;
  const run = async (tok) => {
    const out = { status: 200, body: null, next: false };
    const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
    await mw({ headers: { authorization: `Bearer ${tok}` } }, res, () => { out.next = true; });
    return out;
  };
  let c = await run(T.banned);
  check("chat, flag off: a banned student passes as before", c.next === true);
  process.env.FLAG_ACCOUNT_STATUS_ENFORCE = "on";
  c = await run(T.banned);
  check("chat, flag on: a banned student → 401 ACCOUNT_BANNED with the reason", !c.next && c.status === 401 && c.body?.code === "ACCOUNT_BANNED" && c.body?.success === false && !!c.body?.message, JSON.stringify(c));
  c = await run(T.adminB);
  check("chat, flag on: an admin passes", c.next === true);
  delete process.env.FLAG_ACCOUNT_STATUS_ENFORCE;
  const tsSrc = fs.readFileSync(path.join(SERVER, "chat-service/src/middleware/auth.middleware.ts"), "utf8");
  check("the TypeScript source has the same check (dist was built from it)", /lockOf\(\{/.test(tsSrc) && /require\('\.\.\/\.\.\/\.\.\/services\/accountStatus'\)/.test(tsSrc));

  const failed = h.results.filter((x) => !x).length;
  console.log(`\n${h.results.length - failed}/${h.results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
