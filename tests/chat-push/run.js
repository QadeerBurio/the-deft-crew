// CHAT-1 chat message pushes (services/chatPush.js via socket/chatHandlers.js send_message), with a real socket.io server
// and clients, in-memory data and a fake push sender:
//   - flag chatPushV1 off for the recipient: no push (as since 5 Oct 2026)
//   - on: the other participant gets "<sender> 💬" with the message, opening that chat (MessagesScreen / MatchChat /
//     InquiryChat); never the sender
//   - not when they are in that chat's room; not when their "messages" switch is off; not when they blocked the sender;
//     no quiet hours by default (CHAT_PUSH_QUIET_HOURS=on is an optional override); one push per 20 s per conversation
//   - photo / voice / location previews; long text cut at 80 characters
//   - notification-prefs: GET has "messages" (default on), PUT saves it
//   node tests/chat-push/run.js [serverDir]
const http = require("http");
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/engagement", "./routes/engagement.routes"]],
  models: ["Chat", "EngagementProfile", "BlockedUser", "Match", "Inquiry"],
});
const { reqS, call, check, oid, user, token, fake, coll } = h;
const { Server } = reqS("socket.io");
const { io: connect } = reqS("socket.io-client");
const { Conversation } = reqS("./models/Chat");
const handlers = reqS("./socket/chatHandlers");
const chatPush = reqS("./services/chatPush");
const flags = reqS("./config/featureFlags");

const pushes = [];
chatPush._setSendForTests(async (to, title, body, data) => { pushes.push({ to: String(to), title, body, data }); return { sent: true }; });
const ids = { A: oid(), B: oid(), C: oid(), D: oid() };
fake.seed(coll("User"), [user(ids.A, "student", "Aisha Sender"), user(ids.B, "student", "Bilal Receiver"), user(ids.C, "student", "Chand Blocker"), user(ids.D, "student", "Dua Off")]);
const T = Object.fromEntries(Object.keys(ids).map((k) => [k, token(ids[k], "student")]));
const conv = { AB: oid(), AC: oid(), AD: oid(), match: oid() };
fake.seed(Conversation.collection.collectionName, [
  { _id: conv.AB, participants: [ids.A, ids.B] }, { _id: conv.AC, participants: [ids.A, ids.C] },
  { _id: conv.AD, participants: [ids.A, ids.D] }, { _id: conv.match, participants: [ids.A, ids.B] },
]);
const matchId = oid(); const listingId = oid();
fake.seed(reqS("./models/Match").collection.collectionName, [{ _id: matchId, conversationId: conv.match, listingId }]);
fake.seed(reqS("./models/BlockedUser").collection.collectionName, [{ _id: oid(), userId: ids.C, blockedUserId: ids.A }]);
fake.seed(reqS("./models/EngagementProfile").collection.collectionName, [{ _id: oid(), user: ids.D, notifPrefs: { messages: false } }]);
const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const DAY_PKT = new Date("2026-11-21T08:00:00Z"); // 13:00 Karachi
const NIGHT_PKT = new Date("2026-11-21T21:00:00Z"); // 02:00 Karachi

const httpServer = http.createServer();
const io = new Server(httpServer);
handlers.attach(io);
let URL;
const socks = [];
const client = (tok) => new Promise((resolve) => { const s = connect(URL, { transports: ["websocket"], forceNew: true, reconnection: false, auth: { token: tok } }); s.on("connect", () => resolve(s)); socks.push(s); });

