// P1 invites and referrals (upgrade/p1-growth), on in-memory data:
//   POST /api/invites/:code/open: no sign-in; a student's code → { valid, firstName } and a ReferralClick row (channel,
//     user agent, a hash of the address, never the address); bad / unknown / non-student codes → { valid: false }, no
//     row; unknown channel → "unknown"; rate-limited per address (429)
//   GET /api/invites/config: { enabled } = growthV2 for nobody in particular (only FLAG_GROWTH_V2=on)
//   GET /referrals/validate/:code: first name only, profileImage null, for everyone; rate-limited per address (429)
//   GET /referrals/leaderboard: first names, no photos (everyone); period=month counts this Karachi month's
//     'referral:verified' ledger rows; university filter; me { rank, count } and next { name, more }; old reply keys kept
//   node tests/invites-referrals/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/invites", "./routes/invites.routes"], ["/api/engagement", "./routes/engagement.routes"]],
  models: ["ReferralClick", "EngagementProfile", "PointsLedger", "University"],
});
const { call, check, oid, user, token, fake, coll, rows } = h;

const U1 = oid(); const U2 = oid();
fake.seed(coll("University"), [{ _id: U1, name: "Alpha" }, { _id: U2, name: "Beta" }]);
const S = {}; const T = {};
const mk = (k, name, uni, extra = {}) => { S[k] = oid(); T[k] = token(S[k], "student"); return user(S[k], "student", name, { university: uni, ...extra }); };
fake.seed(coll("User"), [
  mk("aisha", "Aisha Khan Durrani", U1, { referralCode: "AISHA1" }),
  mk("bilal", "Bilal Ahmed", U1, { referralCode: "BILAL2" }),
  mk("chand", "Chand Bibi", U2, { referralCode: "CHAND3" }),
  mk("me", "Mehr Me", U1, { referralCode: "MEHR44" }),
]);
const brandId = oid(); fake.STORE.get(coll("User")).push(user(brandId, "brand", "Some Brand", { referralCode: "BRAND9" }));
// all-time verified counts
fake.seed(coll("EngagementProfile"), [
  { _id: oid(), user: S.aisha, verifiedReferralCount: 9 }, { _id: oid(), user: S.bilal, verifiedReferralCount: 5 },
  { _id: oid(), user: S.chand, verifiedReferralCount: 7 }, { _id: oid(), user: S.me, verifiedReferralCount: 4 },
]);
// this month: bilal 3, me 2, chand 1; last month: aisha 5 (doesn't count this month)
const now = new Date(); const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10));
const led = (who, at) => ({ _id: oid(), user: S[who], reason: "referral:verified", delta: 100, createdAt: at, updatedAt: at });
fake.seed(coll("PointsLedger"), [
  led("bilal", now), led("bilal", now), led("bilal", now), led("me", now), led("me", now), led("chand", now),
  ...[1, 2, 3, 4, 5].map(() => led("aisha", lastMonth)),
]);
const open = (code, body = {}, ip = "203.0.113.9") => call("POST", `/api/invites/${code}/open`, { body, headers: { "x-forwarded-for": ip, "user-agent": "Mozilla/5.0 test" } });

