// r9 / r10 launch (owner): the master switches launchV2 and launchLinks (config/featureFlags.js)
//   r10: launchV2 is ON for every student by default (a student role default): a student with no settings gets all 38
//   launch flags; employers and brands get none
//   launchLinks (resumePublicPage + confessionShare) and the never-included flags stay off
//   force-disable wins: an admin's "off" for the account (one flag or launchV2 itself), the students' default turned off,
//   or the Railway kill switch
//   with the students' default turned off: today's app (every listed flag off), and per-account "on" still works
//   confession safety: the built-in mode is observe
//   node tests/r9-launch/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/app", "./routes/appFlags.routes"]], models: ["SafetySettings"] });
const { call, check, oid, user, token, fake, coll, reqS } = h;
const F = reqS("./config/featureFlags");
const S = oid(); const O = oid(); const E = oid(); const B = oid();
fake.seed(coll("User"), [user(S, "student", "Ayesha Khan"), user(O, "student", "Other Student"), user(E, "employee", "Emma Employer"), user(B, "brand", "Some Brand")]);
const st = (id) => ({ id: String(id), role: "student" });
const flagsOf = async (id, role = "student") => (await call("GET", "/api/app/flags/me", { tok: token(id, role) })).json || {};
const env = (name) => `FLAG_${name.replace(/([A-Z])/g, "_$1").toUpperCase()}`;

(async () => {
  F.setBuiltInDefaults(true); // production: role defaults with no row are on (opt-in switches excepted)
  F.setAccountRoles([[String(E), "employee"], [String(B), "brand"]]);
  const server = h.start();
  check("38 flags in launchV2, 2 in launchLinks, 6 never included; every name is a real flag", F.LAUNCH_V2.length === 38 && F.LAUNCH_LINKS.length === 2 && F.LAUNCH_NEVER.length === 6 && [...F.LAUNCH_V2, ...F.LAUNCH_LINKS, ...F.LAUNCH_NEVER].every((f) => F.FLAGS[f]));
  check("…and none overlap (voting, enforcement switches, the gettdc.pk links are not in launchV2)", !F.LAUNCH_V2.some((f) => F.LAUNCH_LINKS.includes(f) || F.LAUNCH_NEVER.includes(f)) && !F.LAUNCH_V2.includes("confessionsVoting"));

  console.log("-- r10: on by default for every student");
  check("launchV2 is a student role default (on), launchLinks is not (opt-in)", F.ROLE_DEFAULTS.student.includes("launchV2") && F.roleDefaultOf("launchV2", "student") === true && F.roleDefaultOf("launchLinks", "student") === null);
  check("…the startup line shows it", /student \{[^}]*launchV2 on[^}]*launchLinks not set\}/.test(F.describeDefaults()), F.describeDefaults());
  let fl = await flagsOf(S);
  const notOn = F.LAUNCH_V2.filter((f) => fl[f] !== true);
  check("a student with no settings: GET /api/app/flags/me has launchV2 and all 38 launch flags on", fl.launchV2 === true && notOn.length === 0, notOn.join(","));
  check("…source 'launchV2' for each", F.LAUNCH_V2.every((f) => F.flagState(f, st(S)).source === "launchV2"));
  check("…launchLinks, resumePublicPage, confessionShare off", fl.launchLinks === false && F.LAUNCH_LINKS.every((f) => fl[f] === false));
  check("…the never-included off (confessionsVoting and the enforcement switches)", F.LAUNCH_NEVER.every((f) => !F.isEnabled(f, st(S))) && fl.confessionsVoting === false);
  const emp = await flagsOf(E, "employee");
  const brand = await flagsOf(B, "brand");
  check("an employer gets none of them", emp.launchV2 === false && F.LAUNCH_V2.every((f) => !F.isEnabled(f, { id: String(E), role: "employee" })));
  check("a brand gets none of them", brand.launchV2 === false && F.LAUNCH_V2.every((f) => !F.isEnabled(f, { id: String(B), role: "brand" })));

  console.log("-- force-disable wins");
  F.applyAdminAccess("resumeWriter", String(S), false);
  check("an admin's 'off' for one flag on the account", F.isEnabled("resumeWriter", st(S)) === false && F.isEnabled("resumeV2", st(S)) === true);
  F.applyAdminAccess("resumeWriter", String(S), null);
  F.applyAdminAccess("launchV2", String(S), false);
  check("an admin's 'off' for launchV2 on the account: that student is back to today's app", F.LAUNCH_V2.every((f) => !F.isEnabled(f, st(S))) && F.isEnabled("resumeV2", st(O)));
  F.applyAdminAccess("launchV2", String(S), null);
  process.env[env("confessionPolls")] = "off";
  check("the Railway kill switch for one flag", F.isEnabled("confessionPolls", st(S)) === false && F.flagState("confessionPolls", st(S)).source === "kill");
  delete process.env[env("confessionPolls")];
  process.env.FLAG_LAUNCH_V2 = "off";
  check("the Railway kill switch for launchV2 itself: off for everyone", F.LAUNCH_V2.every((f) => !F.isEnabled(f, st(S)) && !F.isEnabled(f, st(O))));
  delete process.env.FLAG_LAUNCH_V2;

  console.log("-- the students' default turned off by an admin: today's app");
  F.applyDefault("launchV2", "student", false);
  fl = await flagsOf(S);
  check("every listed flag off (the flags endpoint as before r9)", fl.launchV2 === false && [...F.LAUNCH_V2, ...F.LAUNCH_LINKS].every((f) => fl[f] === false));
  F.applyAdminAccess("launchV2", String(S), true);
  check("…one account forced on still gets them; the other student doesn't", F.LAUNCH_V2.every((f) => F.isEnabled(f, st(S))) && F.LAUNCH_V2.every((f) => !F.isEnabled(f, st(O))));
  F.applyAdminAccess("launchV2", String(S), null);
  F.applyDefault("launchV2", "student", null);
  check("…the row removed: on again for every student (no row = on since r10)", F.LAUNCH_V2.every((f) => F.isEnabled(f, st(S)) && F.isEnabled(f, st(O))));

  console.log("-- launchLinks (opt-in until DNS)");
  F.applyAdminAccess("launchLinks", String(S), true);
  check("launchLinks on for an account: resumePublicPage and confessionShare on", F.isEnabled("resumePublicPage", st(S)) && F.isEnabled("confessionShare", st(S)) && !F.isEnabled("confessionShare", st(O)));
  F.applyAdminAccess("launchLinks", String(S), null);

  console.log("-- confession safety default");
  reqS("./services/safetySettings")._reset();
  check("the built-in mode is observe (the owner switches to enforce)", (await reqS("./services/safetySettings").get()).mode === "observe");
  h.finish(server);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e) + String.fromCharCode(10)); process.exit(1); });
