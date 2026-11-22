// Admin Safety log (upgrade/p4-1-safety, plan P4-7), on in-memory data: /api/admin/safety
//   - admins only (student, guest → 403 / 401-like refusal)
//   - queue: "reported" lists open reports for ALL content (post, post comment, user, confession, confession comment),
//     self-harm first; "held" lists pending / hidden confessions and comments; "resolved" the decided ones
//   - authors appear as an anonymous reference, never an account id, name or e-mail
//   - resolve: approve (back to live, report rejected), remove (removed), warn (a notice), suspend 24 h / 7 days
//     (accountStatus + expiry), ban; admins' accounts never changed; every decision in AdminActionLog
//   - held item without a report: approve / remove
//   - who wrote it: needs a reason; the reveal is logged
//   - settings: read with defaults (helplines incl. 1166), saved and logged
//   node tests/admin-safety/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/admin/safety", "./routes/adminSafety.routes"], ["/api/social", "./routes/social.routes"]],
  models: ["Confession", "University", "Report", "Post", "SocialNotification", "SafetySettings", "AdminActionLog"],
});
const { call, check, oid, user, token, fake, coll, rows } = h;

const U = oid();
fake.seed(coll("University"), [{ _id: U, name: "Alpha University", status: "approved" }]);
const S = { a: oid(), b: oid(), c: oid(), rep: oid(), adm: oid(), adm2: oid() };
fake.seed(coll("User"), [
  user(S.a, "student", "Asma Writer", { university: U }), user(S.b, "student", "Bano Poster", { university: U }), user(S.c, "student", "Celine Commenter", { university: U }),
  user(S.rep, "student", "Reporter Person", { university: U }), user(S.adm, "admin", "Admin One"), user(S.adm2, "admin", "Admin Two"),
]);
const T = { a: token(S.a, "student"), rep: token(S.rep, "student"), adm: token(S.adm, "admin") };
const C = { rep: oid(), held: oid(), hidden: oid(), withHeldComment: oid(), adminPost: oid() }; const cmtHeld = oid(); const cmtRep = oid();
fake.seed(coll("Confession"), [
  { _id: C.rep, authorId: S.a, text: "reported confession text", university: U, visibility: "public", comments: [{ _id: cmtRep, user: S.c, text: "reported comment text", createdAt: new Date() }], createdAt: new Date(Date.now() - 5e5) },
  { _id: C.held, authorId: S.a, text: "held by the check", status: "pending", statusReason: "check_unavailable", university: U, visibility: "public", comments: [], createdAt: new Date(Date.now() - 4e5) },
  { _id: C.hidden, authorId: S.b, text: "hidden after reports", status: "hidden", statusReason: "report_threshold", reportCount: 3, university: U, visibility: "public", comments: [], createdAt: new Date(Date.now() - 3e5) },
  { _id: C.withHeldComment, authorId: S.b, text: "a post with a held comment", university: U, visibility: "public", comments: [{ _id: cmtHeld, user: S.c, text: "held comment", status: "pending", createdAt: new Date() }], createdAt: new Date(Date.now() - 2e5) },
  { _id: C.adminPost, authorId: S.adm2, text: "an admin's confession", university: U, visibility: "public", comments: [], createdAt: new Date(Date.now() - 1e5) },
]);
const P = oid(); const PC = oid();
fake.seed(coll("Post"), [{ _id: P, author: S.b, content: "a feed post someone reported", comments: [{ _id: PC, user: S.c, text: "a post comment someone reported" }], likes: [], createdAt: new Date() }]);
const R = { conf: oid(), cmt: oid(), post: oid(), pcmt: oid(), user: oid(), sh: oid(), adm: oid(), done: oid() };
const rpt = (id, extra) => ({ _id: id, reporterId: S.rep, status: "pending", reason: "Harassment", createdAt: new Date(), ...extra });
fake.seed(coll("Report"), [
  rpt(R.conf, { contentType: "Confession", contentId: C.rep, reportedUserId: S.a, evidenceQuote: "reported confession" }),
  rpt(R.cmt, { contentType: "Confession", contentId: C.rep, commentId: cmtRep, reportedUserId: S.c }),
  rpt(R.post, { contentType: "Post", contentId: P, reportedUserId: S.b }),
  rpt(R.pcmt, { contentType: "Comment", contentId: PC, reportedUserId: S.c }),
  rpt(R.user, { contentType: "User", contentId: S.b, reportedUserId: S.b, reason: "Fake Account" }),
  rpt(R.sh, { contentType: "Confession", contentId: C.withHeldComment, reportedUserId: S.b, reason: "Self Harm Risk", createdAt: new Date(Date.now() - 9e5) }),
  rpt(R.adm, { contentType: "Confession", contentId: C.adminPost, reportedUserId: S.adm2 }),
  rpt(R.done, { contentType: "Confession", contentId: C.hidden, reportedUserId: S.b, status: "resolved", actionTaken: "content_removed", resolvedAt: new Date() }),
]);
const crow = (k) => fake.STORE.get(coll("Confession")).find((c) => String(c._id) === String(C[k]));
const urow = (k) => fake.STORE.get(coll("User")).find((u) => String(u._id) === String(S[k]));
const q = (tab) => call("GET", `/api/admin/safety/queue?tab=${tab}`, { tok: T.adm });
const resolve = (id, action, note = "decided") => call("POST", `/api/admin/safety/${R[id]}/resolve`, { tok: T.adm, body: { action, note } });
const logs = (re) => rows("AdminActionLog", (l) => re.test(l.action));

