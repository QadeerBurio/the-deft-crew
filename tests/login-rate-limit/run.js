// Login brute-force protection (fix/login-rate-limit), POST /api/auth/login, on in-memory data:
//   - 5 wrong passwords for an email lock it: the 6th try (even with the right password) gets 429 LOGIN_LOCKED,
//     Retry-After and a plain message (minutes + reset your password); other emails still sign in
//   - admins are locked the same way; unknown emails count like wrong passwords
//   - a correct password clears that email's count
//   - per IP: many wrong tries from one address across emails lock that address (another address is fine); the
//     address is the LAST X-Forwarded-For entry (what Railway's proxy appends), so a client can't dodge it by
//     adding its own entries
//   - the lock ends after LOGIN_LOCK_MIN
//   node tests/login-rate-limit/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/auth", "./routes/auth.routes"]], models: ["OtpCode", "University"] });
const { call, check, oid, user, fake, coll, reqS } = h;
const bcrypt = reqS("bcryptjs");
const guard = reqS("./services/loginGuard");

const hash = bcrypt.hashSync("right-password-1", 4);
const ids = { S: oid(), S2: oid(), A: oid() };
const u = (id, role, email) => ({ ...user(id, role, email.split("@")[0]), email, password: hash, emailVerified: true });
fake.seed(coll("User"), [u(ids.S, "student", "sana@uni.pk"), u(ids.S2, "student", "ali@uni.pk"), u(ids.A, "admin", "admin@tdc.pk")]);
const login = (email, password, ip = "203.0.113.10", extraXff) => call("POST", "/api/auth/login", { body: { email, password }, headers: { "x-forwarded-for": extraXff || ip } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = h.start();
  let r;
  for (const k of ["LOGIN_MAX_FAILS_PER_EMAIL", "LOGIN_MAX_FAILS_PER_IP", "LOGIN_WINDOW_MIN", "LOGIN_LOCK_MIN"]) delete process.env[k];

  r = await login("sana@uni.pk", "right-password-1");
  check("the right password signs in (200, a token, no password in the reply)", r.status === 200 && !!r.json?.token && !/\$2[ab]\$/.test(r.text), `${r.status}`);

  // ---------- per email ----------
  guard._reset();
  const wrong = [];
  for (let i = 0; i < 5; i++) wrong.push((await login("sana@uni.pk", "nope" + i, `198.51.100.${i + 1}`)).status);
  check("5 wrong passwords (from 5 different addresses): each a normal 401", wrong.every((s) => s === 401), wrong.join(","));
  r = await login("sana@uni.pk", "right-password-1", "198.51.100.99");
  check("the 6th try, even with the right password and a new address: 429 LOGIN_LOCKED", r.status === 429 && r.json?.code === "LOGIN_LOCKED" && !r.json?.token, `${r.status} ${r.text.slice(0, 120)}`);
  const retry = Number(r.headers?.["retry-after"] || r.json?.retryAfterSeconds);
  check("…with Retry-After (~15 minutes) and a plain message that says when and offers a reset", retry > 800 && retry <= 900 && /Too many sign-in attempts\. Try again in 15 minutes, or reset your password\./.test(r.json?.message || ""), `${retry} ${r.json?.message}`);
  r = await login("ali@uni.pk", "right-password-1");
  check("another email still signs in meanwhile", r.status === 200 && !!r.json?.token);

  // ---------- admins too ----------
  guard._reset();
  for (let i = 0; i < 5; i++) await login("admin@tdc.pk", "guess" + i, `192.0.2.${i + 1}`);
  r = await login("admin@tdc.pk", "right-password-1", "192.0.2.77");
  check("admin logins are locked the same way (429 after 5 wrong)", r.status === 429 && r.json?.code === "LOGIN_LOCKED");

  // ---------- unknown emails count ----------
  guard._reset();
  for (let i = 0; i < 5; i++) await login("ghost@nowhere.pk", "x", `192.0.2.${i + 20}`);
  r = await login("ghost@nowhere.pk", "x", "192.0.2.40");
  check("unknown emails count like wrong passwords (429 after 5)", r.status === 429);
  r = await login("GHOST@nowhere.pk ", "x", "192.0.2.41");
  check("…matched case- and space-insensitively", r.status === 429);

  // ---------- success clears the count ----------
  guard._reset();
  for (let i = 0; i < 4; i++) await login("sana@uni.pk", "nope" + i);
  r = await login("sana@uni.pk", "right-password-1");
  check("4 wrong then the right one: signed in", r.status === 200);
  for (let i = 0; i < 4; i++) await login("sana@uni.pk", "again" + i);
  r = await login("sana@uni.pk", "right-password-1");
  check("…the count started again: 4 more wrong are still allowed", r.status === 200, `${r.status}`);

  // ---------- per IP ----------
  guard._reset();
  process.env.LOGIN_MAX_FAILS_PER_IP = "6";
  for (let i = 0; i < 6; i++) await login(`nobody${i}@x.pk`, "x", "203.0.113.50");
  r = await login("ali@uni.pk", "right-password-1", "203.0.113.50");
  check("6 wrong tries across emails from one address lock that address (even a right password: 429)", r.status === 429 && r.json?.code === "LOGIN_LOCKED", `${r.status}`);
  r = await login("ali@uni.pk", "right-password-1", "203.0.113.51");
  check("another address is fine", r.status === 200);
  r = await login("ali@uni.pk", "right-password-1", null, "9.9.9.9, 203.0.113.50");
  check("adding a fake address in front doesn't dodge it (the last entry counts)", r.status === 429);
  r = await login("ali@uni.pk", "right-password-1", null, "203.0.113.50, 198.51.100.200");
  check("the last entry is what's checked", r.status === 200);
  delete process.env.LOGIN_MAX_FAILS_PER_IP;

  // ---------- the lock ends ----------
  guard._reset();
  process.env.LOGIN_LOCK_MIN = "0.01"; // 0.6 s
  for (let i = 0; i < 5; i++) await login("sana@uni.pk", "nope" + i);
  r = await login("sana@uni.pk", "right-password-1");
  check("locked right after", r.status === 429);
  await sleep(800);
  r = await login("sana@uni.pk", "right-password-1");
  check("after LOGIN_LOCK_MIN the right password signs in again", r.status === 200, `${r.status}`);
  delete process.env.LOGIN_LOCK_MIN;

  // a body-less request doesn't crash (Express 5)
  r = await call("POST", "/api/auth/login", {});
  check("a request without a body: a normal error, not a crash", r.status !== 500 && r.status !== 0, `${r.status}`);

  h.finish(server);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
