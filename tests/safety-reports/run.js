const h = require("../hiring-fixes/harness")();
const { app, call, check, reqS, fake, mongoose, oid, user, token, coll, start, finish } = h;
const { intake, moderation } = reqS("./routes/safetyReports.routes");
const { SafetyReport } = reqS("./models/SafetyReport");
const { Conversation, Message } = reqS("./models/Chat");
const student = oid(), subject = oid(), stranger = oid(), moderator = oid(), legacy = oid();
const campus = oid(), post = oid(), comment = oid(), confession = oid(), confessionComment = oid(), conversation = oid(), message = oid();

app.use("/api/safety", intake);
app.use("/api/admin/safety-reports", moderation);
// The existing fake storage harness has no sessions. Production uses a MongoDB transaction.
mongoose.connection.transaction = (fn) => fn(null);
fake.seed(coll("User"), [
  user(student, "student", "Test Student", { university: campus, status: "Pending" }),
  user(subject, "student", "Test Subject", { university: campus }),
  user(stranger, "student", "Test Stranger", { university: oid() }),
  user(moderator, "admin", "Test Moderator", { adminAccess: { level: "member", status: "active", permissions: ["safety.intake.view", "safety.intake.act", "students.suspend"] } }),
  user(legacy, "admin", "Test Legacy"),
]);
fake.seed(coll("Post"), [{ _id: post, author: subject, comments: [{ _id: comment, user: subject, text: "Harmless fixture" }] }]);
fake.seed(coll("Confession"), [{ _id: confession, authorId: subject, university: campus, visibility: "campus", status: "live",
  comments: [{ _id: confessionComment, user: subject, status: "live" }] }]);
fake.seed(Conversation.collection.name, [{ _id: conversation, participants: [student, subject] }]);
fake.seed(Message.collection.name, [{ _id: message, conversationId: conversation, sender: subject, text: "Private harmless fixture" }]);

const intakeUrl = "/api/safety/reports";
const adminUrl = "/api/admin/safety-reports";
const studentToken = token(student, "student");
const moderatorToken = token(moderator, "admin");
let sequence = 0;
const input = (fields = {}) => ({ reason: "child_exploitation", description: "Harmless review fixture", submissionId: `mock-submission-${++sequence}`, ...fields });

