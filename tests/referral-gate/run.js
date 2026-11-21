// referralVerifyGate (P1 follow-up, owner): referral rewards wait for the new student's e-mail code.
//   flag off: signup with a code pays the referrer +50 +100 and the new student +100 at once, as today
//   flag on (for the referrer): nothing at signup; entering the e-mail code pays exactly those three, once;
//     a wrong code pays nothing; verifying again (or creditReferral on the first sort) never pays twice;
//     verifiedReferralCount counts only referees who confirmed their e-mail
//   already-paid rewards are never touched when the flag is switched on later
//   node tests/referral-gate/run.js [serverDir]
const crypto = require("crypto");
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/auth", "./routes/auth.routes"]],
  models: ["EngagementEvent", "EngagementProfile", "PointsLedger", "OtpCode", "University"],
});
const { call, check, oid, user, fake, coll, rows, reqS } = h;

const R = oid(); const R2 = oid();
fake.seed(coll("User"), [
  user(R, "student", "Rida Referrer", { referralCode: "RIDA11" }),
  user(R2, "student", "Saad Second", { referralCode: "SAAD22" }),
]);
const bal = (id) => rows("EngagementProfile").find((p) => String(p.user) === String(id))?.points?.balance || 0;
const ledgerFor = (refereeId) => rows("PointsLedger").filter((l) => String(l.refId) === String(refereeId) || String(l.user) === String(refereeId)).map((l) => `${l.reason}:${l.delta}`).sort();
const THREE = ["referral:signup_bonus:50", "referral:verified:100", "referral:welcome:100"];
const quiet = (fn) => async (...a) => { const l = console.log; console.log = () => {}; try { return await fn(...a); } finally { console.log = l; } };
let n = 0;
const signup = quiet(async (code) => {
  n++;
  const r = await call("POST", "/api/auth/signup", { body: { role: "student", email: `new${n}@test.local`, password: "Strong#Pass9", fullName: `New Student${n}`, universityName: "SZABIST", rollNo: `21K-${n}`, referralCodeInput: code } });
  return { r, id: r.json?.userId };
});
// the code is e-mailed; the test sets a known one (same hash as routes/auth.routes.js)
const setCode = async (userId, otp) => {
  const row = rows("OtpCode").find((o) => String(o.user) === String(userId));
  const codeHash = crypto.createHash("sha256").update(`${otp}:${process.env.JWT_SECRET}`).digest("hex");
  await reqS("./models/OtpCode").updateOne({ _id: row._id }, { $set: { codeHash } });
};
const verify = quiet((userId, otp) => call("POST", "/api/auth/signup/verify-otp", { body: { userId: String(userId), otp } }));
const settle = () => new Promise((r) => setTimeout(r, 30));

(async () => {
  const server = h.start();

  console.log("-- flag off: as today");
  let { r, id: a } = await signup("RIDA11");
  check("signup with a code: 201, the e-mail code step", r.status === 201 && r.json.requiresVerification === true, r.text);
  check("…paid at signup: referrer +150, new student +100", bal(R) === 150 && bal(a) === 100 && JSON.stringify(ledgerFor(a)) === JSON.stringify(THREE), `${bal(R)} ${bal(a)} ${ledgerFor(a)}`);
  await setCode(a, "111111");
  r = await verify(a, "111111");
  check("…entering the code signs in and pays nothing more", r.status === 200 && !!r.json.token && bal(R) === 150 && bal(a) === 100);

  console.log("-- flag on for the referrer");
  process.env.FLAG_REFERRAL_VERIFY_GATE = `ids:${R}`;
  const before = bal(R);
  let b; ({ r, id: b } = await signup("RIDA11"));
  await settle();
  check("signup with a code: still 201 and the code step", r.status === 201 && r.json.requiresVerification === true, r.text);
  check("…no reward before the e-mail is verified (referrer, new student, ledger)", bal(R) === before && bal(b) === 0 && ledgerFor(b).length === 0, `${bal(R)} ${bal(b)} ${ledgerFor(b)}`);
  const popupsFor = (who) => (rows("EngagementProfile").find((p) => String(p.user) === String(R))?.pendingPopups || []).filter((x) => x.payload?.refereeId === String(who));
  check("…no '+150' popup for the referrer yet", popupsFor(b).length === 0);
  check("…the raw signup count still goes up", rows("User").find((u) => String(u._id) === String(R)).referralCount === 2);
  const prof = () => rows("EngagementProfile").find((p) => String(p.user) === String(R));
  await setCode(b, "222222");
  r = await verify(b, "999999");
  check("a wrong code pays nothing", r.status === 400 && bal(R) === before && bal(b) === 0);
  let c; ({ id: c } = await signup("RIDA11")); // a third referee who doesn't verify
  r = await verify(b, "222222");
  await settle();
  check("the right code: signed in", r.status === 200 && !!r.json.token, r.text);
  check("…verifiedReferralCount counts only referees who confirmed their e-mail (a, b; not c)", prof().verifiedReferralCount === 2 && bal(c) === 0, String(prof().verifiedReferralCount));
  check("…paid exactly once: referrer +150, new student +100, the three ledger rows", bal(R) === before + 150 && bal(b) === 100 && JSON.stringify(ledgerFor(b)) === JSON.stringify(THREE), `${bal(R)} ${bal(b)} ${ledgerFor(b)}`);
  check("…one '+150' popup for the referrer now", popupsFor(b).length === 1 && popupsFor(b)[0].payload.amount === 150);
  check("…the event is stored (source server)", rows("EngagementEvent").some((e) => e.name === "referral_signup_bonus" && e.meta?.refereeId === String(b) && e.source === "server"));
  r = await verify(b, "222222");
  const { onEmailVerified } = reqS("./services/engagement/referralSignup");
  const again = await quiet(onEmailVerified)(rows("User").find((u) => String(u._id) === String(b)));
  await quiet(reqS("./services/engagement/referral").creditReferral)(b);
  check("no double pay: verifying again, a second call, and the first-sort credit", bal(R) === before + 150 && bal(b) === 100 && again.paid === false && again.reason === "already_paid" && ledgerFor(b).length === 3, `${bal(R)} ${bal(b)} ${JSON.stringify(again)}`);

  console.log("-- other accounts and already-paid rewards");
  let d; ({ id: d } = await signup("SAAD22"));
  check("a referrer outside the rule: paid at signup, as today", bal(R2) === 150 && bal(d) === 100);
  process.env.FLAG_REFERRAL_VERIFY_GATE = "on";
  const pre = [bal(R), bal(a), bal(R2), bal(d)];
  await setCode(d, "333333");
  r = await verify(d, "333333");
  const res = await quiet(onEmailVerified)(rows("User").find((u) => String(u._id) === String(a)));
  check("switching the flag on later: verifying a paid account pays nothing more; balances unchanged", r.status === 200 && JSON.stringify([bal(R), bal(a), bal(R2), bal(d)]) === JSON.stringify(pre) && res.paid === false, `${pre} → ${[bal(R), bal(a), bal(R2), bal(d)]}`);
  ({ r } = await signup(undefined));
  check("signup without a code: nothing to do either way", r.status === 201);
  delete process.env.FLAG_REFERRAL_VERIFY_GATE;
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
