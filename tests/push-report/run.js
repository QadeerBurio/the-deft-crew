// N-6 push report (upgrade/phase-n): GET /api/admin/engagement/push-report and the opt-out records behind it
//   only tracked pushes count (pushOpenTracking rows); failed, untracked and older rows don't
//   per type: sent / delivered / opened, opt-outs within 24 h of a push of that type; rates only from
//   PUSH_REPORT_MIN_SENT sends (null below: "not enough data yet", never 0%); review: open rate under 3% or
//   opt-outs on 2% or more; per day per type
//   opt-outs are recorded only for tracked accounts: a switch turned off, a quieter mode, the permission taken away
//   admins only
//   node tests/push-report/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/admin/engagement", "./routes/adminEngagement.routes"], ["/api/engagement", "./routes/engagement.routes"]],
  models: ["PushLog", "EngagementEvent", "EngagementProfile"],
});
const { call, check, oid, user, token, fake, coll, rows } = h;

const ADMIN = oid(); const S = oid(); const B = oid();
const students = Array.from({ length: 60 }, () => oid());
fake.seed(coll("User"), [user(ADMIN, "admin", "Ada Admin"), user(S, "student", "Sana Malik"), user(B, "student", "Bilal Ahmed"), ...students.map((id, i) => user(id, "student", `Student ${i}`))]);
fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: S, notifPrefs: { posts: true }, osPushPermission: "granted" }, { _id: oid(), user: B, notifPrefs: {}, osPushPermission: "granted" }]);
const T = { admin: token(ADMIN, "admin"), S: token(S, "student"), B: token(B, "student") };
const hoursAgo = (h2) => new Date(Date.now() - h2 * 3600e3);
const log = (u, type, h2, extra = {}) => ({ _id: oid(), user: u, type, tracked: true, status: "sent", sentAt: hoursAgo(h2), createdAt: hoursAgo(h2), deliveredAt: null, openedAt: null, ...extra });
const seed = [
  // 60 social posts: 50 delivered, 1 opened → 1.7% → review
  ...students.map((u, i) => log(u, "social_post", 5, { deliveredAt: i < 50 ? hoursAgo(5) : null, openedAt: i === 0 ? hoursAgo(4) : null })),
  // 10 replies: not enough data
  ...students.slice(0, 10).map((u) => log(u, "reply", 30, { deliveredAt: hoursAgo(30), openedAt: hoursAgo(29) })),
  log(S, "daily_drop", 2, { tracked: undefined }), // untracked
  log(S, "daily_drop", 2, { status: "failed" }), // failed
  log(S, "daily_drop", 24 * 40), // older than the window
];
fake.seed(coll("PushLog"), seed);
fake.seed(coll("EngagementEvent"), [
  { _id: oid(), user: students[1], name: "notif_opt_out", meta: { key: "posts" }, source: "server", createdAt: hoursAgo(3) }, // 2 h after a social push
  { _id: oid(), user: students[2], name: "notif_opt_out", meta: { key: "posts" }, source: "server", createdAt: hoursAgo(1) },
  { _id: oid(), user: students[59], name: "notif_opt_out", meta: { key: "deals" }, source: "server", createdAt: hoursAgo(48) }, // no push in the 24 h before
]);