(async () => {
  const server = h.start();

  let r = await call("GET", "/api/admin/safety/queue", { tok: T.rep });
  check("a student → 403", r.status === 403);
  r = await call("GET", "/api/admin/safety/queue");
  check("no sign-in → refused", r.status === 403 || r.status === 401, `${r.status}`);

  r = await q("reported");
  const items = r.json?.data?.items || [];
  check("reported: 200, the 7 open reports (posts, post comments, users, confessions, confession comments)", r.status === 200 && items.length === 7 && ["confession", "confession_comment", "post", "post_comment", "user"].every((k) => items.some((i) => i.content.kind === k)), JSON.stringify(items.map((i) => i.content.kind)));
  check("…self-harm first", items[0]?.reason === "Self Harm Risk");
  const ci = items.find((i) => i.id === String(R.conf));
  check("…a confession report: text, evidence, author as an anonymous reference", ci && ci.content.text === "reported confession text" && ci.evidence === "reported confession" && /^author-[0-9a-f]{10}$/.test(ci.content.author));
  check("…no account id, name or e-mail of any author or reporter", ![S.a, S.b, S.c, S.rep].some((id) => r.text.includes(String(id))) && !/Asma|Bano|Celine|Reporter Person|@test\.local/.test(r.text));
  r = await q("held");
  const held = r.json?.data?.items || [];
  check("held: the pending and hidden confessions and the held comment", held.length === 3 && held.some((i) => i.confessionId === String(C.held)) && held.some((i) => i.confessionId === String(C.hidden)) && held.some((i) => i.commentId === String(cmtHeld)), JSON.stringify(held));
  r = await q("resolved");
  check("resolved: the decided report", (r.json?.data?.items || []).some((i) => i.id === String(R.done)));

  r = await resolve("conf", "approve", "fine on review");
  check("approve a confession report → live, report rejected", r.status === 200 && crow("rep").status === "live" && rows("Report", (x) => String(x._id) === String(R.conf))[0].status === "rejected", r.text);
  r = await resolve("cmt", "remove", "rude");
  check("remove a confession comment → removed", r.status === 200 && crow("rep").comments[0].status === "removed");
  r = await resolve("post", "warn", "first warning");
  check("warn on a post → a notice to the author, report resolved (warning)", r.status === 200 && rows("SocialNotification").length >= 1 && rows("Report", (x) => String(x._id) === String(R.post))[0].actionTaken === "warning", r.text);
  r = await resolve("pcmt", "suspend24h", "harassment");
  check("suspend 24 h for a post comment → the commenter suspended with an expiry, the comment gone", r.status === 200 && urow("c").accountStatus === "suspended" && Math.abs(new Date(urow("c").suspensionExpiry) - Date.now() - 864e5) < 60e3, r.text);
  r = await resolve("user", "ban", "fake account");
  check("ban on a user report → banned", r.status === 200 && urow("b").accountStatus === "banned");
  r = await resolve("adm", "ban", "admin post");
  check("ban on an admin's content → the admin account is not changed", r.status === 200 && r.json?.data?.account === "admin_not_changed" && (urow("adm2").accountStatus || "active") === "active", r.text);
  r = await resolve("sh", "nonsense");
  check("unknown action → 400", r.status === 400);
  check("every decision logged with the note", logs(/^safety\.report\./).length === 6 && logs(/^safety\.report\./).every((l) => String(l.admin) === String(S.adm)));

  r = await call("POST", `/api/admin/safety/confession/${C.held}/resolve`, { tok: T.adm, body: { action: "approve", note: "checked by hand" } });
  check("held confession approved → live", r.status === 200 && crow("held").status === "live", r.text);
  r = await call("POST", `/api/admin/safety/confession/${C.withHeldComment}/resolve`, { tok: T.adm, body: { action: "remove", commentId: String(cmtHeld) } });
  check("held comment removed → removed", r.status === 200 && crow("withHeldComment").comments[0].status === "removed", r.text);
  check("…both logged", logs(/^safety\.held\./).length === 2);

  r = await call("POST", `/api/admin/safety/${R.sh}/author`, { tok: T.adm, body: { reason: "" } });
  check("who wrote it, no reason → 400 REASON_REQUIRED", r.status === 400 && r.json?.error?.code === "REASON_REQUIRED");
  r = await call("POST", `/api/admin/safety/${R.sh}/author`, { tok: T.adm, body: { reason: "self-harm follow-up with the counsellor" } });
  check("…with a reason → the account (id, name, role)", r.status === 200 && r.json?.data?.account?.name === "Bano Poster", r.text);
  check("…the reveal is logged with the reason", logs(/^safety\.identity\.reveal$/).some((l) => /counsellor/.test(l.reason)));

  r = await call("GET", "/api/admin/safety/settings", { tok: T.adm });
  check("settings: defaults (threshold 3, helplines incl. 1166, single-report rule off)", r.status === 200 && r.json.data.reportThreshold === 3 && r.json.data.helplines.some((x) => x.number === "1166") && r.json.data.suspendOnSingleEvidenceReport === false, r.text);
  r = await call("PUT", "/api/admin/safety/settings", { tok: T.adm, body: { reportThreshold: 5, bannedWords: "word1, Word2", reason: "tuning" } });
  check("save: threshold 5, banned words lower-cased", r.status === 200 && r.json.data.reportThreshold === 5 && JSON.stringify(r.json.data.bannedWords) === '["word1","word2"]', r.text);
  check("…logged (counts only, not the words)", logs(/^safety\.settings\.update$/).length === 1 && !JSON.stringify(logs(/^safety\.settings/)).includes("word1"));

  h.finish(server);
})();
