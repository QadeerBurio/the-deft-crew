// Owner (after P3b): the sign-in and profile replies use the safe shape (utils/safeRecord.js, as admin replies):
//   POST /api/auth/signup/verify-otp, GET /api/auth/profile/me, GET /api/auth/me, POST /api/auth/admin-login-as-brand
// never carry the password, codes, push tokens, webhook / store secrets or ID-card / live pictures, even when the
// account has them; everything else as before (the reply shapes, the added fields like isVip / logo, the token).
// Checked first: no app or portal screen reads any of the removed fields.
//   node tests/auth-safe-replies/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/auth", "./routes/auth.routes"]], models: ["EngagementEvent", "EngagementProfile", "PointsLedger", "OtpCode", "University"] });
const { call, check, oid, user, token, fake, coll } = h;

const SECRET_VALUES = {
  pushTokens: [{ token: "ExponentPushToken[secret-token-1]" }], webhookSecret: "whsec_secret_value", wooConsumerKey: "ck_secret_value", wooConsumerSecret: "cs_secret_value",
  shopifyAccessToken: "shpat_secret_value", idCardFront: "https://res.cloudinary.com/x/id-front.jpg", idCardBack: "https://res.cloudinary.com/x/id-back.jpg", livePicture: "https://res.cloudinary.com/x/live.jpg",
  resetPasswordToken: "reset_secret_value",
};
const HIDDEN = [...Object.keys(SECRET_VALUES), "password", "otp", "otpCode"];
const leaks = (obj) => { const txt = JSON.stringify(obj || {}); return HIDDEN.filter((k) => new RegExp(`"${k}"`).test(txt)).concat(Object.values(SECRET_VALUES).flat().map((v) => (typeof v === "string" ? v : v.token)).filter((v) => txt.includes(v))); };

const S = oid(); const B = oid(); const A = oid();
fake.seed(coll("User"), [
  user(S, "student", "Sana Malik", { emailVerified: true, referralCode: "SANA01", ...SECRET_VALUES }),
  user(B, "brand", "Cafe Owner", { brandName: "Chai Spot", logo: "https://x/logo.png", brandApprovalStatus: "approved", ...SECRET_VALUES }),
  user(A, "admin", "Ada Admin"),
]);
const T = { S: token(S, "student"), B: token(B, "brand"), A: token(A, "admin") };

(async () => {
  const server = h.start();
  // (the harness's own leak scan also checks every reply here)
  let r = await call("POST", "/api/auth/signup/verify-otp", { body: { userId: String(S), otp: "123456" } });
  check("verify-otp (already confirmed → signed in): token and user as before", r.status === 200 && r.json.success === true && !!r.json.token && r.json.user?.name === "Sana Malik", r.text.slice(0, 160));
  check("…no secret or ID-card field in the user", leaks(r.json.user).length === 0, leaks(r.json.user).join());

  r = await call("GET", "/api/auth/profile/me", { tok: T.S });
  check("profile/me: as before (name, referralCode, the added isVip / cardStatus / paymentStatus)", r.status === 200 && r.json.name === "Sana Malik" && r.json.referralCode === "SANA01" && r.json.isVip === false && "cardStatus" in r.json && "paymentStatus" in r.json, r.text.slice(0, 160));
  check("…no secret or ID-card field", leaks(r.json).length === 0, leaks(r.json).join());

  // GET /me: it used to be answered by GET /:id (owner: moved before it, tests/auth-me-and-id); checked over HTTP and
  // its handler directly.
  r = await call("GET", "/api/auth/me", { tok: T.B });
  check("GET /api/auth/me (now before /:id, owner): 200 over HTTP, safe shape", r.status === 200 && r.json.brandName === "Chai Spot" && leaks(r.json).length === 0, r.text.slice(0, 160));
  const router = h.reqS("./routes/auth.routes");
  const layer = router.stack.find((l) => l.route && l.route.path === "/me" && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = await new Promise((resolve) => { handler({ userId: String(B) }, { json: (j) => resolve({ status: 200, json: JSON.parse(JSON.stringify(j)) }), status: (c) => ({ json: (j) => resolve({ status: c, json: j }) }) }); });
  check("me's own handler (a brand): as before (brandName, logo, companyName)", out.status === 200 && out.json.brandName === "Chai Spot" && out.json.logo === "https://x/logo.png" && out.json.companyName === "Chai Spot", JSON.stringify(out).slice(0, 160));
  check("…no store keys, webhook secret, push tokens or ID cards", leaks(out.json).length === 0, leaks(out.json).join());

  r = await call("POST", "/api/auth/admin-login-as-brand", { tok: T.A, body: { brandId: String(B) } });
  check("admin-login-as-brand: token and brand as before", r.status === 200 && !!r.json.token && r.json.user?.brandName === "Chai Spot", r.text.slice(0, 160));
  check("…no store keys or secrets in the brand", leaks(r.json.user).length === 0, leaks(r.json.user).join());
  r = await call("POST", "/api/auth/admin-login-as-brand", { tok: T.S, body: { brandId: String(B) } });
  check("…a student still can't (403)", r.status === 403);

  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