(async () => {
  const server = h.start();
  console.log("-- the report");
  let r = await call("GET", "/api/admin/engagement/push-report?days=14", { tok: T.S });
  check("students: 403", r.status === 403);
  r = await call("GET", "/api/admin/engagement/push-report?days=14", { tok: T.admin });
  check("admin: 200", r.status === 200, r.text.slice(0, 200));
  const t = Object.fromEntries((r.json.types || []).map((x) => [x.type, x]));
  check("only tracked, sent pushes in the window (untracked, failed, older left out)", r.json.tracking.trackedPushes === 70 && !t.daily_drop, JSON.stringify(r.json.tracking));
  check("social_post: 60 sent, 50 delivered, 1 opened, 2 opt-outs within 24 h", t.social_post.sent === 60 && t.social_post.delivered === 50 && t.social_post.opened === 1 && t.social_post.optOuts24h === 2, JSON.stringify(t.social_post));
  check("…rates: open 1.7%, delivered 83.3%, opt-outs 3.3% → review", t.social_post.openRate === 1.7 && t.social_post.deliveredRate === 83.3 && t.social_post.optOutRate === 3.3 && t.social_post.review === true && t.social_post.enough === true, JSON.stringify(t.social_post));
  check("reply: 10 sent → no rates (not enough data yet), never 0%, not flagged", t.reply.sent === 10 && t.reply.openRate === null && t.reply.deliveredRate === null && t.reply.enough === false && t.reply.review === false);
  check("an opt-out with no push in the 24 h before is not attributed", r.json.optOuts.total === 3 && r.json.optOuts.unattributed === 1);
  check("per day per type", r.json.byDay.some((d) => d.type === "social_post" && d.sent === 60 && d.opened === 1) && r.json.byDay.some((d) => d.type === "reply" && d.sent === 10));
  check("enoughData, minSent 50, tracking not configured here (no flag)", r.json.enoughData === true && r.json.minSent === 50 && r.json.tracking.configured === false);
  process.env.PUSH_REPORT_MIN_SENT = "5";
  r = await call("GET", "/api/admin/engagement/push-report", { tok: T.admin });
  check("PUSH_REPORT_MIN_SENT: replies get rates from 5 sends", r.json.types.find((x) => x.type === "reply").openRate === 100);
  delete process.env.PUSH_REPORT_MIN_SENT;
  r = await call("GET", "/api/admin/engagement/push-report?days=1", { tok: T.admin });
  check("days=1: only the last day", r.json.days === 1 && !r.json.types.some((x) => x.type === "reply"));

  console.log("-- opt-outs are recorded for tracked accounts only");
  const outs = (who) => rows("EngagementEvent", (e) => e.name === "notif_opt_out" && String(e.user) === String(who)).map((e) => e.meta.key);
  await call("PUT", "/api/engagement/notification-prefs", { tok: T.B, body: { posts: false } });
  check("flag off (B): nothing recorded", outs(B).length === 0);
  process.env.FLAG_PUSH_OPEN_TRACKING = `ids:${S}`;
  r = await call("PUT", "/api/engagement/notification-prefs", { tok: T.S, body: { posts: false, deals: true } });
  check("a switch turned off: recorded ('posts'); a switch left on: not", r.status === 200 && JSON.stringify(outs(S)) === '["posts"]', JSON.stringify(outs(S)));
  await call("PUT", "/api/engagement/notification-prefs", { tok: T.S, body: { posts: false } });
  check("…turning it off again: not counted twice", outs(S).length === 1);
  process.env.FLAG_NOTIF_SETTINGS_V2 = `ids:${S}`;
  await call("PUT", "/api/engagement/notification-prefs", { tok: T.S, body: { mode: "quiet" } });
  await call("PUT", "/api/engagement/notification-prefs", { tok: T.S, body: { mode: "everything" } });
  check("a quieter mode: recorded ('mode:quiet'); a louder one: not", JSON.stringify(outs(S)) === '["posts","mode:quiet"]', JSON.stringify(outs(S)));
  r = await call("POST", "/api/engagement/push-permission", { tok: T.S, body: { status: "denied" } });
  check("the phone's permission taken away (granted → denied): recorded", r.status === 204 && outs(S).includes("os_permission"));
  await call("POST", "/api/engagement/push-permission", { tok: T.S, body: { status: "denied" } });
  check("…denied again: not counted twice", outs(S).filter((k) => k === "os_permission").length === 1);
  check("the events are stored as source server", rows("EngagementEvent", (e) => e.name === "notif_opt_out" && String(e.user) === String(S)).every((e) => e.source === "server"));
  delete process.env.FLAG_PUSH_OPEN_TRACKING; delete process.env.FLAG_NOTIF_SETTINGS_V2;

  console.log("-- the admin win-back nudge (was a 500: an empty file shadowed inactivity.js)");
  r = await call("POST", `/api/admin/engagement/nudge/win-back/${S}`, { tok: T.admin, body: { days: 10 } });
  check("POST nudge/win-back: 200 now; without pushCopyV2 nothing is sent", r.status === 200 && r.json.sent === false && r.json.reason === "push_copy_v2_off", r.text);
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
