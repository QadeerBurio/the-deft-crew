// SEC-1 socket identity, with a real socket.io server and clients on in-memory data (socket/chatHandlers.js):
//   stage 1 (flags off):
//     - send_message with someone else's senderId → stored as the token's account (mismatch logged)
//     - an outsider (verified, not a participant) can't join the room, can't send into it, can't delete a message or the
//       conversation; a verified user deletes only their own message
//     - typing / start_call / mark_messages_read / offer carry the token's account and real name, not what was claimed
//     - 'authenticate' right before 'join_chat' (back to back) is judged with the identity
//     - user_online(otherId, token) marks the token's account online
//     - an older app without a token keeps working on what it sends (logged)
//   stage 2 (FLAG_SOCKET_TOKEN_REQUIRED=on): no token or a bad token → refused with auth_required, nothing stored;
//     verified clients unaffected
//   a banned account's token (FLAG_ACCOUNT_STATUS_ENFORCE on) is refused even in stage 1
//   node tests/socket-sec1/run.js [serverDir]
const http = require("http");
const h = require("../hiring-fixes/harness")(process.argv[2], { models: ["Chat"] });
const { reqS, check, oid, user, token, fake, coll } = h;
const { Server } = reqS("socket.io");
const { io: connect } = reqS("socket.io-client");
const { Message, Conversation } = reqS("./models/Chat");
const handlers = reqS("./socket/chatHandlers");
const sec = reqS("./socket/socketAuth");

const ids = { A: oid(), B: oid(), C: oid(), X: oid() };
fake.seed(coll("User"), [
  user(ids.A, "student", "Aisha Real"), user(ids.B, "student", "Bilal Real"), user(ids.C, "student", "Chaudhry Outsider"),
  user(ids.X, "student", "Xena Banned", { accountStatus: "banned" }),
]);
const T = { A: token(ids.A, "student"), B: token(ids.B, "student"), C: token(ids.C, "student"), X: token(ids.X, "student") };
const AB = oid(); const CX = oid();
fake.seed(Conversation.collection.collectionName, [
  { _id: AB, participants: [ids.A, ids.B], createdAt: new Date(), updatedAt: new Date() },
  { _id: CX, participants: [ids.C, ids.X], createdAt: new Date(), updatedAt: new Date() },
]);
const msgs = (f = () => true) => (fake.STORE.get(Message.collection.collectionName) || []).filter(f);
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

const httpServer = http.createServer();
const io = new Server(httpServer, { cors: { origin: "*" } });
handlers.attach(io);
let URL;
const sockets = [];
const client = (opts = {}) => new Promise((resolve) => {
  const s = connect(URL, { transports: ["websocket"], forceNew: true, reconnection: false, ...(opts.token ? { auth: { token: opts.token } } : {}) });
  s.got = [];
  s.onAny((ev, ...args) => s.got.push({ ev, args }));
  s.on("connect", () => resolve(s));
  sockets.push(s);
});
const got = (s, ev) => s.got.filter((x) => x.ev === ev);