(async () => {
  const server = start();
  try {
    const general = input({ reporter: String(stranger), priority: 0 });
    const result = await call("POST", intakeUrl, { tok: studentToken, body: general });
    check("signed-in student can report without verification or a target", result.status === 201, result.text);
    const reportId = result.json?.reportId;
    const [repeat, stored] = await Promise.all([
      call("POST", intakeUrl, { tok: studentToken, body: general }),
      SafetyReport.findById(reportId).lean(),
    ]);
    check("authenticated reporter and urgent priority persisted", String(stored?.reporter) === String(student) && stored?.priority === 2);
    check("retry returns the same persisted report", repeat.status === 200 && repeat.json?.reportId === reportId && await SafetyReport.countDocuments() === 1);
    const targets = [
      ["User", subject], ["Post", post], ["Comment", comment, post], ["Confession", confession],
      ["ConfessionComment", confessionComment, confession], ["Conversation", conversation], ["Message", message, conversation],
    ];
    let messageReport, userReport;
    for (const [targetType, targetId, parentId] of targets) {
      const report = await call("POST", intakeUrl, { tok: studentToken, body: input({ targetType, targetId, parentId }) });
      check(`reports ${targetType}`, report.status === 201, report.text);
      if (targetType === "Message") messageReport = report.json?.reportId;
      if (targetType === "User") userReport = report.json?.reportId;
    }
    const foreign = token(stranger, "student");
    for (const options of [{ targetType: "Message", targetId: message, parentId: conversation }, { targetType: "Confession", targetId: confession }]) {
      check(`reject inaccessible ${options.targetType}`, (await call("POST", intakeUrl, { tok: foreign, body: input(options) })).status === 404);
    }
    check("reject blank details", (await call("POST", intakeUrl, { tok: studentToken, body: input({ description: "" }) })).status === 400);
    check("reject unauthenticated submission", (await call("POST", intakeUrl, { body: input() })).status === 401);
    check("reject student queue access", (await call("GET", adminUrl, { tok: studentToken })).status === 403);
    check("reject legacy admin queue access", (await call("GET", adminUrl, { tok: token(legacy, "admin") })).status === 403);
    const queue = await call("GET", `${adminUrl}?child=true`, { tok: moderatorToken });
    check("authorized child safety queue includes report counts", queue.status === 200 && queue.json?.counts?.pending === 8, queue.text);
    const details = await call("GET", `${adminUrl}/${messageReport}`, { tok: moderatorToken });
    check("chat report omits private identifiers and message contents", details.status === 200 && !details.json?.targetId && !details.json?.parentId && !details.text.includes("Private harmless fixture"), details.text);
    const decision = { status: "under_review", assign: true, escalation: "planned", version: 0, note: "Harmless test decision" };
    const updated = await call("PATCH", `${adminUrl}/${reportId}`, { tok: moderatorToken, body: decision });
    check("authorized moderator updates status and assignment", updated.status === 200, updated.text);
    check("stale moderation decision rejected", (await call("PATCH", `${adminUrl}/${reportId}`, { tok: moderatorToken, body: decision })).status === 409);
    check("external escalation requires confirmation", (await call("PATCH", `${adminUrl}/${reportId}`, { tok: moderatorToken, body: { ...decision, version: 1, escalation: "reported" } })).status === 400);
    const storedDecision = await SafetyReport.findById(reportId).lean();
    check("status, moderator and action history persist", storedDecision?.status === "under_review" &&
      String(storedDecision.assignedModerator) === String(moderator) && storedDecision.history.at(-1)?.action === "review");
    const competing = await Promise.all(["First decision", "Second decision"].map((note) =>
      call("PATCH", `${adminUrl}/${reportId}`, { tok: moderatorToken, body: { ...decision, version: 1, note } })));
    check("only one concurrent decision can update the same version",
      competing.map((r) => r.status).sort().join(",") === "200,409");
    const removed = await call("PATCH", `${adminUrl}/${messageReport}`, {
      tok: moderatorToken, body: { ...decision, status: "resolved", action: "remove" },
    });
    check("authorized moderator can remove the reported message without fetching its content",
      removed.status === 200 && !await Message.exists({ _id: message }), removed.text);
    const simultaneous = input();
    const duplicates = await Promise.all([1, 2].map(() => call("POST", intakeUrl, { tok: studentToken, body: simultaneous })));
    check("concurrent retries share one report ID", duplicates.every((r) => r.status < 300) &&
      duplicates[0].json?.reportId === duplicates[1].json?.reportId);
    const invalid = await call("POST", intakeUrl, { tok: studentToken, body: input({ targetType: "Message", targetId: message, parentId: "invalid" }) });
    check("invalid parent identifier rejected", invalid.status === 400);
    let limited;
    for (let i = 0; i < 21; i += 1) {
      limited = await call("POST", intakeUrl, { tok: foreign, body: input() });
      if (limited.status === 429) break;
    }
    check("shared submission counter throttles repeat requests", limited?.status === 429 && Number(limited.headers["retry-after"]) > 0);
    const suspend = () => call("PATCH", `${adminUrl}/${userReport}`, {
      tok: moderatorToken, body: { ...decision, status: "resolved", action: "suspend" },
    });
    check("suspension refused while account enforcement is disabled", (await suspend()).status === 409);
    process.env.FLAG_ACCOUNT_STATUS_ENFORCE = "on";
    try {
      const suspension = await suspend();
      const access = await call("POST", intakeUrl, { tok: token(subject, "student"), body: input() });
      check("suspension blocks authenticated HTTP access with enforcement enabled", suspension.status === 200 &&
        access.status === 401 && access.json?.code === "ACCOUNT_SUSPENDED", suspension.text);
    } finally { delete process.env.FLAG_ACCOUNT_STATUS_ENFORCE; }
  } catch (error) {
    check("test runner completed", false, error.message);
  } finally { finish(server); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
