// The unauthenticated reward-code routes are gone (fix/engagement-redemptions-auth):
//   POST /api/engagement/redemptions/lookup, /redemptions/:id/use, /redemptions/auto-expire had no sign-in check (the
//   lookup returned a student's name, email and roll number for any code). Now 404 for everyone — signed out, guest,
//   student, brand, admin — and nothing is read or changed. The brand routes (/brand/redemptions/*) still need a
//   signed-in brand and still work.
//   node tests/engagement-redemptions-auth/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/engagement", "./routes/engagement.routes"]], models: ["Reward", "RewardRedemption"] });
const { call, check, rows, same, oid, user, token, fake, coll } = h;

const ids = { S1: oid(), B1: oid(), admin: oid(), R1: oid(), RD: oid() };
fake.seed(coll("User"), [
  user(ids.S1, "student", "Sana Student", { rollNo: "21K-0001" }),
  user(ids.B1, "brand", "Alpha Cafe", { brandName: "Alpha Cafe" }),
  user(ids.admin, "admin", "Admin One"),
]);
const now = Date.now();
fake.seed(coll("Reward"), [{ _id: ids.R1, title: "Free coffee", description: "one coffee", costPoints: 100, kind: "voucher", brand: ids.B1, active: true, validDays: 30, createdAt: new Date() }]);
fake.seed(coll("RewardRedemption"), [{ _id: ids.RD, user: ids.S1, reward: ids.R1, rewardBrand: ids.B1, code: "TDC-ABCD-1234", status: "active", expiresAt: new Date(now + 10 * 864e5), createdAt: new Date(), updatedAt: new Date() }]);
const T = { S1: token(ids.S1, "student"), B1: token(ids.B1, "brand"), admin: token(ids.admin, "admin") };
const snapshot = () => JSON.stringify(rows("RewardRedemption"));

(async () => {
  const server = h.start();
  const before = snapshot();
  const callers = [["signed out", null], ["a student", T.S1], ["a brand", T.B1], ["an admin", T.admin]];
  for (const [who, tok] of callers) {
    let r = await call("POST", "/api/engagement/redemptions/lookup", { tok, body: { code: "TDC-ABCD-1234" } });
    check(`lookup is gone for ${who}: 404, no student details`, r.status === 404 && !/Sana|@test\.local|21K-0001/.test(r.text), `${r.status} ${r.text.slice(0, 120)}`);
    r = await call("POST", `/api/engagement/redemptions/${ids.RD}/use`, { tok, body: {} });
    check(`'use' is gone for ${who}: 404`, r.status === 404, `${r.status} ${r.text.slice(0, 120)}`);
    r = await call("POST", "/api/engagement/redemptions/auto-expire", { tok, body: {} });
    check(`auto-expire is gone for ${who}: 404`, r.status === 404, `${r.status} ${r.text.slice(0, 120)}`);
  }
  check("nothing was read into a reply or changed: the redemption is still active and unused", snapshot() === before && rows("RewardRedemption")[0].status === "active");

  // the brand routes stay: a signed-in brand only
  let r = await call("POST", "/api/engagement/brand/redemptions/lookup", { body: { code: "TDC-ABCD-1234" } });
  check("brand lookup signed out: refused (401/403)", [401, 403].includes(r.status) && !/Sana|21K-0001/.test(r.text), `${r.status}`);
  r = await call("POST", "/api/engagement/brand/redemptions/lookup", { tok: T.S1, body: { code: "TDC-ABCD-1234" } });
  check("brand lookup as a student: 403", r.status === 403 && !/21K-0001/.test(r.text), `${r.status}`);
  r = await call("POST", "/api/engagement/brand/redemptions/lookup", { tok: T.B1, body: { code: "tdc-abcd-1234" } });
  check("brand lookup as the reward's brand: still works", r.status === 200 && r.json && r.json.valid !== false, `${r.status} ${r.text.slice(0, 160)}`);
  r = await call("POST", `/api/engagement/brand/redemptions/${ids.RD}/use`, { tok: T.S1, body: {} });
  check("brand 'use' as a student: 403, still active", r.status === 403 && rows("RewardRedemption")[0].status === "active", `${r.status}`);

  h.finish(server);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