(async () => {
  await new Promise((r) => httpServer.listen(0, r));
  URL = `http://127.0.0.1:${httpServer.address().port}`;
  const server = h.start();
  const quiet = console.log; console.log = () => {};
  const warn = console.warn; console.warn = () => {};
  delete process.env.CHAT_PUSH_QUIET_HOURS; // chat has no quiet hours by default; the override is checked below

  const a = await client(T.A);
  a.emit("join_chat", String(conv.AB));
  await tick();
  a.emit("send_message", { conversationId: String(conv.AB), senderId: String(ids.A), text: "hi before the flag" });
  await tick(300);
  check("flag off for the recipient: no push (as now)", pushes.length === 0);

  for (const k of ["B", "C", "D"]) flags.applyAdminAccess("chatPushV1", String(ids[k]), true);
  a.emit("send_message", { conversationId: String(conv.AB), senderId: String(ids.A), text: "hello bilal" });
  await tick(300);
  const p1 = pushes.find((p) => p.to === String(ids.B));
  check("flag on: B gets '<sender> 💬' with the message", p1 && p1.title === "Aisha Sender 💬" && p1.body === "hello bilal", JSON.stringify(pushes));
  check("…it opens that chat (MessagesScreen + conversationId), type message", p1 && p1.data.route === "MessagesScreen" && p1.data.params.conversationId === String(conv.AB) && p1.data.type === "message");
  check("…never to the sender", !pushes.some((p) => p.to === String(ids.A)));

  const b = await client(T.B);
  b.emit("join_chat", String(conv.AB));
  await tick();
  chatPush._resetThrottle(); pushes.length = 0;
  a.emit("send_message", { conversationId: String(conv.AB), senderId: String(ids.A), text: "you're in the chat" });
  await tick(300);
  check("B is in the chat (its room): no push", pushes.length === 0);
  b.emit("leave_chat", String(conv.AB));
  await tick();

  a.emit("send_message", { conversationId: String(conv.AC), senderId: String(ids.A), text: "hi chand" });
  a.emit("send_message", { conversationId: String(conv.AD), senderId: String(ids.A), text: "hi dua" });
  await tick(400);
  check("C blocked the sender: no push", !pushes.some((p) => p.to === String(ids.C)));
  check("D turned the 'messages' switch off: no push", !pushes.some((p) => p.to === String(ids.D)));

  chatPush._resetThrottle(); pushes.length = 0;
  a.emit("send_message", { conversationId: String(conv.match), senderId: String(ids.A), messageType: "image", mediaUrl: "https://x/y.jpg" });
  await tick(300);
  const pm = pushes[0];
  check("a SkillShare match chat opens MatchChat with matchId / listingId; a photo shows '📷 Photo'", pm && pm.data.route === "MatchChat" && pm.data.params.matchId === String(matchId) && pm.data.params.listingId === String(listingId) && pm.body === "📷 Photo", JSON.stringify(pm));
  console.log = quiet; console.warn = warn;

  // direct calls: quiet hours, throttle, long text
  // quiet hours: none by default (person-to-person, like WhatsApp); only the optional override turns them on
  delete process.env.CHAT_PUSH_QUIET_HOURS;
  chatPush._resetThrottle(); pushes.length = 0;
  let r = await chatPush.pushChatMessage(io, conv.AB, ids.A, "at night", NIGHT_PKT);
  check("02:00 Karachi, CHAT_PUSH_QUIET_HOURS unset: sent (no quiet hours for chat)", r.sent.includes(String(ids.B)) && pushes.length === 1, JSON.stringify(r));
  for (const v of ["", "off", "nonsense"]) {
    process.env.CHAT_PUSH_QUIET_HOURS = v; chatPush._resetThrottle();
    r = await chatPush.pushChatMessage(io, conv.AB, ids.A, `night ${v}`, NIGHT_PKT);
    check(`CHAT_PUSH_QUIET_HOURS="${v}": still sent at night`, r.sent.includes(String(ids.B)));
  }
  process.env.CHAT_PUSH_QUIET_HOURS = "on"; chatPush._resetThrottle();
  r = await chatPush.pushChatMessage(io, conv.AB, ids.A, "at night, override on", NIGHT_PKT);
  check("CHAT_PUSH_QUIET_HOURS=on (override): skipped at 02:00 (quiet_hours)", r.skipped[String(ids.B)] === "quiet_hours");
  chatPush._resetThrottle();
  r = await chatPush.pushChatMessage(io, conv.AB, ids.A, "daytime, override on", DAY_PKT);
  check("…but sent at 13:00", r.sent.includes(String(ids.B)));
  delete process.env.CHAT_PUSH_QUIET_HOURS;
  chatPush._resetThrottle(); pushes.length = 0;
  const t0 = DAY_PKT.getTime();
  await chatPush.pushChatMessage(io, conv.AB, ids.A, "one", new Date(t0));
  r = await chatPush.pushChatMessage(io, conv.AB, ids.A, "two", new Date(t0 + 5000));
  check("a second message within 20 s: throttled (one buzz)", r.skipped[String(ids.B)] === "throttled" && pushes.length === 1);
  r = await chatPush.pushChatMessage(io, conv.AB, ids.A, "x".repeat(200), new Date(t0 + 21000));
  check("after 20 s: sent again; long text cut to 80 characters + …", r.sent.includes(String(ids.B)) && pushes[1].body.length === 81 && pushes[1].body.endsWith("…"));
  check("no daily cap: 5 more an hour apart all sent", await (async () => { let n = 0; for (let i = 1; i <= 5; i++) { const x = await chatPush.pushChatMessage(io, conv.AB, ids.A, `m${i}`, new Date(t0 + i * 3600e3)); n += x.sent.length; } return n === 5; })());

  // notification switch: only for accounts with the flag (like loyalty); everyone else sees exactly what they had
  const E = oid(); fake.STORE.get(coll("User")).push(user(E, "student", "Esha Noflag"));
  r = await call("GET", "/api/engagement/notification-prefs", { tok: token(E, "student") });
  check("without the flag: no 'messages' key in notification-prefs (unchanged reply)", r.status === 200 && !("messages" in r.json) && r.json.social === true, r.text);
  r = await call("PUT", "/api/engagement/notification-prefs", { tok: token(E, "student"), body: { messages: false } });
  check("…and it can't be saved", r.status === 200 && !("messages" in r.json) && !(fake.STORE.get(reqS("./models/EngagementProfile").collection.collectionName) || []).some((p) => String(p.user) === String(E) && p.notifPrefs?.messages === false));
  r = await call("GET", "/api/engagement/notification-prefs", { tok: T.B });
  check("notification-prefs: 'messages' on by default", r.status === 200 && r.json.messages === true, r.text);
  r = await call("PUT", "/api/engagement/notification-prefs", { tok: T.B, body: { messages: false } });
  check("…PUT messages: false is saved", r.status === 200 && r.json.messages === false, r.text);
  chatPush._resetThrottle(); pushes.length = 0;
  r = await chatPush.pushChatMessage(io, conv.AB, ids.A, "after switching off", new Date(t0 + 10 * 3600e3));
  check("…and B gets no more chat pushes", r.skipped[String(ids.B)] === "pref_off" && pushes.length === 0);

  for (const s of socks) s.close();
  io.close(); httpServer.close();
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
