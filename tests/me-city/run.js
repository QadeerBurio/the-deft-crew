// P5b "is your city right?" (flag cityCheck), on in-memory data: POST /api/me/city.
//   flag off: 404 (as if absent); a guest: refused; a brand: 404
//   { confirm: true }: the city stays, cityConfirmedAt set; with no city yet: 400
//   { city }: set (trimmed, single spaces) + cityConfirmedAt; not a city name (digits, too short / long, a link): 400
//   nothing else on the account changes; the user model's field is optional (old accounts read as before)
//   node tests/me-city/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/me", "./routes/meCity.routes"]] });
const { call, check, oid, user, token, fake, coll, rows, same } = h;

const S = oid(); const N = oid(); const B = oid();
fake.seed(coll("User"), [
  user(S, "student", "Sana Student", { city: "Karachi" }),
  user(N, "student", "Nida New", { city: "" }),
  user(B, "brand", "Chai Spot", { city: "Karachi" }),
]);
const T = { S: token(S, "student"), N: token(N, "student"), B: token(B, "brand") };
const me = (id) => rows("User", (u) => same(u._id, id))[0];

(async () => {
  const server = h.start();
  delete process.env.FLAG_CITY_CHECK;
  let r = await call("POST", "/api/me/city", { tok: T.S, body: { confirm: true } });
  check("flag off: 404 (as if absent), nothing changed", r.status === 404 && !me(S).cityConfirmedAt, r.status);

  process.env.FLAG_CITY_CHECK = `ids:${S},${N},${B}`;
  r = await call("POST", "/api/me/city", { body: { confirm: true } });
  check("no sign-in (a guest): refused", r.status === 404 || r.status === 401, r.status);
  r = await call("POST", "/api/me/city", { tok: T.B, body: { confirm: true } });
  check("a brand account: 404", r.status === 404, r.status);

  const before = JSON.stringify({ ...me(S), cityConfirmedAt: undefined, updatedAt: undefined });
  r = await call("POST", "/api/me/city", { tok: T.S, body: { confirm: true } });
  check("confirm: 200, the city stays, cityConfirmedAt set", r.status === 200 && r.json.city === "Karachi" && !!r.json.cityConfirmedAt && me(S).city === "Karachi" && !!me(S).cityConfirmedAt, JSON.stringify(r.json));
  check("…nothing else on the account changes", JSON.stringify({ ...me(S), cityConfirmedAt: undefined, updatedAt: undefined }) === before);

  r = await call("POST", "/api/me/city", { tok: T.N, body: { confirm: true } });
  check("confirm with no city yet: 400 with a sentence", r.status === 400 && /pick your city/.test(r.json?.error || ""), JSON.stringify(r.json));
  r = await call("POST", "/api/me/city", { tok: T.N, body: { city: "  Lahore   Cantt " } });
  check("set a city: trimmed, single spaces, cityConfirmedAt set", r.status === 200 && me(N).city === "Lahore Cantt" && !!me(N).cityConfirmedAt, JSON.stringify(r.json));
  for (const bad of ["K", "12345", "https://x.test", "a".repeat(61), "<b>Karachi</b>", ""]) {
    r = await call("POST", "/api/me/city", { tok: T.N, body: { city: bad } });
    check(`not a city name (${JSON.stringify(bad).slice(0, 20)}): 400, unchanged`, r.status === 400 && me(N).city === "Lahore Cantt", r.status);
  }
  r = await call("POST", "/api/me/city", { tok: T.N, body: { city: "Rawalpindi" } });
  check("changing it again later works", r.status === 200 && me(N).city === "Rawalpindi");

  const schema = h.reqS("./models/User").schema.path("cityConfirmedAt");
  check("User.cityConfirmedAt: an optional date (no default, not required)", schema && schema.instance === "Date" && !schema.isRequired && schema.defaultValue === undefined);
  delete process.env.FLAG_CITY_CHECK;
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
