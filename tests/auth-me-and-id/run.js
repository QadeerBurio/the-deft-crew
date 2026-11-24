// Owner (after P3b):
//   GET /api/auth/me now comes before GET /:id (which used to answer it with 400 "Invalid User ID format"): each
//     portal role gets its own details (brand, employer, travel partner, admin), in the safe shape
//   GET /api/auth/:id:
//     self        own record, safe shape (no password, codes, push tokens, store secrets, ID-card pictures)
//     admin       Phase A check (students.view; refused for a member without it once enforced); phone and e-mail only
//                 with pii.view (masked without it, enforced or not); secrets never; ID-card pictures are select: false
//                 in the model, so this route never returned them (admins see them through the verification routes)
//     anyone else other students, brands, guests: 403, as before
//   node tests/auth-me-and-id/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/auth", "./routes/auth.routes"]], models: ["EngagementEvent", "EngagementProfile", "PointsLedger", "OtpCode", "University"] });
const { call, check, oid, user, token, fake, coll } = h;
const jwt = h.reqS("jsonwebtoken");

const SECRETS = { pushTokens: [{ token: "ExponentPushToken[s1]" }], webhookSecret: "whsec_x", wooConsumerKey: "ck_x", shopifyAccessToken: "shpat_x", resetPasswordToken: "reset_x" };
const DOCS = { idCardFront: "https://res.cloudinary.com/x/front.jpg", idCardBack: "https://res.cloudinary.com/x/back.jpg", livePicture: "https://res.cloudinary.com/x/live.jpg" };
const hasSecret = (o) => Object.keys(SECRETS).some((k) => k in (o || {})) || /whsec_x|ck_x|shpat_x|reset_x|ExponentPushToken/.test(JSON.stringify(o || {}));
const hasDocs = (o) => Object.keys(DOCS).some((k) => k in (o || {}));

const S = oid(); const S2 = oid(); const B = oid(); const E = oid(); const TR = oid(); const A = oid(); const M1 = oid(); const M2 = oid();
fake.seed(coll("User"), [
  user(S, "student", "Sana Malik", { email: "sana@test.local", phone: "03001234567", ...SECRETS, ...DOCS }),
  user(S2, "student", "Other Student"),
  user(B, "brand", "Cafe Owner", { brandName: "Chai Spot", logo: "https://x/logo.png", brandApprovalStatus: "approved", city: "Lahore", ...SECRETS }),
  user(E, "employee", "Hiring Lead", { companyName: "Acme Pvt", logo: "https://x/acme.png", ...SECRETS }),
  user(TR, "traveler", "Trail Co", { companyName: "Trail Co", ...SECRETS }),
  user(A, "admin", "Ada Admin"), // an admin today: every permission but team.manage (pii.view included)
  user(M1, "admin", "Member With Students", { adminAccess: { level: "member", permissions: ["students.view"], status: "active" } }),
  user(M2, "admin", "Member Brands Only", { adminAccess: { level: "member", permissions: ["brands.view"], status: "active" } }),
]);
const T = Object.fromEntries(Object.entries({ S, S2, B, E, TR, A, M1, M2 }).map(([k, id]) => [k, token(id, k === "S" || k === "S2" ? "student" : k === "B" ? "brand" : k === "E" ? "employee" : k === "TR" ? "traveler" : "admin")]));
const guest = jwt.sign({ id: "guest-user", role: "guest", isGuest: true }, "test-only", { expiresIn: "1h" });

(async () => {
  const server = h.start();
  console.log("-- GET /me (the portal's screens)");
  let r = await call("GET", "/api/auth/me", { tok: T.B });
  check("brand: 200 with its details (Home, Brand Settings)", r.status === 200 && r.json.brandName === "Chai Spot" && r.json.logo === "https://x/logo.png" && r.json.companyName === "Chai Spot" && r.json.city === "Lahore" && r.json.brandApprovalStatus === "approved", r.text.slice(0, 160));
  check("…safe shape", !hasSecret(r.json));
  r = await call("GET", "/api/auth/me", { tok: T.E });
  check("employer: 200 (Company Dashboard, Employer Settings)", r.status === 200 && r.json.companyName === "Acme Pvt" && r.json.logo === "https://x/acme.png" && r.json.name === "Hiring Lead" && !hasSecret(r.json));
  r = await call("GET", "/api/auth/me", { tok: T.TR });
  check("travel partner: 200 (Travel Settings)", r.status === 200 && r.json.name === "Trail Co" && !hasSecret(r.json));
  r = await call("GET", "/api/auth/me", { tok: T.A });
  check("admin: 200 (Admin Jobs Manager)", r.status === 200 && r.json.name === "Ada Admin");
  r = await call("GET", "/api/auth/me", { tok: T.S });
  check("a student (the app's token check): 200, safe, no ID cards", r.status === 200 && r.json.name === "Sana Malik" && !hasSecret(r.json) && !hasDocs(r.json));
  r = await call("GET", "/api/auth/me");
  check("signed out: refused", r.status === 401 || r.status === 403);

  console.log("-- GET /:id");
  r = await call("GET", `/api/auth/${S}`, { tok: T.S });
  check("self: own record (name, phone, e-mail as stored)", r.status === 200 && r.json.name === "Sana Malik" && r.json.phone === "03001234567" && r.json.email === "sana@test.local", r.text.slice(0, 160));
  check("…safe shape: no secrets, no ID-card pictures", !hasSecret(r.json) && !hasDocs(r.json));
  r = await call("GET", `/api/auth/${S}`, { tok: T.S2 });
  check("another student: 403", r.status === 403);
  r = await call("GET", `/api/auth/${S}`, { tok: T.B });
  check("a brand: 403", r.status === 403);
  r = await call("GET", `/api/auth/${S}`, { tok: guest });
  check("a guest: 403", r.status === 403 || r.status === 401);
  r = await call("GET", `/api/auth/${S}`, { tok: T.A });
  check("admin with pii.view: phone and e-mail as stored (ID-card pictures are select: false in the model: never part of this reply, before or now)", r.status === 200 && r.json.phone === "03001234567" && r.json.email === "sana@test.local" && !hasDocs(r.json), JSON.stringify({ s: r.status, phone: r.json?.phone }));
  check("…never the secrets", !hasSecret(r.json));
  r = await call("GET", `/api/auth/${S}`, { tok: T.M1 });
  check("admin member with students.view but not pii.view: masked phone / e-mail, no ID-card pictures", r.status === 200 && r.json.name === "Sana Malik" && r.json.phone !== "03001234567" && /•/.test(r.json.phone) && /•/.test(r.json.email) && !hasDocs(r.json) && !hasSecret(r.json), JSON.stringify({ phone: r.json?.phone, email: r.json?.email }));
  r = await call("GET", `/api/auth/${S}`, { tok: T.M2 });
  check("admin member without students.view, shadow mode: allowed and logged as before, but no personal data", r.status === 200 && /•/.test(r.json.phone) && !hasDocs(r.json));
  process.env.FLAG_ADMIN_RBAC_ENFORCE = "on";
  r = await call("GET", `/api/auth/${S}`, { tok: T.M2 });
  check("…once enforced: 403", r.status === 403);
  r = await call("GET", `/api/auth/${S}`, { tok: T.M1 });
  check("…the member with students.view still gets the masked record", r.status === 200 && /•/.test(r.json.phone));
  delete process.env.FLAG_ADMIN_RBAC_ENFORCE;
  r = await call("GET", "/api/auth/not-an-id", { tok: T.S });
  check("a bad id: 400 as before", r.status === 400);

  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
