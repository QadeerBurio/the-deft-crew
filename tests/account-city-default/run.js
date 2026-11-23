// Owner (P3b): a NEW student account starts with no city and no location (they used to be "Karachi" /
// "Karachi, Pakistan" whether or not the student gave them). Brands and employers keep "Karachi" (their address
// geocoding uses it). Existing accounts are unchanged, including old ones that never stored the field.
//   node tests/account-city-default/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/auth", "./routes/auth.routes"]], models: ["EngagementEvent", "EngagementProfile", "PointsLedger", "OtpCode", "University"] });
const { call, check, reqS, rows } = h;
const User = reqS("./models/User");
const mongoose = reqS("mongoose");

(async () => {
  const server = h.start();
  console.log("-- the model");
  const st = new User({ name: "New Student", role: "student", email: "a@x.co" });
  check("a new student: city '' and location ''", st.city === "" && st.location === "", JSON.stringify([st.city, st.location]));
  const br = new User({ name: "Cafe", role: "brand", email: "b@x.co" });
  check("a new brand: 'Karachi' / 'Karachi, Pakistan' as before", br.city === "Karachi" && br.location === "Karachi, Pakistan");
  const em = new User({ name: "Hiring", role: "employee", email: "c@x.co" });
  check("a new employer: as before", em.city === "Karachi" && em.location === "Karachi, Pakistan");
  const given = new User({ name: "L", role: "student", city: "Lahore", location: "Lahore, Pakistan" });
  check("a city the student gives is kept", given.city === "Lahore" && given.location === "Lahore, Pakistan");
  const old = User.hydrate({ _id: new mongoose.Types.ObjectId(), name: "Old", role: "student", email: "old@x.co" });
  check("an existing student that never stored them reads exactly as before (Karachi)", old.city === "Karachi" && old.location === "Karachi, Pakistan");
  const oldSet = User.hydrate({ _id: new mongoose.Types.ObjectId(), name: "Old2", role: "student", city: "Quetta", location: "Quetta" });
  check("…and stored values are untouched", oldSet.city === "Quetta" && oldSet.location === "Quetta");

  console.log("-- signup");
  const pw = "Passw0rd!x";
  let r = await call("POST", "/api/auth/signup", { body: { role: "student", email: "s-new@test.local", password: pw, phone: "03001234567", fullName: "Student New", universityName: "SZABIST", rollNo: "21K-1" } });
  let u = rows("User", (x) => x.email === "s-new@test.local")[0];
  check("student signup without a city: none stored", r.status >= 200 && r.status < 300 && u && u.city === "" && u.location === "", `${r.status} ${JSON.stringify([u?.city, u?.location])}`);
  r = await call("POST", "/api/auth/signup", { body: { role: "student", email: "s-city@test.local", password: pw, phone: "03001234568", fullName: "Student City", universityName: "SZABIST", rollNo: "21K-2", city: "Hyderabad" } });
  u = rows("User", (x) => x.email === "s-city@test.local")[0];
  check("student signup with a city: kept", u && u.city === "Hyderabad");
  // brands / employers: the route keeps "Karachi" (checked in the source: a brand signup reply carries the whole new
  // account, a pre-existing reply shape reported to the owner, so it is not called here)
  const src = require("fs").readFileSync(require("path").join(h.SERVER, "routes", "auth.routes.js"), "utf8");
  check("signup: no city → '' for students, 'Karachi' for everyone else", src.includes("city: city?.trim() || (role === \"student\" ? \"\" : \"Karachi\"),"));

  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
