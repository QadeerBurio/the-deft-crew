// r8: the public routes added in the upgrade that had no limit now answer 429 past their per-address limit (set low
// here); below it they answer as before.
//   GET/POST /api/safety/action/:token, GET /api/crew/config, GET /api/crew/credentials/:id/pdf, GET /api/invites/config,
//   GET /r/fonts/:file
//   node tests/public-limits/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
for (const k of ["RATE_LIMIT_SAFETY_ACTION_MAX", "RATE_LIMIT_PUBLIC_CONFIG_MAX", "RATE_LIMIT_CREDENTIAL_PDF_MAX", "RATE_LIMIT_RESUME_FONTS_MAX"]) process.env[k] = "2";
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/safety", "./routes/safetyActions.routes"], ["/api/crew", "./routes/crew.routes"], ["/api/invites", "./routes/invites.routes"], ["/r", "./routes/publicResume.routes"]],
  models: ["SafetyAction", "Blocklist", "Resume"],
});
const { call, check } = h;
(async () => {
  const server = h.start();
  const font = [...h.reqS("./services/publicResume").FONT_FILES][0];
  for (const [m, url, label] of [
    ["GET", "/api/safety/action/not-a-real-token", "safety e-mail link (page)"],
    ["GET", "/api/crew/config", "crew config"],
    ["GET", "/api/crew/credentials/000000000000000000000001/pdf", "credential PDF link"],
    ["GET", "/api/invites/config", "invites config"],
    ["GET", `/r/fonts/${font}`, "public resume font"],
  ]) {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await call(m, url, { body: m === "POST" ? {} : undefined })).status);
    check(`${label}: the first 2 answer as before, the 3rd → 429 (${codes.join(",")})`, codes[0] !== 429 && codes[1] !== 429 && codes[2] === 429);
  }
  const post = await call("POST", "/api/safety/action/not-a-real-token", { body: {} });
  check("…the link's page and action share one limit per address (a POST after that → 429)", post.status === 429);
  h.finish(server);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e) + String.fromCharCode(10)); process.exit(1); });