(async () => {
  await new Promise((r) => httpServer.listen(0, r));
  URL = `http://127.0.0.1:${httpServer.address().port}`;
  const warn = console.warn; const warns = []; console.warn = (...a) => warns.push(a.join(" "));
  const log = console.log; console.log = () => {};
  delete process.env.FLAG_SOCKET_TOKEN_REQUIRED; delete process.env.FLAG_ACCOUNT_STATUS_ENFORCE;

  console.log = log; console.log("-- stage 1"); console.log = () => {};
  const a = await client({ token: T.A });
  const b = await client({ token: T.B });
  const c = await client({ token: T.C });
  b.emit("user_online", String(ids.B), T.B);
  a.emit("join_chat", String(AB)); b.emit("join_chat", String(AB));
  await tick();
  a.emit("send_message", { conversationId: String(AB), senderId: String(ids.C), text: "pretending to be C" });
  await tick(250);
  const m1 = msgs((m) => m.text === "pretending to be C")[0];
  check("send_message with someone else's senderId → stored as the token's account (A)", m1 && String(m1.sender) === String(ids.A), JSON.stringify(m1));
  check("…the mismatch is logged", warns.some((w) => /\[sec-1\] send_message: client id .* ≠ token/.test(w)) && sec.stats.mismatch >= 1);
  check("…B (in the room) got it as from A", got(b, "new_message").some((x) => String(x.args[0].sender?._id || x.args[0].sender) === String(ids.A)));

  c.emit("join_chat", String(AB));
  await tick();
  check("an outsider (verified C) can't join A–B's room: join_refused", got(c, "join_refused").length === 1);
  c.emit("send_message", { conversationId: String(AB), senderId: String(ids.A), text: "outsider message" });
  await tick(200);
  check("…can't send into it: message_error, nothing stored", got(c, "message_error").some((x) => /not a member/.test(x.args[0].error)) && msgs((m) => m.text === "outsider message").length === 0);
  check("…and receives nothing from the room", got(c, "new_message").length === 0);
  c.emit("delete_message", { messageId: String(m1._id), conversationId: String(AB) });
  await tick();
  check("…can't delete A's message", msgs((m) => String(m._id) === String(m1._id)).length === 1);
  c.emit("delete_conversation", { conversationId: String(AB) });
  await tick();
  check("…can't broadcast 'conversation deleted' for A–B", got(a, "conversation_deleted").length === 0 && got(b, "conversation_deleted").length === 0);

  a.emit("typing_start", { conversationId: String(AB), userId: String(ids.C), userName: "Fake Name" });
  await tick();
  const typ = got(b, "user_typing").pop();
  check("typing: the token's account and its real name, not the claimed ones", typ && typ.args[0].userId === String(ids.A) && typ.args[0].userName === "Aisha Real", JSON.stringify(typ?.args));
  a.emit("mark_messages_read", { conversationId: String(AB), userId: String(ids.B) });
  await tick();
  const rd = got(b, "messages_read").pop();
  check("mark_messages_read: as the token's account", rd && String(rd.args[0].userId) === String(ids.A), JSON.stringify(rd?.args));
  a.emit("start_call", { senderId: String(ids.C), receiverId: String(ids.B), senderName: "Someone Else", type: "audio" });
  await tick();
  const call = got(b, "incoming_call").pop();
  check("start_call: B sees the call from A, with A's real name", call && String(call.args[0].from) === String(ids.A) && call.args[0].name === "Aisha Real", JSON.stringify(call?.args));
  a.emit("offer", { offer: { sdp: "x" }, to: String(ids.B) });
  await tick();
  check("offer: 'from' is the token's account", got(b, "offer").some((x) => String(x.args[0].from) === String(ids.A)));
  a.emit("delete_message", { messageId: String(m1._id), conversationId: String(AB) });
  await tick();
  check("A deletes A's own message: deleted, the room told", msgs((m) => String(m._id) === String(m1._id)).length === 0 && got(b, "message_deleted").length === 1);

  // a module-level socket: connects without a token, then authenticate + join back to back
  const late = await client();
  late.emit("authenticate", T.B);
  late.emit("join_chat", String(AB));
  await tick(200);
  check("authenticate then join_chat back to back: judged with the identity (joined, no join_refused)", got(late, "join_refused").length === 0 && got(late, "auth_required").length === 0);
  a.emit("send_message", { conversationId: String(AB), senderId: String(ids.A), text: "after late join" });
  await tick(250);
  check("…and it receives the room's messages", got(late, "new_message").some((x) => x.args[0].text === "after late join"));

  const a2 = await client();
  a2.emit("user_online", String(ids.C), T.A);
  await tick(200);
  check("user_online(other id, token) → the token's account goes online, not the other", handlers.onlineUsers.get(String(ids.A)) === a2.id && handlers.onlineUsers.get(String(ids.C)) !== a2.id);

  const old = await client();
  old.emit("send_message", { conversationId: String(AB), senderId: String(ids.B), text: "older app message" });
  await tick(250);
  const m2 = msgs((m) => m.text === "older app message")[0];
  check("older app without a token (stage 1): works on what it sends, as before", m2 && String(m2.sender) === String(ids.B));
  check("…logged once as legacy", warns.filter((w) => /send_message without a token/.test(w)).length === 1);
  old.emit("send_message", { conversationId: String(AB), senderId: String(ids.B), text: "older app again" });
  await tick(200);
  check("…not logged again for the same socket and event", warns.filter((w) => /send_message without a token/.test(w)).length === 1);

  console.log = log; console.log("-- stage 2 (socketTokenRequired on)"); console.log = () => {};
  process.env.FLAG_SOCKET_TOKEN_REQUIRED = "on";
  const old2 = await client();
  old2.emit("send_message", { conversationId: String(AB), senderId: String(ids.B), text: "stage 2 no token" });
  old2.emit("join_chat", String(AB));
  old2.emit("user_online", String(ids.B));
  await tick(250);
  check("no token: send_message refused (auth_required), nothing stored", got(old2, "auth_required").some((x) => x.args[0].event === "send_message") && msgs((m) => m.text === "stage 2 no token").length === 0);
  check("…join_chat refused", got(old2, "auth_required").some((x) => x.args[0].event === "join_chat"));
  check("…user_online without a token ignored", handlers.onlineUsers.get(String(ids.B)) !== old2.id);
  const bad = await client({ token: "not-a-real-token" });
  bad.emit("send_message", { conversationId: String(AB), senderId: String(ids.A), text: "bad token" });
  await tick(250);
  check("a bad token: refused, nothing stored", got(bad, "auth_required").length === 1 && msgs((m) => m.text === "bad token").length === 0);
  a.emit("send_message", { conversationId: String(AB), senderId: String(ids.A), text: "stage 2 verified" });
  await tick(250);
  check("a verified client still works", msgs((m) => m.text === "stage 2 verified" && String(m.sender) === String(ids.A)).length === 1);
  delete process.env.FLAG_SOCKET_TOKEN_REQUIRED;

  console.log = log; console.log("-- locked account"); console.log = () => {};
  process.env.FLAG_ACCOUNT_STATUS_ENFORCE = "on";
  const x = await client({ token: T.X });
  x.emit("send_message", { conversationId: String(CX), senderId: String(ids.X), text: "banned speaks" });
  await tick(250);
  check("a banned account's token is refused even in stage 1 (auth_required, nothing stored)", got(x, "auth_required").length === 1 && msgs((m) => m.text === "banned speaks").length === 0);
  delete process.env.FLAG_ACCOUNT_STATUS_ENFORCE;

  console.warn = warn; console.log = log;
  for (const s of sockets) s.close();
  io.close(); httpServer.close();
  const failed = h.results.filter((r) => !r).length;
  console.log(`\n${h.results.length - failed}/${h.results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
