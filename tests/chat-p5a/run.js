// P5a chat fixes, with a real socket.io server on in-memory data:
//   - deleting a message through the REST route (DELETE /api/social/messages/:id, what ChatDetails does first) now
//     reaches the other person in the room as 'message_deleted' (same payload); before, the room id was an ObjectId and
//     nobody got it. Someone else's message: 403, nothing deleted, nothing sent.
//   - SkillShare typing: 'typing' { conversationId, userId, isTyping } is relayed to the room as 'typing' with the
//     token's account (not the claimed id); an outsider's typing reaches nobody; an older app without a token still works
//   node tests/chat-p5a/run.js [serverDir]
const http = require("http");
const h = require("../hiring-fixes/harness")(process.argv[2], {
  extraRoutes: [["/api/social", "./routes/social.routes"]],
  models: ["Chat", "Confession", "University", "Report", "Post", "SocialNotification"],
});
const { reqS, check, oid, user, token, fake, call } = h;
const { Server } = reqS("socket.io");
const { io: connect } = reqS("socket.io-client");
const { Message, Conversation } = reqS("./models/Chat");
const handlers = reqS("./socket/chatHandlers");

const ids = { A: oid(), B: oid(), C: oid() };
fake.seed(h.coll("User"), [user(ids.A, "student", "Aisha Real"), user(ids.B, "student", "Bilal Real"), user(ids.C, "student", "Chaudhry Outsider")]);
const T = { A: token(ids.A, "student"), B: token(ids.B, "student"), C: token(ids.C, "student") };
const AB = oid();
const now = new Date();
fake.seed(Conversation.collection.collectionName, [{ _id: AB, participants: [ids.A, ids.B], createdAt: now, updatedAt: now }]);
const MA = oid(); const MB = oid();
fake.seed(Message.collection.collectionName, [
  { _id: MA, conversationId: AB, sender: ids.A, text: "from A", createdAt: now, updatedAt: now },
  { _id: MB, conversationId: AB, sender: ids.B, text: "from B", createdAt: now, updatedAt: now },
]);
const msgs = (f = () => true) => (fake.STORE.get(Message.collection.collectionName) || []).filter(f);
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const httpServer = http.createServer();
const io = new Server(httpServer, { cors: { origin: "*" } });
handlers.attach(io);
h.app.set("io", io);
const sockets = [];
let URL;
const client = (tok) => new Promise((resolve) => {
  const s = connect(URL, { transports: ["websocket"], forceNew: true, reconnection: false, ...(tok ? { auth: { token: tok } } : {}) });
  s.got = [];
  s.onAny((ev, ...args) => s.got.push({ ev, args }));
  s.on("connect", () => resolve(s));
  sockets.push(s);
});
const got = (s, ev) => s.got.filter((x) => x.ev === ev);

(async () => {
  await new Promise((r) => httpServer.listen(0, r));
  URL = `http://127.0.0.1:${httpServer.address().port}`;
  const server = h.start();
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  const a = await client(T.A); const b = await client(T.B); const c = await client(T.C);
  a.emit("join_chat", String(AB)); b.emit("join_chat", String(AB)); c.emit("join_chat", String(AB));
  await tick();

  // ── delete through REST ──
  const r403 = await call("DELETE", `/api/social/messages/${MB}`, { tok: T.A });
  await tick();
  const r = await call("DELETE", `/api/social/messages/${MA}`, { tok: T.A });
  await tick();
  console.log = log;
  check("someone else's message: 403, kept, nothing sent", r403.status === 403 && msgs((m) => String(m._id) === String(MB)).length === 1);
  check("own message deleted through REST: 200, gone", r.status === 200 && msgs((m) => String(m._id) === String(MA)).length === 0, r.text);
  const del = got(b, "message_deleted");
  check("…the other person in the room gets 'message_deleted' once, same payload", del.length === 1 && del[0].args[0].messageId === String(MA) && String(del[0].args[0].conversationId) === String(AB), JSON.stringify(del.map((x) => x.args)));
  check("…the outsider (refused from the room) gets nothing", got(c, "message_deleted").length === 0);
  console.log = () => {};

  // ── SkillShare typing ──
  a.emit("typing", { conversationId: String(AB), userId: String(ids.C), isTyping: true });
  await tick();
  const t1 = got(b, "typing").pop();
  c.emit("typing", { conversationId: String(AB), userId: String(ids.C), isTyping: true });
  await tick();
  const old = await client();
  old.emit("join_chat", String(AB));
  await tick();
  old.emit("typing", { conversationId: String(AB), userId: String(ids.B), isTyping: false });
  await tick();
  console.log = log; console.warn = warn;
  check("typing reaches the other person as 'typing' with the token's account, conversation and isTyping", t1 && t1.args[0].userId === String(ids.A) && t1.args[0].conversationId === String(AB) && t1.args[0].isTyping === true, JSON.stringify(t1?.args));
  check("…not echoed to the sender", got(a, "typing").filter((x) => x.args[0].userId === String(ids.A)).length === 0);
  check("an outsider's typing reaches nobody", got(b, "typing").every((x) => x.args[0].userId !== String(ids.C)) && got(a, "typing").every((x) => x.args[0].userId !== String(ids.C)));
  const t3 = got(a, "typing").pop();
  check("an older app without a token still works (stage 1): relayed as before", t3 && t3.args[0].userId === String(ids.B) && t3.args[0].isTyping === false, JSON.stringify(t3?.args));

  for (const s of sockets) s.close();
  io.close(); httpServer.close();
  h.finish(server);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
