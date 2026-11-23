// P2 ambassador programme (upgrade/p2-ambassador): /api/crew (student) and the admin crew additions
//   flag ambassadorV2 off → the student routes are 404 (as if they didn't exist); the public verify / config routes work
//   P2-1 invitation: verified student, account ≥ 7 days, not a partner / applicant, a good moment in the last 48 h;
//        asked once, "not now" → again after 30 days (at most twice), "never" / "more" → never
//   P2-3 application: university id stored, chips / groups, one per student, re-apply 30 days after a rejection;
//        admin review: note → reviewNote, partner.universityId (older applications: by the name), a personal push
//   campus count: by university id, older ambassadors by name
//   P2-5 hub, daily card (only real campaigns), credentials: letters as drafts (admin writes + approves), PDF with a
//        10-minute link, public verify page (valid / revoked), rate-limited; campus moments: photo + caption, moderated
//   P2-7 bring your squad (flag squadMission): 3 e-mail-verified friends this Karachi week → the reward once;
//        the referee's welcome popup with the real amount
//   node tests/crew-ambassador/run.js [serverDir]
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/crew", "./routes/crew.routes"], ["/api/admin/crew", "./routes/adminCrew.routes"]],
  models: ["EngagementProfile", "PartnerApplication", "PartnerPost", "Credential", "PointsLedger", "PromoCode", "Confession", "University", "Campaign", "EngagementEvent"],
});
const { call, check, oid, user, token, fake, coll, rows, reqS, same } = h;

const DAY = 24 * 3600e3;
const ago = (d) => new Date(Date.now() - d * DAY);
const ADMIN = oid(); const S = oid(); const NEW = oid(); const UNV = oid(); const AMB = oid(); const OLD = oid(); const F = [oid(), oid(), oid(), oid()];
const NED = oid(); const LUMS = oid();
fake.seed(coll("University"), [{ _id: NED, name: "NED University" }, { _id: LUMS, name: "LUMS" }]);
fake.seed(coll("User"), [
  user(ADMIN, "admin", "Ada Admin"),
  user(S, "student", "Sana Malik", { createdAt: ago(30), university: NED, referralCode: "SANA01" }),
  user(NEW, "student", "Nida New", { createdAt: ago(2), university: NED }),
  user(UNV, "student", "Umar Unverified", { createdAt: ago(30), status: "Pending", university: NED }),
  user(AMB, "student", "Ali Ambassador", { createdAt: ago(90), university: NED, referralCode: "ALI001" }),
  user(OLD, "student", "Omar Older", { createdAt: ago(200), universityName: "NED University" }),
  // Sana's friend joined yesterday and verified the e-mail → a good moment
  user(F[0], "student", "Friend One", { createdAt: ago(1), referredBy: S, emailVerified: true }),
]);
fake.seed(coll("EngagementProfile"), [
  { _id: oid(), user: S, points: { balance: 0, lifetime: 0 } },
  { _id: oid(), user: NEW }, { _id: oid(), user: UNV },
  { _id: oid(), user: AMB, partner: { type: "ambassador", since: ago(60), university: "NED University", universityId: NED } },
  // an older ambassador: the name only
  { _id: oid(), user: OLD, partner: { type: "ambassador", since: ago(150), university: "ned university" } },
  { _id: oid(), user: F[0] },
]);
const T = { admin: token(ADMIN, "admin"), S: token(S, "student"), NEW: token(NEW, "student"), UNV: token(UNV, "student"), AMB: token(AMB, "student"), OLD: token(OLD, "student") };
const profileOf = (id) => rows("EngagementProfile", (p) => same(p.user, id))[0];

// stubs: the moderation and the push gateway (no network)
const check2 = reqS("./services/confessionCheck");
let verdict = "ok";
check2.check = async () => ({ verdict, reasons: verdict === "ok" ? [] : [{ code: "x", message: "x" }], severe: false, aiOk: verdict !== "hold" });
const deleted = [];
reqS("./services/confessionImages").deleteImage = async (url) => { deleted.push(url); };
const pushes = [];
reqS("./services/engagement/pushGateway").send = async (uid, msg) => { pushes.push({ uid: String(uid), ...msg }); return { sent: true }; };
const tick = () => new Promise((r) => setTimeout(r, 30));

