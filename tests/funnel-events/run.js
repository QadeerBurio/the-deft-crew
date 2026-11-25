// Funnel events (upgrade/p0-safety, plan P0-3), on in-memory data, POST /api/engagement/events:
//   - the older five client events work exactly as before (stored, meta as sent, never rate-limited)
//   - every upgrade v2 funnel name is accepted and stored as an EngagementEvent (source client); anything else 400
//   - a guest gets 204 and nothing is stored
//   - funnel meta keeps only small plain values (no nesting, no long strings, at most 10 keys)
//   - one row per user + name + day; meta.refId gives one row per refId
//   - a per-user limit (RATE_LIMIT_FUNNEL_EVENTS_MAX) applies to funnel events only: 429 with RATE_LIMITED
//   node tests/funnel-events/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/engagement", "./routes/engagement.routes"]],
  models: ["EngagementEvent", "EngagementProfile"],
});
const { reqS, call, check, rows, oid, user, token, fake, coll } = h;
const { isFunnelEvent } = reqS("./config/funnelEvents");

const ids = { S: oid(), S2: oid(), S3: oid() };
fake.seed(coll("User"), [user(ids.S, "student", "Sana Student"), user(ids.S2, "student", "Omar Student"), user(ids.S3, "student", "Ali Student")]);
const T = { S: token(ids.S, "student"), S2: token(ids.S2, "student"), S3: token(ids.S3, "student") };
const ev = (tok, name, meta) => call("POST", "/api/engagement/events", { tok, body: { name, meta } });
const events = (f = () => true) => rows("EngagementEvent", f);

(async () => {
  const server = h.start();

  let r = await ev(T.S, "app_open", { screen: "Home", nested: { a: 1 } });
  check("older event app_open → 204", r.status === 204, r.text);
  const ao = events((e) => e.name === "app_open");
  check("…stored once, source client, meta exactly as sent (unchanged behaviour)", ao.length === 1 && ao[0].source === "client" && ao[0].meta?.nested?.a === 1, JSON.stringify(ao));

  r = await ev(T.S, "invite_code_prefilled", { channel: "wa", deep: { x: 1 }, long: "y".repeat(300), n: 3, ok: true, "bad key": 1 });
  check("funnel event invite_code_prefilled → 204", r.status === 204, r.text);
  const ic = events((e) => e.name === "invite_code_prefilled");
  check("…stored, source client", ic.length === 1 && ic[0].source === "client");
  const m = ic[0]?.meta || {};
  check("…meta: plain values kept, nested and bad keys dropped, long string cut to 100", m.channel === "wa" && m.n === 3 && m.ok === true && !("deep" in m) && !("bad key" in m) && m.long.length === 100, JSON.stringify(m));

  for (const n of ["amb_intro_card_3", "resume_step_done_4", "share_card_savings", "template_customised_palette", "resume_downloaded_campus", "confession_precheck_hold", "confession_appeal_opened", "resume_writer_letter", "resume_writer_pdf"]) {
    r = await ev(T.S2, n, {});
    check(`${n} → 204, stored`, r.status === 204 && events((e) => e.name === n).length === 1, r.text);
  }
  for (const n of ["points_awarded", "amb_intro_card_9", "share_card_", "social_posted", "<script>"]) {
    r = await ev(T.S2, n, {});
    check(`${n} → 400, nothing stored`, r.status === 400 && events((e) => e.name === n).length === 0, `${r.status}`);
  }

  r = await ev(null, "resume_finished", {});
  check("guest → 204, nothing stored", r.status === 204 && events((e) => e.name === "resume_finished").length === 0, r.text);

  await ev(T.S, "resume_finished", {});
  await ev(T.S, "resume_finished", {});
  check("same name, same day, no refId: one row", events((e) => e.name === "resume_finished" && String(e.user) === String(ids.S)).length === 1);
  await ev(T.S, "resume_step_done_1", { refId: "resume-a" });
  await ev(T.S, "resume_step_done_1", { refId: "resume-b" });
  await ev(T.S, "resume_step_done_1", { refId: "resume-b" });
  check("with refId: one row per refId", events((e) => e.name === "resume_step_done_1").length === 2);

  check("the server list and the route agree", isFunnelEvent("signup_with_ref") && !isFunnelEvent("app_open"));

  process.env.RATE_LIMIT_FUNNEL_EVENTS_MAX = "3";
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await ev(T.S3, "confession_reported", { refId: `c${i}` })).status);
  check("funnel limit: 3 accepted, the 4th → 429", codes.slice(0, 3).every((c) => c === 204) && codes[3] === 429, codes.join(","));
  r = await ev(T.S3, "confession_reported", { refId: "c9" });
  check("…429 body: RATE_LIMITED", r.status === 429 && r.json?.error?.code === "RATE_LIMITED", r.text);
  const olds = [];
  for (let i = 0; i < 5; i++) olds.push((await ev(T.S3, "push_opened", {})).status);
  check("…older events from the same student are never limited", olds.every((c) => c === 204), olds.join(","));
  delete process.env.RATE_LIMIT_FUNNEL_EVENTS_MAX;

  h.finish(server);
})();
