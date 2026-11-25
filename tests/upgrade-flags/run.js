// Upgrade v2 flags (upgrade/p0-safety, plan P0-1 + P0-6), on in-memory data:
//   - growthV2, ambassadorV2, resumeV2, confessionsV2, confessionSafety, shareCards exist and are sent by
//     GET /api/app/flags/me. r10 (owner): ON for every student by default through launchV2 (a student role default);
//     OFF for brand, employer, admin and guest. With the students' launchV2 default turned off they are off for every
//     role, as before r10 (the per-account checks below run that way)
//   - none of them is in ROLE_DEFAULTS; each can be granted to students only, shows in the admin features overview
//   - an admin row turns one on for exactly that student; the Railway kill switch ("off") still wins
//   - a Railway ids rule turns one on for a test account only
//   - accountStatusEnforce: server only (never sent to the app), not grantable, off unless FLAG_ACCOUNT_STATUS_ENFORCE
//   - GET /api/app/flags (public) carries none of them
//   node tests/upgrade-flags/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/admin/features", "./routes/adminFeatures.routes"]],
  models: ["FeatureAccess", "FeatureDefault", "AdminActionLog"],
});
const { reqS, call, check, oid, user, token, fake, coll } = h;
const flags = reqS("./config/featureFlags");
flags.setBuiltInDefaults(true); // production: "no row = on" for the role defaults

const NEW = ["growthV2", "ambassadorV2", "resumeV2", "confessionsV2", "confessionSafety", "shareCards"];
const ids = { S: oid(), S2: oid(), B: oid(), E: oid(), A: oid() };
fake.seed(coll("User"), [
  user(ids.S, "student", "Sana Student"),
  user(ids.S2, "student", "Omar Student"),
  user(ids.B, "brand", "Alpha Cafe", { brandName: "Alpha Cafe" }),
  user(ids.E, "employee", "Hina Employer", { companyName: "Bright Labs" }),
  user(ids.A, "admin", "Admin One"),
]);
flags.setAccountRoles([[ids.B, "brand"], [ids.E, "employee"], [ids.A, "admin"]]);
const T = { S: token(ids.S, "student"), S2: token(ids.S2, "student"), B: token(ids.B, "brand"), E: token(ids.E, "employee"), A: token(ids.A, "admin") };

const withEnv = async (vars, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const me = async (tok) => (await call("GET", "/api/app/flags/me", { tok })).json || {};

(async () => {
  const server = h.start();

  // definitions
  check("all six upgrade flags are defined, off by default, sent to the app", NEW.every((f) => flags.FLAGS[f] && flags.FLAGS[f].default === false && flags.FLAGS[f].client === true));
  check("each can be granted to students only", NEW.every((f) => JSON.stringify(flags.FLAGS[f].grant?.roles) === '["student"]'));
  check("none is in ROLE_DEFAULTS (no role gets them on by default)", Object.values(flags.ROLE_DEFAULTS).every((list) => NEW.every((f) => !list.includes(f))) && NEW.every((f) => !flags.FLAGS[f].studentDefault));
  check("accountStatusEnforce: server only, not grantable, off by default", flags.FLAGS.accountStatusEnforce && flags.FLAGS.accountStatusEnforce.default === false && !flags.FLAGS.accountStatusEnforce.client && !flags.FLAGS.accountStatusEnforce.grant);

  // what each role's app sees: r10, students have them by default through launchV2 (no row needed)
  const s0 = await me(T.S);
  check("r10: student with no settings: every upgrade flag on (launchV2, a student default)", s0.launchV2 === true && NEW.every((f) => s0[f] === true), JSON.stringify(s0));
  // the rest of this suite: the students' launchV2 default turned off by an admin = the rules as before r10
  flags.applyDefault("launchV2", "student", false);
  const s = await me(T.S);
  check("students' launchV2 default off: every upgrade flag is false", NEW.every((f) => s[f] === false), JSON.stringify(s));
  check("student: the older student features are still on by default (unchanged)", s.loyaltyV2 === true && s.resumeStudioV2 === true, JSON.stringify(s));
  for (const [who, tok] of [["brand", T.B], ["employer", T.E], ["admin", T.A]]) {
    const v = await me(tok);
    check(`${who}: every upgrade flag is false`, NEW.every((f) => v[f] === false), JSON.stringify(v));
  }
  const g = await me(null);
  check("guest (no token): every upgrade flag is false", NEW.every((f) => g[f] === false), JSON.stringify(g));
  check("flags/me never carries accountStatusEnforce", !("accountStatusEnforce" in s) && !("accountStatusEnforce" in g));
  const pub = (await call("GET", "/api/app/flags")).json || {};
  check("public /api/app/flags carries none of them", NEW.every((f) => !(f in pub)) && !("accountStatusEnforce" in pub), JSON.stringify(pub));

  // admin features overview: a tab per new flag
  const ov = (await call("GET", "/api/admin/features/flags", { tok: T.A })).json?.data || [];
  check("admin overview lists all six (one tab each)", NEW.every((f) => ov.some((x) => x.flag === f)), ov.map((x) => x.flag).join(","));
  check("admin overview never lists accountStatusEnforce", !ov.some((x) => x.flag === "accountStatusEnforce"));

  // an admin row: on for that student only
  const r = await call("PUT", `/api/admin/features/account/${ids.S}/confessionSafety`, { tok: T.A, body: { enabled: true, reason: "test account for confession safety" } });
  check("admin turns confessionSafety on for one student → 200", r.status === 200, r.text.slice(0, 200));
  check("…that student sees it on", (await me(T.S)).confessionSafety === true);
  check("…another student still sees it off", (await me(T.S2)).confessionSafety === false);
  const s1 = await me(T.S);
  check("…the other upgrade flags stay off for that student", NEW.filter((f) => f !== "confessionSafety").every((f) => s1[f] === false), JSON.stringify(s1));
  await withEnv({ FLAG_CONFESSION_SAFETY: "off" }, async () => {
    check("the Railway kill switch (off) beats the admin row", (await me(T.S)).confessionSafety === false);
  });
  const nb = await call("PUT", `/api/admin/features/account/${ids.B}/growthV2`, { tok: T.A, body: { enabled: true, reason: "brands can't have it" } });
  check("granting an upgrade flag to a brand is refused", nb.status >= 400 && nb.status < 500, `${nb.status}`);

  // a Railway ids rule
  await withEnv({ FLAG_GROWTH_V2: `ids:${ids.S2}` }, async () => {
    check("FLAG_GROWTH_V2=ids:<student>: on for that student", (await me(T.S2)).growthV2 === true);
    check("…off for everyone else", (await me(T.S)).growthV2 === false && (await me(T.B)).growthV2 === false);
  });

  // accountStatusEnforce
  check("accountStatusEnforce off with no variable", flags.isEnabled("accountStatusEnforce") === false);
  await withEnv({ FLAG_ACCOUNT_STATUS_ENFORCE: "on" }, async () => {
    check("…on with FLAG_ACCOUNT_STATUS_ENFORCE=on", flags.isEnabled("accountStatusEnforce") === true);
  });

  h.finish(server);
})();