(async () => {
  const server = h.start();
  process.env.RATE_LIMIT_CREDENTIAL_VERIFY_MAX = "1000";

  console.log("-- flag off");
  let r = await call("GET", "/api/crew/invitation", { tok: T.S });
  check("ambassadorV2 off: /invitation 404", r.status === 404);
  r = await call("POST", "/api/crew/applications", { tok: T.S, body: { why: "i love tdc" } });
  check("…/applications 404, nothing stored", r.status === 404 && rows("PartnerApplication").length === 0);
  r = await call("GET", "/api/crew/squad", { tok: T.S });
  check("squadMission off: /squad 404", r.status === 404);
  r = await call("GET", "/api/crew/config");
  check("public config: applyInApp false (flag off)", r.status === 200 && r.json.applyInApp === false);
  process.env.FLAG_AMBASSADOR_V2 = "on";
  r = await call("GET", "/api/crew/config");
  check("public config: applyInApp true when on for everyone", r.json.applyInApp === true);
  process.env.FLAG_AMBASSADOR_V2 = `ids:${S},${NEW},${UNV},${AMB},${OLD}`;
  r = await call("GET", "/api/crew/config");
  check("…but not for an id list (no one signed in)", r.json.applyInApp === false);
  r = await call("GET", "/api/crew/invitation");
  check("signed out: 401", r.status === 401);

  console.log("-- P2-1 invitation");
  r = await call("GET", "/api/crew/invitation", { tok: T.NEW });
  check("account under 7 days: no", r.status === 200 && r.json.data.show === false && r.json.data.reason === "too_new");
  r = await call("GET", "/api/crew/invitation", { tok: T.UNV });
  check("not a verified student: no", r.json.data.show === false && r.json.data.reason === "not_verified");
  r = await call("GET", "/api/crew/invitation", { tok: T.AMB });
  check("already an ambassador: no", r.json.data.show === false && r.json.data.reason === "already_partner");
  r = await call("GET", "/api/crew/invitation", { tok: T.S });
  check("a friend joined and verified in the last 48 h: show (friend_joined)", r.json.data.show === true && r.json.data.moment === "friend_joined", r.text);
  check("…recorded: shownAt, asks 1", profileOf(S).ambassadorInvite?.asks === 1 && !!profileOf(S).ambassadorInvite?.shownAt);
  r = await call("GET", "/api/crew/invitation", { tok: T.S });
  check("asked again right away: no (asked_recently)", r.json.data.show === false && r.json.data.reason === "asked_recently");
  r = await call("POST", "/api/crew/invitation", { tok: T.S, body: { answer: "maybe" } });
  check("a bad answer: 400", r.status === 400 && r.json.code === "BAD_ANSWER");
  r = await call("POST", "/api/crew/invitation", { tok: T.S, body: { answer: "not_now" } });
  check("not now: stored", r.status === 200 && profileOf(S).ambassadorInvite.answer === "not_now");
  profileOf(S).ambassadorInvite.answeredAt = ago(31); profileOf(S).ambassadorInvite.shownAt = ago(31);
  r = await call("GET", "/api/crew/invitation", { tok: T.S });
  check("31 days after not now: shown once more (asks 2)", r.json.data.show === true && profileOf(S).ambassadorInvite.asks === 2);
  profileOf(S).ambassadorInvite.answeredAt = ago(62); profileOf(S).ambassadorInvite.shownAt = ago(62);
  r = await call("GET", "/api/crew/invitation", { tok: T.S });
  check("never a third time", r.json.data.show === false && r.json.data.reason === "asked_twice");
  const svc = reqS("./services/crew/ambassador");
  const p = profileOf(S); p.ambassadorInvite = { asks: 1, answer: "never", answeredAt: ago(90), shownAt: ago(90) };
  check("'never' → never", (await svc.invitation(S)).reason === "answered");
  p.ambassadorInvite = {};
  fake.STORE.get(coll("User")).find((u) => same(u._id, F[0])).createdAt = ago(5);
  check("no good moment (the friend joined 5 days ago) → no", (await svc.invitation(S)).reason === "no_good_moment");
  fake.seed(coll("PromoCode"), [1, 2, 3].map((i) => ({ _id: oid(), student: S, code: `C${i}`, createdAt: new Date(Date.now() - i * 3600e3) })));
  check("a 3rd deal claimed in the last 48 h → deals_claimed", (await svc.invitation(S)).moment === "deals_claimed");

  console.log("-- P2-3 application");
  r = await call("GET", "/api/crew/applications/me", { tok: T.S });
  check("before: none", r.json.data.status === "none");
  r = await call("POST", "/api/crew/applications", { tok: T.S, body: { why: "", whyChips: [] } });
  check("no why → 400 WHY_REQUIRED", r.status === 400 && r.json.code === "WHY_REQUIRED");
  r = await call("POST", "/api/crew/applications", { tok: T.S, body: { whyChips: ["i know everyone", "i run a society"], groups: ["NED IEEE", " "], handle: "@sana" } });
  check("apply → pending", r.status === 200 && r.json.data.status === "pending", r.text);
  let a = rows("PartnerApplication")[0];
  check("stored: university name + id, chips, groups (blank dropped), handle without @, source app, appliedAt", a.university === "NED University" && same(a.universityId, NED) && a.whyChips.length === 2 && a.groups.join() === "NED IEEE" && a.handle === "sana" && a.source === "app" && !!a.appliedAt && a.why === "i know everyone, i run a society", JSON.stringify(a));
  r = await call("POST", "/api/crew/applications", { tok: T.S, body: { why: "again" } });
  check("apply twice → 409 ALREADY_APPLIED", r.status === 409 && r.json.code === "ALREADY_APPLIED");
  r = await call("GET", "/api/crew/invitation", { tok: T.S });
  check("an applicant isn't invited", r.json.data.reason === "already_applied");

  console.log("-- admin inbox + review");
  r = await call("GET", "/api/admin/crew/inbox", { tok: T.S });
  check("students: 403", r.status === 403);
  r = await call("GET", "/api/admin/crew/inbox", { tok: T.admin });
  const item = (r.json || []).find((x) => x.kind === "application");
  check("inbox: the application with chips, groups, source, appliedAt (old keys kept)", item && item.whyChips.length === 2 && item.groups[0] === "NED IEEE" && item.source === "app" && !!item.appliedAt && item.university === "NED University" && item.why, JSON.stringify(item));
  r = await call("POST", `/api/admin/crew/partners/applications/${a._id}/review`, { tok: T.admin, body: { status: "rejected", note: "  tell us more about your campus groups  " } });
  await tick();
  a = rows("PartnerApplication")[0];
  check("reject with a note → reviewNote (trimmed)", r.status === 200 && a.status === "rejected" && a.reviewNote === "tell us more about your campus groups");
  check("…a personal push with the note", pushes.length === 1 && pushes[0].uid === String(S) && pushes[0].budgetClass === "personal" && /tell us more/.test(pushes[0].body) && pushes[0].data.route === "Points");
  r = await call("GET", "/api/crew/applications/me", { tok: T.S });
  check("the student sees rejected, the note, and when they can apply again", r.json.data.status === "rejected" && r.json.data.reviewNote === "tell us more about your campus groups" && !!r.json.data.canApplyAgainAt);
  r = await call("POST", "/api/crew/applications", { tok: T.S, body: { why: "again" } });
  check("re-apply within 30 days → 409 TOO_SOON", r.status === 409 && r.json.code === "TOO_SOON");
  a.reviewedAt = ago(31);
  r = await call("POST", "/api/crew/applications", { tok: T.S, body: { why: "i grew the IEEE chapter" } });
  check("after 30 days: the same document back to pending, note cleared", r.status === 200 && rows("PartnerApplication").length === 1 && rows("PartnerApplication")[0].status === "pending" && rows("PartnerApplication")[0].reviewNote === "");
  r = await call("POST", `/api/admin/crew/partners/applications/${a._id}/review`, { tok: T.admin, body: { status: "approved" } });
  await tick();
  check("approve → ambassador with the university id", r.status === 200 && profileOf(S).partner.type === "ambassador" && same(profileOf(S).partner.universityId, NED));
  check("…a personal push 'you're in'", pushes.length === 2 && /you're in/.test(pushes[1].title));
  // an older application (the name only) → the id found by the name
  const OLDAPP = oid(); const X = oid();
  fake.seed(coll("User"), [user(X, "student", "Xara Form", { createdAt: ago(100) })]);
  fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: X }]);
  fake.seed(coll("PartnerApplication"), [{ _id: OLDAPP, user: X, university: "lums", handle: "xara", why: "web form", status: "pending", createdAt: ago(10) }]);
  r = await call("POST", `/api/admin/crew/partners/applications/${OLDAPP}/review`, { tok: T.admin, body: { status: "approved" } });
  await tick();
  check("older application: university id matched by the name (case-insensitive)", same(profileOf(X).partner.universityId, LUMS));
  check("…no push (ambassadorV2 off for that student); old reply shape kept", pushes.length === 2 && r.json.status === "approved" && same(r.json._id, OLDAPP));

  console.log("-- campus count, partners filter");
  r = await call("GET", "/api/crew/campus-count", { tok: T.NEW });
  check("NED: 3 ambassadors (2 by id, 1 older by name)", r.json.data.count === 3 && r.json.data.university === "NED University", r.text);
  r = await call("GET", `/api/admin/crew/partners?university=${NED}`, { tok: T.admin });
  check("partners filter by university id: NED's 3 (incl. the older one by name)", r.status === 200 && r.json.length === 3, r.text.slice(0, 200));
  r = await call("GET", "/api/admin/crew/partners?university=LUMS", { tok: T.admin });
  check("…by name: LUMS 1", r.json.length === 1 && same(r.json[0].user._id, X));
  r = await call("GET", "/api/admin/crew/partners", { tok: T.admin });
  const sana = r.json.find((x) => same(x.user._id, S));
  check("no filter: all 4; verified invites per ambassador (old stats kept)", r.json.length === 4 && sana.stats.verified === 1 && typeof sana.stats.referralsCredited === "number" && typeof sana.stats.verifiedThisMonth === "number");

  console.log("-- P2-5 hub, daily card");
  r = await call("GET", "/api/crew/me", { tok: T.NEW });
  check("hub: not an ambassador → 403", r.status === 403 && r.json.code === "NOT_AMBASSADOR");
  r = await call("GET", "/api/crew/daily-card", { tok: T.S });
  check("daily card: no live campaign → null (nothing fake)", r.status === 200 && r.json.data.card === null);
  const BRAND = oid();
  fake.seed(coll("User"), [user(BRAND, "brand", "Cafe Brand", { brandName: "Chai Spot" })]);
  fake.seed(coll("Campaign"), [{ _id: oid(), name: "chai week", brand: BRAND, partner: S, followerPercent: 20, startsAt: ago(1), endsAt: new Date(Date.now() + 5 * DAY), status: "live" }]);
  r = await call("GET", "/api/crew/daily-card", { tok: T.S });
  check("daily card: the real campaign, brand, % and code", r.json.data.card && r.json.data.card.brand === "Chai Spot" && r.json.data.card.followerPercent === 20 && r.json.data.card.code === "SANA01", r.text);
  r = await call("GET", "/api/crew/me", { tok: T.S });
  check("hub: invites, rank, the campaign, no credentials yet", r.status === 200 && r.json.data.campaigns.length === 1 && r.json.data.rank.of >= 3 && r.json.data.credentials.length === 0, r.text.slice(0, 300));

  console.log("-- credentials");
  r = await call("POST", "/api/admin/crew/credentials", { tok: T.admin, body: { userId: String(S), type: "certificate" } });
  const cert = r.json;
  check("certificate: issued at once", r.status === 201 && cert.status === "issued");
  r = await call("POST", "/api/admin/crew/credentials", { tok: T.admin, body: { userId: String(S), type: "recommendation" } });
  const letter = r.json;
  check("letter (ambassadorV2 on for the student): a draft", r.status === 201 && letter.status === "draft");
  r = await call("POST", "/api/admin/crew/credentials", { tok: T.admin, body: { userId: String(X), type: "letter" } });
  check("letter with the flag off for the student: issued as before", r.status === 201 && r.json.status === "issued");
  r = await call("POST", `/api/admin/crew/credentials/${letter._id}/approve`, { tok: T.admin });
  check("approve a draft with no text → 400", r.status === 400);
  r = await call("GET", `/api/admin/crew/credentials/${letter._id}/pdf`, { tok: T.admin });
  check("preview without text → 400", r.status === 400);
  r = await call("PUT", `/api/admin/crew/credentials/${letter._id}`, { tok: T.admin, body: { letterText: "Sana led the NED chapter of tdc for a semester." } });
  check("admin writes the letter", r.status === 200 && r.json.letterText.startsWith("Sana led"));
  r = await call("GET", "/api/crew/me", { tok: T.S });
  check("the student doesn't see the draft", r.json.data.credentials.length === 1 && r.json.data.credentials[0].type === "certificate" && r.json.data.credentials[0].pdf === true);
  r = await call("GET", `/api/admin/crew/credentials/${letter._id}/pdf`, { tok: T.admin });
  check("admin PDF preview of the draft", r.status === 200 && r.text.startsWith("%PDF"));
  r = await call("POST", `/api/admin/crew/credentials/${letter._id}/approve`, { tok: T.admin });
  check("approve → issued, approvedBy / At", r.status === 200 && r.json.status === "issued" && same(r.json.approvedBy, ADMIN) && !!r.json.approvedAt);
  r = await call("PUT", `/api/admin/crew/credentials/${letter._id}`, { tok: T.admin, body: { letterText: "changed" } });
  check("an issued letter can't be edited → 409", r.status === 409);
  r = await call("POST", `/api/admin/crew/credentials/${letter._id}/approve`, { tok: T.admin });
  check("approve twice → 409", r.status === 409);

  r = await call("POST", `/api/crew/credentials/${cert._id}/link`, { tok: T.NEW });
  check("someone else's credential: 404", r.status === 404);
  r = await call("POST", `/api/crew/credentials/${cert._id}/link`, { tok: T.S });
  check("own credential: a 10-minute link", r.status === 200 && /\/api\/crew\/credentials\/[0-9a-f]{24}\/pdf\?t=/.test(r.json.data.url) && r.json.data.expiresInSeconds === 600);
  const path = r.json.data.url.replace(/^https?:\/\/[^/]+/, "");
  r = await call("GET", path);
  check("the link opens the PDF (no sign-in needed)", r.status === 200 && r.text.startsWith("%PDF"));
  r = await call("GET", path.replace(String(cert._id), String(letter._id)));
  check("the token is for one credential only", r.status === 401 && r.json.code === "LINK_EXPIRED");
  r = await call("GET", `/api/crew/credentials/${cert._id}/pdf?t=junk`);
  check("a junk token → 401", r.status === 401);

  r = await call("GET", `/api/crew/verify/${cert._id}`);
  check("public verify: name, role, university, dates, valid", r.status === 200 && r.json.data.name === "Sana Malik" && r.json.data.role === "campus ambassador" && r.json.data.university === "NED University" && !!r.json.data.issuedAt && r.json.data.status === "valid" && !!r.json.data.since, r.text);
  check("…nothing else (no e-mail, no user id, no note)", !/@test\.local|"user"|"note"|"email"/.test(r.text));
  r = await call("POST", "/api/admin/crew/credentials", { tok: T.admin, body: { userId: String(S), type: "recommendation" } });
  const draft2 = r.json;
  r = await call("GET", `/api/crew/verify/${draft2._id}`);
  check("a draft can't be verified (404)", r.status === 404);
  r = await call("GET", "/api/crew/verify/junk");
  check("junk id → 404", r.status === 404);
  r = await call("POST", `/api/admin/crew/credentials/${cert._id}/revoke`, { tok: T.admin });
  check("revoke → revoked, revokedBy", r.status === 200 && r.json.status === "revoked" && same(r.json.revokedBy, ADMIN));
  r = await call("GET", `/api/crew/verify/${cert._id}`);
  check("verify now says revoked, with the date", r.json.data.status === "revoked" && !!r.json.data.revokedAt);
  r = await call("GET", path);
  check("a revoked credential's link no longer opens", r.status === 404);
  r = await call("DELETE", `/api/admin/crew/credentials/${letter._id}`, { tok: T.admin });
  check("the old DELETE still revokes (204), now with revokedBy", r.status === 204 && same(rows("Credential", (c) => same(c._id, letter._id))[0].revokedBy, ADMIN));
  const pdfBuf = await reqS("./services/crew/certificate").render(rows("Credential", (c) => same(c._id, cert._id))[0]);
  check("the PDF renders for a revoked one too (marked)", Buffer.isBuffer(pdfBuf) && pdfBuf.slice(0, 4).toString() === "%PDF");

  console.log("-- campus moments");
  r = await call("POST", "/api/crew/moments", { tok: T.NEW, body: { caption: "hi", imageUrl: "https://res.cloudinary.com/x/a.jpg" } });
  check("not an ambassador → 403", r.status === 403);
  r = await call("POST", "/api/crew/moments", { tok: T.S, body: { caption: "tdc stall at the NED fair", imageUrl: "https://evil.example/a.jpg" } });
  check("a photo not on our Cloudinary → 400", r.status === 400 && r.json.code === "PHOTO_REQUIRED");
  r = await call("POST", "/api/crew/moments", { tok: T.S, body: { caption: "", imageUrl: "https://res.cloudinary.com/x/a.jpg" } });
  check("no caption → 400", r.status === 400 && r.json.code === "CAPTION_REQUIRED");
  verdict = "edit";
  r = await call("POST", "/api/crew/moments", { tok: T.S, body: { caption: "bad words", imageUrl: "https://res.cloudinary.com/x/bad.jpg" } });
  await tick();
  check("moderation says edit → 422 NEEDS_EDIT, the photo deleted, nothing stored", r.status === 422 && r.json.code === "NEEDS_EDIT" && deleted.includes("https://res.cloudinary.com/x/bad.jpg") && rows("PartnerPost").length === 0);
  verdict = "ok";
  r = await call("POST", "/api/crew/moments", { tok: T.S, body: { caption: "tdc stall at the NED fair", imageUrl: "https://res.cloudinary.com/x/a.jpg" } });
  check("ok → a pending moment", r.status === 200 && r.json.data.status === "pending" && rows("PartnerPost").length === 1 && rows("PartnerPost")[0].kind === "moment");
  r = await call("GET", "/api/admin/crew/inbox", { tok: T.admin });
  const mo = r.json.find((x) => x.kind === "post");
  check("inbox: the moment with caption + photo (kind 'post' kept, postKind 'moment')", mo && mo.postKind === "moment" && mo.caption === "tdc stall at the NED fair" && mo.imageUrl && mo.summary === "campus moment");
  const LinkPost = reqS("./models/PartnerPost");
  let linkErr = null;
  try { await new LinkPost({ user: S, status: "pending" }).validate(); } catch (e) { linkErr = e; }
  check("a link post still needs platform and url", !!linkErr && !!linkErr.errors.platform && !!linkErr.errors.url);
  let momentErr = null;
  try { await new LinkPost({ user: S, kind: "moment", caption: "x", imageUrl: "https://res.cloudinary.com/x/a.jpg" }).validate(); } catch (e) { momentErr = e; }
  check("a moment doesn't", momentErr === null, String(momentErr));
  r = await call("POST", `/api/admin/crew/posts/${mo._id}/review`, { tok: T.admin, body: { status: "approved", reach: "posted" } });
  check("the old review route approves a moment", r.status === 200 && r.json.status === "approved");

  console.log("-- P2-7 bring your squad");
  const squad = reqS("./services/crew/squad");
  check("flag off: no progress, no reward", (await squad.progress(S)) === null && (await squad.evaluate(S)).paid === false);
  process.env.FLAG_SQUAD_MISSION = `ids:${S}`;
  r = await call("GET", "/api/crew/squad", { tok: T.S });
  check("on: progress 0 of 3 this week (the friend from 5 days ago may be last week)", r.status === 200 && r.json.data.target === 3 && r.json.data.rewarded === false && r.json.data.rewardPoints === 100, r.text);
  const weekStart = svc.karachiWeekStart(new Date());
  const inWeek = new Date(Math.max(weekStart.getTime() + 60e3, Date.now() - 3600e3));
  fake.seed(coll("User"), [
    user(F[1], "student", "Friend Two", { createdAt: inWeek, referredBy: S, emailVerified: true }),
    user(F[2], "student", "Friend Three", { createdAt: inWeek, referredBy: S, emailVerified: false }),
  ]);
  const base = (await squad.progress(S)).verified;
  r = await call("GET", "/api/crew/squad", { tok: T.S });
  check("an unverified friend doesn't count", r.json.data.verified === base && base >= 1);
  // the third friend verifies: the referral hook evaluates the squad
  const users = fake.STORE.get(coll("User"));
  const need = 3 - base;
  for (let i = 0; i < need; i++) {
    const id = oid();
    fake.seed(coll("User"), [user(id, "student", `Friend X${i}`, { createdAt: inWeek, referredBy: S, emailVerified: true })]);
    fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: id }]);
  }
  const lastFriend = users[users.length - 1];
  await reqS("./services/engagement/referralSignup").onEmailVerified(lastFriend);
  await tick(); await tick();
  const paid = rows("PointsLedger", (l) => (l.idemKey || l.dedupeKey || "").startsWith(`squad:${S}:`));
  check("3 verified friends this week → the reward, once", paid.length === 1 && paid[0].delta === 100, JSON.stringify(rows("PointsLedger").map((l) => l.idemKey)));
  check("…and a popup with the real amount", (profileOf(S).pendingPopups || []).some((x) => x.kind === "squad_done" && /\+100 pts/.test(x.line)));
  r = await call("GET", "/api/crew/squad", { tok: T.S });
  check("progress: rewarded; evaluating again pays nothing", r.json.data.rewarded === true && (await squad.evaluate(S)).paid === false && rows("PointsLedger", (l) => (l.idemKey || "").startsWith(`squad:${S}:`)).length === 1);
  process.env.SQUAD_REWARD_POINTS = "5000";
  check("SQUAD_REWARD_POINTS over 1000 → the default 100", squad.rewardPoints() === 100);
  delete process.env.SQUAD_REWARD_POINTS;

  console.log("-- P2-7 the referee's welcome popup");
  const REF = oid(); const NEWF = oid();
  fake.seed(coll("User"), [user(REF, "student", "Rafay Referrer"), user(NEWF, "student", "Hina New", { referredBy: REF })]);
  fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: REF }, { _id: oid(), user: NEWF }]);
  const rs = reqS("./services/engagement/referralSignup");
  await rs.awardSignupReferral({ _id: REF, name: "Rafay Referrer", role: "student" }, { _id: NEWF, name: "Hina New" });
  check("ambassadorV2 off for the new student: no welcome popup (as before)", !(profileOf(NEWF).pendingPopups || []).some((x) => x.kind === "referral_welcome"));
  const NEWG = oid();
  fake.seed(coll("User"), [user(NEWG, "student", "Gul New", { referredBy: REF })]);
  fake.seed(coll("EngagementProfile"), [{ _id: oid(), user: NEWG }]);
  process.env.FLAG_AMBASSADOR_V2 = `ids:${NEWG}`;
  await rs.awardSignupReferral({ _id: REF, name: "Rafay Referrer", role: "student" }, { _id: NEWG, name: "Gul New" });
  const pop = (profileOf(NEWG).pendingPopups || []).find((x) => x.kind === "referral_welcome");
  check("on: 'you joined with Rafay's code. +100 pts' (the real amount)", pop && /Rafay's code/.test(pop.line) && /\+100 pts/.test(pop.line) && pop.payload.amount === 100, JSON.stringify(pop));
  await rs.awardSignupReferral({ _id: REF, name: "Rafay Referrer", role: "student" }, { _id: NEWG, name: "Gul New" });
  check("…once (paid again → no second popup)", (profileOf(NEWG).pendingPopups || []).filter((x) => x.kind === "referral_welcome").length === 1);
  check("the referrer's popup still says +150", (profileOf(REF).pendingPopups || []).some((x) => x.kind === "referral_credited" && /\+150 pts/.test(x.line)));
  process.env.FLAG_AMBASSADOR_V2 = `ids:${S},${NEW},${UNV},${AMB},${OLD}`;

  console.log("-- rate limits, permissions");
  process.env.RATE_LIMIT_CREDENTIAL_VERIFY_MAX = "2";
  r = await call("GET", `/api/crew/verify/${cert._id}`);
  check("public verify is rate-limited per IP → 429", r.status === 429 && r.json.code === "RATE_LIMITED");
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(h.SERVER, "routes", "adminCrew.routes.js"), "utf8");
  check("the new admin routes are mapped to credentials.issue", ["PUT /credentials/:id", "POST /credentials/:id/approve", "POST /credentials/:id/revoke", "GET /credentials/:id/pdf"].every((k) => src.includes(`"${k}": "credentials.issue"`)));

  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
