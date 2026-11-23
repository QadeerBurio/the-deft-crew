// Owner (after P3b): the brand / employer signup reply uses the safe shape (utils/safeRecord.js, as admin replies):
// no password, codes, push tokens, webhook / store secrets or ID-card / live pictures; everything else as before
// (message, user with _id, name, email, role, brand name…). The harness's leak scan covers every reply here.
//   node tests/signup-safe-reply/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/auth", "./routes/auth.routes"]], models: ["EngagementEvent", "EngagementProfile", "PointsLedger", "OtpCode", "University"] });
const { call, check, rows } = h;
const HIDDEN = ["password", "pushTokens", "webhookSecret", "wooConsumerKey", "wooConsumerSecret", "shopifyAccessToken", "idCardFront", "idCardBack", "livePicture", "otp", "resetPasswordToken"];

(async () => {
  const server = h.start();
  const pw = "Passw0rd!x";
  for (const [role, extra] of [["brand", { brandName: "New Cafe" }], ["employee", { fullName: "Hiring Co" }], ["traveler", { fullName: "Trail Co" }]]) {
    const email = `${role}-safe@test.local`;
    const r = await call("POST", "/api/auth/signup", { body: { role, email, password: pw, phone: "03001234567", city: "Lahore", ...extra } });
    const u = r.json?.user || {};
    check(`${role} signup: 201 and the same reply shape (message, user)`, r.status === 201 && r.json.message === "Signup successful" && !!u._id && u.email === email && u.role === role, `${r.status} ${r.text.slice(0, 160)}`);
    check(`${role}: no hidden field in the reply, even empty`, HIDDEN.every((k) => !(k in u)), HIDDEN.filter((k) => k in u).join());
    check(`${role}: the account itself is unchanged (stored as before)`, rows("User", (x) => x.email === email).length === 1);
  }
  const b = (await call("POST", "/api/auth/signup", { body: { role: "brand", email: "brand2@test.local", password: pw, phone: "03001234568", brandName: "Chai Spot", city: "Lahore" } })).json.user;
  check("brand fields the app uses are still there (brandName, city, status)", b.brandName === "Chai Spot" && b.city === "Lahore" && !!b.status);
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