(async () => {
  const server = h.start();

  console.log("-- invite opens");
  let r = await open("aisha1", { channel: "wa" });
  check("a student's code (any case), no sign-in → valid, first name only", r.status === 200 && r.json.valid === true && r.json.firstName === "Aisha", r.text);
  const clicks = rows("ReferralClick");
  check("…one ReferralClick: code, referrer, channel wa, user agent", clicks.length === 1 && clicks[0].code === "AISHA1" && String(clicks[0].referrer) === String(S.aisha) && clicks[0].channel === "wa" && clicks[0].userAgent === "Mozilla/5.0 test");
  check("…the address is stored only as a hash", clicks[0].ip && clicks[0].ip !== "203.0.113.9" && /^[0-9a-f]{32}$/.test(clicks[0].ip) && !JSON.stringify(clicks).includes("203.0.113.9"));
  r = await open("AISHA1", { channel: "telegram" });
  check("an unknown channel → 'unknown'", rows("ReferralClick")[1]?.channel === "unknown");
  for (const [name, code] of [["unknown code", "ZZZZ99"], ["malformed code", "a b<c>"], ["a brand's code", "BRAND9"]]) {
    const before = rows("ReferralClick").length;
    r = await open(encodeURIComponent(code), { channel: "wa" });
    check(`${name} → { valid: false }, nothing logged`, r.status === 200 && r.json.valid === false && !("firstName" in r.json) && rows("ReferralClick").length === before, r.text);
  }
  process.env.RATE_LIMIT_INVITE_OPEN_MAX = "2";
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await open("BILAL2", {}, "198.51.100.7")).status);
  check("rate limit per address: 2 then 429", codes.join(",") === "200,200,429", codes.join(","));
  check("…another address is not affected", (await open("BILAL2", {}, "198.51.100.8")).status === 200);
  delete process.env.RATE_LIMIT_INVITE_OPEN_MAX;

  console.log("-- config");
  r = await call("GET", "/api/invites/config");
  check("config: growthV2 off by default → enabled false", r.status === 200 && r.json.enabled === false);
  process.env.FLAG_GROWTH_V2 = `ids:${S.aisha}`;
  r = await call("GET", "/api/invites/config");
  check("…a per-account rule doesn't turn it on for signed-out phones", r.json.enabled === false);
  process.env.FLAG_GROWTH_V2 = "on";
  r = await call("GET", "/api/invites/config");
  check("…FLAG_GROWTH_V2=on → enabled true", r.json.enabled === true);
  delete process.env.FLAG_GROWTH_V2;

  console.log("-- validate");
  r = await call("GET", "/api/engagement/referrals/validate/aisha1", { headers: { "x-forwarded-for": "192.0.2.1" } });
  check("validate: first name only, profileImage null (for everyone)", r.status === 200 && r.json.valid === true && r.json.referrer.name === "Aisha" && r.json.referrer.profileImage === null && !/Durrani|Khan/.test(r.text), r.text);
  r = await call("GET", "/api/engagement/referrals/validate/NOPE00", { headers: { "x-forwarded-for": "192.0.2.1" } });
  check("…unknown code: as before", r.json.valid === false && r.json.reason === "code not found");
  process.env.RATE_LIMIT_REFERRAL_VALIDATE_MAX = "3";
  const vc = [];
  for (let i = 0; i < 4; i++) vc.push((await call("GET", `/api/engagement/referrals/validate/TRY00${i}`, { headers: { "x-forwarded-for": "192.0.2.50" } })).status);
  check("…rate-limited per address (3 then 429)", vc.join(",") === "200,200,200,429", vc.join(","));
  delete process.env.RATE_LIMIT_REFERRAL_VALIDATE_MAX;

  console.log("-- leaderboard");
  r = await call("GET", "/api/engagement/referrals/leaderboard", { tok: T.me });
  let lb = r.json?.leaderboard || [];
  check("all-time (default): same keys as before, ordered by verified count", r.status === 200 && lb.map((x) => x.name).join(",") === "Aisha,Chand,Bilal,Mehr" && lb.every((x) => "rank" in x && "userId" in x && "profileImage" in x && "verifiedCount" in x), JSON.stringify(lb));
  check("…first names only, no photos", lb.every((x) => !/ /.test(x.name) && x.profileImage === null) && !/Durrani|Ahmed|Bibi/.test(r.text));
  check("…me: rank 4 with 4; next: pass Bilal with 2 more", r.json.period === "all" && r.json.me?.rank === 4 && r.json.me.count === 4 && r.json.next?.name === "Bilal" && r.json.next.more === 2, JSON.stringify({ me: r.json.me, next: r.json.next }));
  r = await call("GET", "/api/engagement/referrals/leaderboard?period=month", { tok: T.me });
  lb = r.json?.leaderboard || [];
  check("period=month: this month's verified referrals only (Aisha's are last month)", r.json.period === "month" && lb.map((x) => `${x.name}:${x.verifiedCount}`).join(",") === "Bilal:3,Mehr:2,Chand:1", JSON.stringify(lb));
  check("…me rank 2, next: pass Bilal with 2 more", r.json.me?.rank === 2 && r.json.next?.name === "Bilal" && r.json.next.more === 2);
  r = await call("GET", `/api/engagement/referrals/leaderboard?period=month&university=${U1}`, { tok: T.me });
  check("university filter: only Alpha's students", (r.json.leaderboard || []).map((x) => x.name).join(",") === "Bilal,Mehr", JSON.stringify(r.json.leaderboard));
  r = await call("GET", "/api/engagement/referrals/leaderboard?university=not-an-id", { tok: T.me });
  check("a bad university id is ignored (all students)", (r.json.leaderboard || []).length === 4);
  r = await call("GET", "/api/engagement/referrals/leaderboard");
  check("still needs sign-in", r.status === 401 || r.status === 403, `${r.status}`);

  h.finish(server);
})();
