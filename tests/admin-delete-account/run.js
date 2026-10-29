// Deleting brand and student accounts: DELETE /api/admin/users/:id, its preview, and the app's
// DELETE /api/auth/delete-account (services/accountDeletion.js).
//   node tests/admin-delete-account/run.js [serverDir]
// Real route files, models and service; only MongoDB (tests/hide-user-secrets/fake-mongo.js, plus the
// small aggregate interpreter from tests/perf-server), Cloudinary, e-mail, Expo and outgoing HTTP are
// replaced. No database, no network, no .env (dotenv is stubbed; run it from a folder without one).
const path = require("path");
const http = require("http");
const Module = require("module");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
process.env.JWT_SECRET = "test-only";
process.env.DISABLE_NOTIFICATION_PUSH = "true";
for (const k of ["MONGO_URI", "MONGODB_URI", "REDIS_URL", "ADMIN_DELETE_ENABLED", "AI_DB_NAME"]) delete process.env[k];

// ---------- stubs (before any server file loads) ----------
class Expo {
  constructor() {}
  static isExpoPushToken() { return false; }
  chunkPushNotifications(m) { return [m]; }
  async sendPushNotificationsAsync(ms) { return ms.map(() => ({ status: "ok", id: "ticket" })); }
  chunkPushNotificationReceiptIds(ids) { return [ids]; }
  async getPushNotificationReceiptsAsync() { return {}; }
}
// Cloudinary: records what would be removed; "testcloud" is ours
const destroyed = [];
const cloudinary = {
  config: () => ({ cloud_name: "testcloud" }),
  uploader: { destroy: async (publicId, opts) => { destroyed.push(`${opts?.resource_type || "image"}:${publicId}`); return { result: "ok" }; } },
  url: () => "",
};
const passThrough = () => (req, res, next) => next();
const multerLike = { single: passThrough, array: passThrough, fields: passThrough, any: passThrough, none: passThrough };
const cloudConfig = new Proxy(
  { cloudinary, hasCloudinary: true, deleteFromCloudinary: async () => ({}), getCloudinaryUrl: () => "", storage: {} },
  { get: (t, k) => (k in t ? t[k] : multerLike) }
);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  if (request === "expo-server-sdk") return { Expo };
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("utils", "mailer.js"))) return { sendMail: async () => ({ sent: true }), logMailerStatus: () => {}, mailProvider: "test" };
  if (resolved.endsWith(path.join("config", "cloudinary.js"))) return cloudConfig;
  return origLoad.apply(this, arguments);
};
const axios = reqS("axios");
const blocked = (method) => async (url) => { throw new Error(`network blocked in test: ${method.toUpperCase()} ${url}`); };
for (const m of ["get", "post", "put", "patch", "delete"]) axios[m] = blocked(m);
axios.request = async (cfg) => blocked((cfg.method || "get").toLowerCase())(cfg.url);

const mongoose = reqS("mongoose");
const fake = require(path.join(SERVER, "tests", "hide-user-secrets", "fake-mongo"));
fake.install(mongoose, mongoose.Types.ObjectId);

// ---------- aggregate interpreter (from tests/perf-server, plus $in): $match, $unwind, $group ----------
const isOid = (v) => v != null && typeof v === "object" && v._bsontype === "ObjectId";
const norm = (v) => (isOid(v) ? String(v) : v instanceof Date ? v.getTime() : v);
const at = (doc, p) => p.split(".").reduce((o, k) => (o == null ? undefined : Array.isArray(o) ? o.map((x) => x?.[k]) : o[k]), doc);
const condOk = (val, cond) => {
  const vals = (Array.isArray(val) ? val.flat() : [val]).map(norm);
  if (cond && typeof cond === "object" && !isOid(cond) && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === "$gt") return vals.some((v) => v > norm(arg));
      if (op === "$in") return vals.some((v) => arg.map(norm).includes(v));
      throw new Error(`aggregate test: unsupported ${op}`);
    });
  }
  return vals.includes(norm(cond));
};
const evalExpr = (e, doc) => {
  if (typeof e === "string" && e.startsWith("$")) return at(doc, e.slice(1));
  if (e == null || typeof e !== "object" || isOid(e)) return e;
  const out = {}; for (const [k, v] of Object.entries(e)) out[k] = evalExpr(v, doc); return out;
};
const P = Object.getPrototypeOf(mongoose.connection.collection("__agg_probe"));
P.aggregate = function (pipeline) {
  let docs = (fake.STORE.get(this.collectionName || this.name) || []).map((d) => d);
  for (const stage of pipeline) {
    const [[op, arg]] = Object.entries(stage);
    if (op === "$match") docs = docs.filter((d) => Object.entries(arg).every(([k, c]) => condOk(at(d, k), c)));
    else if (op === "$unwind") { const f = arg.slice(1); docs = docs.flatMap((d) => (d[f] || []).map((x) => ({ ...d, [f]: x }))); }
    else if (op === "$group") {
      const groups = new Map();
      for (const d of docs) { const key = arg._id == null ? null : evalExpr(arg._id, d); const k = String(norm(key)); if (!groups.has(k)) groups.set(k, { _id: key, _docs: [] }); groups.get(k)._docs.push(d); }
      docs = [...groups.values()].map(({ _id, _docs }) => {
        const g = { _id };
        for (const [field, acc] of Object.entries(arg)) { if (field === "_id") continue; if ("$sum" in acc) g[field] = _docs.reduce((s, d) => s + (Number(evalExpr(acc.$sum, d)) || 0), 0); else throw new Error("aggregate test: unsupported accumulator"); }
        return g;
      });
    } else throw new Error(`aggregate test: unsupported stage ${op}`);
  }
  const c = { toArray: async () => docs, async *[Symbol.asyncIterator]() { for (const d of docs) yield d; }, close: async () => {} };
  for (const m of ["sort", "limit", "skip", "project", "batchSize", "maxTimeMS", "allowDiskUse", "hint", "comment", "option"]) c[m] = () => c;
  return c;
};

const express = reqS("express");
const jwt = reqS("jsonwebtoken");
const M = (file, name) => { const x = reqS(`./models/${file}`); return name ? x[name] : x; };
const coll = (Model) => Model.collection.collectionName;
const Models = {
  User: M("User"), Offer: M("Offer"), PromoCode: M("PromoCode"), Branch: M("Branch"), Campaign: M("Campaign"), Reward: M("Reward"),
  RewardRedemption: M("RewardRedemption"), ShopifyStore: M("ShopifyStore"), DailyDrop: M("DailyDrop"), EngagementProfile: M("EngagementProfile"),
  EngagementEvent: M("EngagementEvent"), PointsLedger: M("PointsLedger"), UserBadge: M("UserBadge"), DropReaction: M("DropReaction"),
  SavedItem: M("SavedItem"), Credential: M("Credential"), PartnerApplication: M("PartnerApplication"), PartnerPost: M("PartnerPost"),
  ReferralClick: M("ReferralClick"), Post: M("Post"), Confession: M("Confession"), Story: M("Story"), Message: M("Chat", "Message"),
  Conversation: M("Chat", "Conversation"), Notification: M("Notification"), SocialNotification: M("SocialNotification"), BlockedUser: M("BlockedUser"),
  Report: M("Report"), Listing: M("Listing"), Inquiry: M("Inquiry"), SkillOffer: M("SkillOffer"), Match: M("Match"), Resume: M("Resume"),
  SkillGapCache: M("SkillGapCache"), ProfessionalProfile: M("ProfessionalProfile"), JobApplication: M("JobApplication"), JobInteraction: M("JobInteraction"),
  Application: M("Application"), Event: M("Event", "Event"), Registration: M("Event", "Registration"), EventNotification: M("Event", "EventNotification"),
  Booking: M("Booking"), PushLog: M("PushLog"), SocialPushDaily: M("SocialPushDaily"), SocialPushGroup: M("SocialPushGroup"), OtpCode: M("OtpCode"),
  RedemptionArchive: M("RedemptionArchive"), AdminAuditLog: M("AdminAuditLog"),
};

// ---------- app + leak scanner ----------
const HIDDEN = ["password", "webhookSecret", "wooConsumerKey", "wooConsumerSecret", "shopifyAccessToken", "shopifyClientId", "shopifyClientSecret", "shopifyWebhookSecret", "pushTokens", "idCardFront", "idCardBack", "livePicture", "accessToken"];
const responses = [];
const keysIn = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysIn(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); } return out; };
const app = express();
app.set("io", { to: () => ({ emit() {} }), emit() {} });
app.use(express.json());
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => {
    const text = Buffer.isBuffer(body) ? body.toString() : typeof body === "string" ? body : JSON.stringify(body);
    let keys = new Set();
    try { keys = keysIn(JSON.parse(text)); } catch {}
    const leaks = HIDDEN.filter((k) => keys.has(k));
    if (/\$2[ab]\$|ExponentPushToken\[|ck_secret|shpat_/.test(text)) leaks.push("secret value");
    responses.push({ url: req.originalUrl, method: req.method, status: res.statusCode, leaks, text });
    return send(body);
  };
  next();
});
app.use("/api/auth", reqS("./routes/auth.routes"));
app.use("/api/admin", reqS("./routes/admin.routes"));
app.use("/api/offers", reqS("./routes/offer.routes"));
app.use("/api/promo-codes", reqS("./routes/promoCode.routes"));

// ---------- seed ----------
const oid = () => new mongoose.Types.ObjectId();
const ids = {};
for (const k of ["admin", "admin2", "B", "C", "S", "T", "U", "E", "V", "X"]) ids[k] = oid();
const now = Date.now();
const ago = (h) => new Date(now - h * 3600 * 1000);
const later = (h) => new Date(now + h * 3600 * 1000);
const cloud = (p, type = "image") => `https://res.cloudinary.com/testcloud/${type}/upload/v1700000000/${p}`;
const seed = (Model, docs) => fake.seed(coll(Model), docs);
const user = (id, role, name, extra = {}) => ({ _id: id, name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@test.local`, password: "$2a$04$seedhashseedhashseedhashseedhashseedhashseedhashseedha", role, status: "Verified", accountStatus: "active", pushTokens: [{ token: `ExponentPushToken[SEED-${name}]` }], createdAt: new Date(), updatedAt: new Date(), ...extra });
const NAMES = { B: "Dear Croissant", S: "Sana Malik" };
seed(Models.User, [
  user(ids.admin, "admin", "Admin One"), user(ids.admin2, "admin", "Admin Two"),
  user(ids.B, "brand", "Bilal Owner", { brandName: NAMES.B, logo: cloud("TDC_CompanyLogos/b-logo.png"), profileImage: "https://res.cloudinary.com/othercloud/image/upload/v1/not-ours.png", wooConsumerKey: "ck_secret_b" }),
  user(ids.C, "brand", "Chai Owner", { brandName: "Chai Spot", logo: cloud("TDC_CompanyLogos/c-logo.png") }),
  user(ids.X, "brand", "Xpress Owner", { brandName: "Xpress Burgers" }),
  user(ids.S, "student", NAMES.S, { profileImage: cloud("TDC_Profiles/sana.jpg"), idCardFront: cloud("TDC_Profiles/sana-id.jpg"), connections: [ids.T] }),
  user(ids.T, "student", "Taha Ali", { connections: [ids.S], sentRequests: [ids.S], receivedRequests: [ids.S], referredBy: ids.S }),
  user(ids.U, "student", "Umar Self"),
  user(ids.E, "employee", "Emp Loyer", { companyName: "Hire Co" }),
  user(ids.V, "traveler", "Trav Eller"),
]);

// brand B (deleted first), brand C (stays), brand X (failure + re-run)
const r = (student, bill, saved, hoursAgo) => ({ _id: oid(), student, billAmount: bill, savedAmount: saved, redeemedAt: ago(hoursAgo) });
const red = { bT: r(ids.T, 1000, 200, 5), bS: r(ids.S, 500, 100, 30), cT: r(ids.T, 800, 160, 2), cS: r(ids.S, 600, 120, 3), xT: r(ids.T, 400, 40, 6) };
const offer = (id, brand, title, redemptions, extra = {}) => ({ _id: id, brand, title, discountPercentage: 20, category: "Cafe", active: true, claimedBy: [], redemptions, promoCodesGenerated: [], createdAt: new Date(), updatedAt: new Date(), ...extra });
ids.oB1 = oid(); ids.oB2 = oid(); ids.oC1 = oid(); ids.oX1 = oid();
seed(Models.Offer, [
  offer(ids.oB1, ids.B, "B: 20% off", [red.bT, red.bS], { image: cloud("TDC_Offers/b-offer.jpg"), claimedBy: [ids.T, ids.S] }),
  offer(ids.oB2, ids.B, "B: weekday", []),
  offer(ids.oC1, ids.C, "C: chai deal", [red.cT, red.cS], { claimedBy: [ids.S, ids.T] }),
  offer(ids.oX1, ids.X, "X: burger", [red.xT]),
]);
const promo = (brand, student, status, extra = {}) => ({ _id: oid(), code: `CODE${Math.random().toString(36).slice(2, 8).toUpperCase()}`, offer: extra.offer || ids.oB1, student, brand, discountPercentage: 20, offerTitle: "deal", brandName: "brand", status, externalProvider: "none", externalAmount: 0, expiresAt: later(48), createdAt: new Date(), ...extra });
ids.pcSUsedC = oid(); ids.pcSActiveC = oid();
const pcSUsedCode = "SANAUSED";
seed(Models.PromoCode, [
  promo(ids.B, ids.T, "used", { externalAmount: 2000, usedBy: ids.T, usedAt: ago(10) }),
  promo(ids.B, ids.T, "active", { externalProvider: "shopify" }),
  promo(ids.C, ids.S, "used", { _id: ids.pcSUsedC, code: pcSUsedCode, offer: ids.oC1, externalAmount: 1500, usedBy: ids.S, usedAt: ago(8) }),
  promo(ids.C, ids.S, "active", { _id: ids.pcSActiveC, offer: ids.oC1, externalProvider: "woocommerce" }),
  promo(ids.X, ids.T, "used", { offer: ids.oX1, externalAmount: 900 }),
]);
fake.STORE.get(coll(Models.Offer)).find((o) => String(o._id) === String(ids.oC1)).promoCodesGenerated = [ids.pcSUsedC, ids.pcSActiveC];
seed(Models.Branch, [{ _id: oid(), brand: ids.B, name: "DHA" }, { _id: oid(), brand: ids.C, name: "Clifton" }, { _id: oid(), brand: ids.X, name: "Saddar" }]);
ids.campB = oid();
seed(Models.Campaign, [
  { _id: ids.campB, name: "B campaign", brand: ids.B, partner: ids.T, followerPercent: 10, startsAt: ago(100), endsAt: later(100), status: "live" },
  { _id: oid(), name: "C campaign", brand: ids.C, partner: ids.S, followerPercent: 10, startsAt: ago(100), endsAt: later(100), status: "live" },
]);
ids.rB = oid(); ids.rC = oid(); ids.rrActiveT = oid(); ids.rrUsedT = oid();
seed(Models.Reward, [{ _id: ids.rB, brand: ids.B, title: "free coffee", costPoints: 250, image: cloud("TDC_Offers/b-reward.jpg") }, { _id: ids.rC, brand: ids.C, title: "free chai", costPoints: 100 }]);
const rr = (id, userId, reward, brand, status, extra = {}) => ({ _id: id, user: userId, reward, rewardBrand: brand, code: `TDC-${String(id).slice(-8)}`, costPoints: 250, status, expiresAt: later(200), snapshot: { title: "a reward", brand }, createdAt: new Date(), ...extra });
seed(Models.RewardRedemption, [
  rr(ids.rrActiveT, ids.T, ids.rB, ids.B, "active"),
  rr(ids.rrUsedT, ids.T, ids.rB, ids.B, "used", { usedAt: ago(20) }),
  rr(oid(), ids.S, ids.rC, ids.C, "active", { costPoints: 100 }),
  rr(oid(), ids.S, ids.rC, ids.C, "used", { costPoints: 100, usedBy: ids.S }),
]);
seed(Models.ShopifyStore, [{ _id: oid(), brandId: ids.B, shop: "dear-croissant.myshopify.com", accessToken: "shpat_secret", status: "active" }]);
seed(Models.DailyDrop, [{ _id: oid(), dayKey: "2026-10-30", title: "drop", contentRef: { kind: "offer", id: ids.oB1, label: "B offer" } }]);
seed(Models.EngagementProfile, [
  { _id: oid(), user: ids.T, points: { balance: 100, lifetime: 500 }, welcomePerk: { campaign: ids.campB, brand: ids.B, percent: 10, usedAt: null }, stats: { totalSaved: 360 } },
  { _id: oid(), user: ids.S, points: { balance: 40, lifetime: 40 } },
]);

// student S's world (T stays and interacts with S)
ids.pS = oid(); ids.pT = oid(); ids.c1 = oid(); ids.c2 = oid(); ids.c3 = oid();
seed(Models.Post, [
  { _id: ids.pS, author: ids.S, content: "my post", image: cloud("TDC_Posts/sana-post.jpg"), likes: [ids.T], comments: [{ _id: oid(), user: ids.T, text: "nice" }], createdAt: new Date() },
  { _id: ids.pT, author: ids.T, content: "taha's post", likes: [ids.S, ids.T], favorites: [ids.S], viewedBy: [ids.S, ids.T],
    comments: [
      { _id: ids.c1, user: ids.S, text: "hello @taha", mentions: [ids.T], parentComment: null },
      { _id: ids.c2, user: ids.T, text: "hi @sana", mentions: [ids.S], parentComment: ids.c1 },
      { _id: ids.c3, user: ids.T, text: "top level", mentions: [], parentComment: null },
    ],
    poll: [{ _id: oid(), option: "a", votes: 2, votedBy: [ids.S, ids.T] }, { _id: oid(), option: "b", votes: 0, votedBy: [] }], createdAt: new Date() },
]);
ids.cfT = oid();
seed(Models.Confession, [
  { _id: oid(), authorId: ids.S, content: "secret", image: cloud("TDC_Posts/conf.jpg"), likes: 0, likedBy: [] },
  { _id: ids.cfT, authorId: ids.T, content: "t secret", likes: 2, likedBy: [ids.S, ids.T], comments: [{ _id: oid(), user: ids.S, text: "same", mentions: [] }, { _id: oid(), user: ids.T, text: "ok", mentions: [ids.S] }] },
]);
ids.stT = oid();
seed(Models.Story, [
  { _id: oid(), author: ids.S, image: cloud("TDC_Stories/s.jpg"), expiresAt: later(10) },
  { _id: ids.stT, author: ids.T, image: "x", likes: [ids.S], seenBy: [ids.S, ids.T], comments: [{ user: ids.S, text: "wow" }, { user: ids.T, text: "ty" }], expiresAt: later(10) },
]);
ids.cv = oid(); ids.cvTU = oid();
seed(Models.Conversation, [{ _id: ids.cv, participants: [ids.S, ids.T], lastMessage: "hey", lastMessageSender: ids.S }, { _id: ids.cvTU, participants: [ids.T, ids.U], lastMessage: "yo" }]);
seed(Models.Message, [
  { _id: oid(), conversationId: ids.cv, sender: ids.S, text: "hey", messageType: "image", mediaUrl: cloud("TDC_Chat/s-pic.jpg") },
  { _id: oid(), conversationId: ids.cv, sender: ids.T, text: "hi", messageType: "image", mediaUrl: cloud("TDC_Chat/t-pic.jpg") },
  { _id: oid(), conversationId: ids.cvTU, sender: ids.T, text: "yo" },
]);
seed(Models.Notification, [
  { _id: oid(), recipient: ids.S, title: "for s", description: "x", type: "System" },
  { _id: oid(), recipient: ids.T, sender: ids.S, title: "s liked your post", description: "x", type: "System" },
  { _id: oid(), recipient: ids.T, title: "broadcast", description: "x", type: "System", readBy: [ids.S, ids.T], deletedBy: [ids.S] },
  { _id: oid(), recipient: ids.B, title: "for brand", description: "x", type: "Brand" },
  { _id: oid(), recipient: ids.T, sender: ids.B, title: "brand says hi", description: "x", type: "Brand" },
]);
seed(Models.SocialNotification, [{ _id: oid(), recipient: ids.T, sender: ids.S, type: "like", readBy: [] }, { _id: oid(), recipient: ids.T, sender: ids.T, type: "x", readBy: [ids.S, ids.T] }]);
seed(Models.BlockedUser, [{ _id: oid(), userId: ids.T, blockedUserId: ids.S }]);
ids.repBy = oid(); ids.repAbout = oid();
seed(Models.Report, [
  { _id: ids.repBy, reporterId: ids.S, reportedUserId: ids.T, contentType: "User", reason: "spam", status: "pending" },
  { _id: ids.repAbout, reporterId: ids.T, reportedUserId: ids.S, contentType: "User", reason: "spam", status: "pending" },
]);
ids.lS = oid(); ids.lT = oid();
seed(Models.Listing, [{ _id: ids.lS, ownerId: ids.S, title: "tutoring", attachments: [{ url: cloud("TDC_Listings/l.jpg"), type: "image" }] }, { _id: ids.lT, ownerId: ids.T, title: "design" }]);
seed(Models.Inquiry, [{ _id: oid(), listingId: ids.lS, userId: String(ids.T), conversationId: oid() }, { _id: oid(), listingId: ids.lT, userId: String(ids.S), conversationId: oid() }]);
seed(Models.SkillOffer, [{ _id: oid(), listingId: ids.lT, offerorId: String(ids.S) }, { _id: oid(), listingId: ids.lS, offerorId: String(ids.T) }]);
seed(Models.Match, [{ _id: oid(), listingId: ids.lT, offerId: oid(), listingOwnerId: String(ids.T), offerorId: String(ids.S) }]);
ids.evS = oid(); ids.evUp = oid(); ids.evPast = oid(); ids.regPast = oid();
seed(Models.Event, [
  { _id: ids.evS, title: "Sana's meetup", creator: ids.S, creatorName: NAMES.S, creatorEmail: "sana.malik@test.local", image: cloud("TDC_Events/s-ev.jpg"), registeredCount: 1 },
  { _id: ids.evUp, title: "Hackathon", creator: ids.admin, parsedDate: later(240), registeredCount: 2 },
  { _id: ids.evPast, title: "Old fest", creator: ids.admin, parsedDate: ago(240), registeredCount: 1 },
]);
const reg = (id, eventId, userId, name, extra = {}) => ({ _id: id || oid(), eventId, userId, studentName: name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@test.local`, whatsapp: "03001234567", studentId: "21K-1", userName: name, university: "SZABIST", seats: 1, ...extra });
seed(Models.Registration, [
  reg(null, ids.evS, ids.T, "Taha Ali"),
  reg(null, ids.evUp, ids.S, NAMES.S),
  reg(ids.regPast, ids.evPast, ids.S, NAMES.S, { answers: { q: "a" }, payment: { status: "verified", amount: 500, transactionId: "TX123", receiptUrl: cloud("TDC_Events/receipt.jpg") } }),
]);
seed(Models.EventNotification, [{ _id: oid(), eventId: ids.evS, eventTitle: "m", creatorId: ids.S, creatorEmail: "x", registrantId: ids.T, registrantName: "Taha Ali", registrantEmail: "t", registrantWhatsapp: "1" }, { _id: oid(), eventId: ids.evUp, eventTitle: "h", creatorId: ids.admin, creatorEmail: "x", registrantId: ids.S, registrantName: NAMES.S, registrantEmail: "s", registrantWhatsapp: "1" }]);
seed(Models.Booking, [
  { _id: oid(), userId: ids.S, packageId: oid(), packageName: "Hunza", customerName: NAMES.S, customerEmail: "sana.malik@test.local", customerPhone: "0300", totalAmount: 30000, status: "confirmed", specialRequests: "veg" },
  { _id: oid(), userId: ids.T, packageId: oid(), packageName: "Swat", customerName: "Taha Ali", customerEmail: "t@test.local", customerPhone: "0301", totalAmount: 20000, status: "completed" },
]);
ids.resS = oid();
seed(Models.Resume, [{ _id: ids.resS, user: ids.S, uploadedResume: { fileUrl: cloud("TDC_Resumes/sana-cv.pdf", "raw"), publicId: "TDC_Resumes/sana-cv.pdf" } }]);
seed(Models.SkillGapCache, [{ _id: oid(), resumeId: ids.resS, jobId: oid() }]);
seed(Models.ProfessionalProfile, [{ _id: oid(), userId: ids.S }]);
seed(Models.JobApplication, [{ _id: oid(), userId: ids.S, jobId: oid(), coverLetter: "hi", resumePublicId: "TDC_Job_Resumes/sana-app.pdf" }]);
seed(Models.JobInteraction, [{ _id: oid(), userId: ids.S, jobId: oid(), interactionType: "view" }]);
seed(Models.Application, [{ _id: oid(), userId: ids.S, programId: oid() }]);
seed(Models.EngagementEvent, [{ _id: oid(), user: ids.S, name: "open_app" }, { _id: oid(), user: ids.T, name: "open_app" }]);
seed(Models.PointsLedger, [{ _id: oid(), user: ids.S, delta: 40, balanceAfter: 40, reason: "x" }]);
seed(Models.UserBadge, [{ _id: oid(), user: ids.S, badgeId: "first" }]);
seed(Models.DropReaction, [{ _id: oid(), user: ids.S, drop: oid() }]);
seed(Models.SavedItem, [{ _id: oid(), user: ids.S, kind: "trip", refId: oid() }]);
seed(Models.Credential, [{ _id: oid(), user: ids.S, issuedBy: ids.admin }]);
seed(Models.PartnerApplication, [{ _id: oid(), user: ids.S, university: "x", why: "y" }]);
seed(Models.PartnerPost, [{ _id: oid(), user: ids.S, platform: "instagram", url: "https://instagram.com/p/1", screenshotUrl: cloud("TDC_Partner/shot.jpg") }]);
seed(Models.ReferralClick, [{ _id: oid(), code: "SANA1", referrer: ids.S }]);
seed(Models.PushLog, [{ _id: oid(), user: ids.S }]);
seed(Models.SocialPushDaily, [{ _id: oid(), user: ids.S }]);
seed(Models.SocialPushGroup, [{ _id: oid(), kind: "post", scope: "all", status: "open", sendAfter: later(1), items: [{ id: ids.pS, authorId: ids.S, firstName: "Sana" }, { id: ids.pT, authorId: ids.T, firstName: "Taha" }] }]);
seed(Models.OtpCode, [{ _id: oid(), user: ids.S, purpose: "signup" }]);
fake.seed("chat_sessions", [{ sessionId: "sess-s", userId: String(ids.S) }, { sessionId: "sess-t", userId: String(ids.T) }]);
fake.seed("chat_messages", [{ sessionId: "sess-s", role: "user", content: "hi" }, { sessionId: "sess-t", role: "user", content: "yo" }]);
fake.seed("conversation_memory", [{ sessionId: "sess-s" }, { sessionId: "sess-t" }]);
seed(Models.Post, [{ _id: oid(), author: ids.U, content: "u post" }]);

const token = (who, role) => jwt.sign({ id: String(ids[who]), role }, "test-only", { expiresIn: "1h" });

// ---------- HTTP ----------
let PORT;
function call(method, url, { body, tok } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = {};
    if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    if (tok) h.authorization = `Bearer ${tok}`;
    const q = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers: h }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    q.on("error", (e) => resolve({ status: 0, json: null, text: String(e) }));
    if (data != null) q.write(data);
    q.end();
  });
}
const results = [];
const check = (name, ok, detail = "") => { results.push({ ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const rows = (Model, f = () => true) => (fake.STORE.get(coll(Model)) || []).filter(f);
const same = (a, b) => String(a) === String(b);
// every place an id still appears (ObjectId or string), outside the audit log
function whereIs(id) {
  const hits = [];
  const walk = (v, where) => {
    if (v == null) return;
    if (isOid(v)) { if (same(v, id)) hits.push(where); return; }
    if (typeof v === "string") { if (v === String(id)) hits.push(where); return; }
    if (v instanceof Date) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, where));
    if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  for (const [name, docs] of fake.STORE) { if (name === coll(Models.AdminAuditLog)) continue; docs.forEach((d) => walk(d, name)); }
  return [...new Set(hits)];
}
const textAnywhere = (needle, skip = []) => [...fake.STORE].filter(([n]) => !skip.includes(n)).filter(([, docs]) => JSON.stringify(docs).includes(needle)).map(([n]) => n);

(async () => {
  const server = app.listen(0); PORT = server.address().port;
  const ADMIN = token("admin", "admin"), T = token("T", "student"), S = token("S", "student"), BRAND_C = token("C", "brand"), U = token("U", "student"), E = token("E", "employee");
  const summary = async () => (await call("GET", "/api/offers/admin/brands-revenue", { tok: ADMIN })).json?.summary || {};
  const FIG = ["totalRevenue", "totalBill", "totalSaved", "totalRedemptions", "uniqueStudents", "brandsWithRevenue", "averageRevenue"];
  const figs = (s) => FIG.map((k) => `${k}=${s[k]}`).join(" ");
  const savingsT = async () => (await call("GET", "/api/offers/my-total-savings", { tok: T })).json;
  const redemptionsT = async () => ((await call("GET", "/api/offers/my-redemptions", { tok: T })).json?.redemptions || []).map((x) => `${x.redemptionId}:${x.offerId}`).sort().join();
  const travel = async () => (await call("GET", "/api/admin/bookings/stats", { tok: ADMIN })).json?.totalRevenue;

  console.log("── who may delete");
  let res = await call("DELETE", `/api/admin/users/${ids.S}`, { body: { confirmName: NAMES.S } });
  check("no token → refused", res.status === 401 || res.status === 403, res.status);
  res = await call("DELETE", `/api/admin/users/${ids.S}`, { tok: T, body: { confirmName: NAMES.S } });
  check("a student → 403", res.status === 403, res.status);
  res = await call("DELETE", `/api/admin/users/${ids.S}`, { tok: BRAND_C, body: { confirmName: NAMES.S } });
  check("a brand → 403", res.status === 403, res.status);
  res = await call("GET", `/api/admin/users/${ids.S}/delete-preview`, { tok: T });
  check("preview: a student → 403", res.status === 403, res.status);
  res = await call("DELETE", `/api/admin/users/${ids.S}`, { tok: ADMIN, body: { confirmName: NAMES.S } });
  check("ADMIN_DELETE_ENABLED not set → 503, nothing deleted", res.status === 503 && rows(Models.User, (u) => same(u._id, ids.S)).length === 1, res.status);
  res = await call("GET", `/api/admin/users/${ids.B}/delete-preview`, { tok: ADMIN });
  check("preview answers while off: enabled false, name to type, counts", res.status === 200 && res.json.enabled === false && res.json.name === NAMES.B && res.json.counts?.offers === 2 && res.json.counts?.activeRewardCodesRefunded === 1, JSON.stringify(res.json));
  process.env.ADMIN_DELETE_ENABLED = "true";
  res = await call("DELETE", `/api/admin/users/${ids.admin}`, { tok: ADMIN, body: { confirmName: "Admin One" } });
  check("an admin deleting themself → 400", res.status === 400, `${res.status} ${res.json?.message}`);
  res = await call("GET", `/api/admin/users/${ids.admin}/delete-preview`, { tok: ADMIN });
  check("preview of themself → 400", res.status === 400, res.status);
  res = await call("DELETE", `/api/admin/users/${ids.admin2}`, { tok: ADMIN, body: { confirmName: "Admin Two" } });
  check("another admin → 403", res.status === 403 && rows(Models.User, (u) => same(u._id, ids.admin2)).length === 1, `${res.status} ${res.json?.message}`);
  res = await call("DELETE", `/api/admin/users/${ids.E}`, { tok: ADMIN, body: { confirmName: "Emp Loyer" } });
  check("an employer → 400 not supported yet", res.status === 400 && res.json?.message === "not supported yet", `${res.status} ${res.json?.message}`);
  res = await call("DELETE", `/api/admin/users/${ids.V}`, { tok: ADMIN, body: { confirmName: "Trav Eller" } });
  check("a traveler → 400 not supported yet", res.status === 400 && res.json?.message === "not supported yet", `${res.status} ${res.json?.message}`);
  res = await call("DELETE", `/api/admin/users/${oid()}`, { tok: ADMIN, body: { confirmName: "x" } });
  check("unknown id → 404", res.status === 404, res.status);
  res = await call("DELETE", "/api/admin/users/not-an-id", { tok: ADMIN, body: { confirmName: "x" } });
  check("invalid id → 400", res.status === 400, res.status);
  res = await call("DELETE", `/api/admin/users/${ids.B}`, { tok: ADMIN, body: { confirmName: "dear croissant" } });
  check("wrong name (case) → 400, nothing deleted", res.status === 400 && rows(Models.Offer, (o) => same(o.brand, ids.B)).length === 2, `${res.status} ${res.json?.message}`);
  res = await call("DELETE", `/api/admin/users/${ids.B}`, { tok: ADMIN });
  check("no name → 400", res.status === 400, res.status);
  check("no audit entry for refused attempts", rows(Models.AdminAuditLog).length === 0, rows(Models.AdminAuditLog).length);

  console.log("── delete brand B");
  const before = { s: await summary(), t: await savingsT(), tr: await redemptionsT(), travel: await travel() };
  const pointsT = rows(Models.EngagementProfile, (p) => same(p.user, ids.T))[0].points.balance;
  res = await call("DELETE", `/api/admin/users/${ids.B}`, { tok: ADMIN, body: { confirmName: NAMES.B } });
  check("admin deletes brand B → 200 with counts", res.status === 200 && res.json?.role === "brand" && res.json?.counts?.offers?.deleted === 2, `${res.status} ${res.text.slice(0, 160)}`);
  const afterB = { s: await summary(), t: await savingsT(), tr: await redemptionsT(), travel: await travel() };
  check("revenue figures unchanged", figs(afterB.s) === figs(before.s), `${figs(before.s)} → ${figs(afterB.s)}`);
  check("summary.deletedBrands counts 1 brand", afterB.s.deletedBrands?.count === 1 && afterB.s.totalBrands === before.s.totalBrands - 1, JSON.stringify(afterB.s.deletedBrands));
  check("student T: total saved and count unchanged", JSON.stringify(afterB.t) === JSON.stringify(before.t), `${JSON.stringify(before.t)} → ${JSON.stringify(afterB.t)}`);
  check("student T: my-redemptions same ids (Meta dedupe)", afterB.tr === before.tr && afterB.tr.includes(String(red.bT._id)), afterB.tr);
  const archive = rows(Models.RedemptionArchive);
  check("archive: one row per redemption, student kept, plus brand totals", archive.filter((a) => a.kind === "redemption").length === 2 && archive.some((a) => a.kind === "redemption" && same(a.student, ids.T) && a.savedAmount === 200) && archive.filter((a) => a.kind === "brand-totals").length === 1);
  check("archive holds no brand id, name or offer title", !JSON.stringify(archive).includes(String(ids.B)) && !JSON.stringify(archive).includes(NAMES.B) && !JSON.stringify(archive).includes("B: 20% off"));
  check("B's offers, promo codes, branches, campaigns, rewards, Shopify store gone", [Models.Offer, Models.PromoCode, Models.Branch, Models.Campaign, Models.Reward].every((Mdl) => rows(Mdl, (d) => same(d.brand, ids.B)).length === 0) && rows(Models.ShopifyStore).length === 0);
  const rActive = rows(Models.RewardRedemption, (x) => same(x._id, ids.rrActiveT))[0];
  const ledger = rows(Models.PointsLedger, (l) => same(l.user, ids.T) && l.reason === "reward_refund_brand_deleted");
  const pAfter = rows(Models.EngagementProfile, (p) => same(p.user, ids.T))[0];
  check("T's active reward code cancelled, 250 points refunded, lifetime unchanged", rActive.status === "cancelled" && pAfter.points.balance === pointsT + 250 && pAfter.points.lifetime === 500 && ledger.length === 1 && ledger[0].delta === 250 && ledger[0].balanceAfter === pointsT + 250, `${rActive.status} ${pAfter.points.balance}`);
  check("T's used reward code stays, brand removed", rows(Models.RewardRedemption, (x) => same(x._id, ids.rrUsedT) && x.status === "used" && x.rewardBrand == null).length === 1);
  check("Daily Drop link to B's offer cleared; T's unused welcome perk cleared", rows(Models.DailyDrop)[0].contentRef.id == null && pAfter.welcomePerk.brand == null && pAfter.welcomePerk.percent === 0);
  check("notifications to and from B gone", rows(Models.Notification, (n) => same(n.recipient, ids.B) || same(n.sender, ids.B)).length === 0);
  check("B's logo, offer and reward images removed from our Cloudinary; another cloud's link left alone", ["image:TDC_CompanyLogos/b-logo", "image:TDC_Offers/b-offer", "image:TDC_Offers/b-reward"].every((x) => destroyed.includes(x)) && !destroyed.some((x) => x.includes("not-ours")), destroyed.join(" "));
  check("B's id appears nowhere (except the audit log)", whereIs(ids.B).length === 0, whereIs(ids.B).join(" "));
  check("B's brand name, e-mail and Woo key appear nowhere", textAnywhere(NAMES.B).length === 0 && textAnywhere("bilal.owner@test.local").length === 0 && textAnywhere("ck_secret_b").length === 0, textAnywhere(NAMES.B).join());
  let audit = rows(Models.AdminAuditLog, (a) => same(a.targetId, ids.B))[0];
  check("audit: delete-account, admin id, role, done, counts, no pending links", audit?.action === "delete-account" && same(audit.adminId, ids.admin) && audit.role === "brand" && audit.status === "done" && audit.counts?.offers?.deleted === 2 && !audit.external?.pending, JSON.stringify(audit?.external || {}).slice(0, 120));
  check("audit holds no name, e-mail or link", !/Croissant|Bilal|@test\.local|cloudinary/.test(JSON.stringify(audit)));
  res = await call("DELETE", `/api/admin/users/${ids.B}`, { tok: ADMIN, body: { confirmName: NAMES.B } });
  check("deleting B again → 404, nothing changes", res.status === 404 && figs(await summary()) === figs(before.s) && rows(Models.RedemptionArchive).length === archive.length, res.status);

  console.log("── delete student S");
  const beforeS = { s: await summary(), travel: await travel() };
  const evUpBefore = rows(Models.Event, (e) => same(e._id, ids.evUp))[0].registeredCount;
  res = await call("GET", `/api/admin/users/${ids.S}/delete-preview`, { tok: ADMIN });
  check("preview S: name, claims, posts, resumes", res.status === 200 && res.json.name === NAMES.S && res.json.counts.posts === 1 && res.json.counts.claims === 1 && res.json.counts.resumes === 1, JSON.stringify(res.json.counts));
  res = await call("DELETE", `/api/admin/users/${ids.S}`, { tok: ADMIN, body: { confirmName: ` ${NAMES.S} ` } });
  check("admin deletes student S (name typed with spaces around) → 200", res.status === 200 && res.json?.role === "student", `${res.status} ${res.text.slice(0, 160)}`);
  const afterS = { s: await summary(), travel: await travel() };
  check("revenue figures unchanged (unique students too)", figs(afterS.s) === figs(beforeS.s), `${figs(beforeS.s)} → ${figs(afterS.s)}`);
  check("travel revenue unchanged", afterS.travel === beforeS.travel && afterS.travel === 50000, `${beforeS.travel} → ${afterS.travel}`);
  const oC = rows(Models.Offer, (o) => same(o._id, ids.oC1))[0];
  check("C's offer: S's redemption kept with a placeholder id, claim removed", oC.redemptions.length === 2 && !oC.redemptions.some((x) => same(x.student, ids.S)) && oC.claimedBy.length === 1 && same(oC.claimedBy[0], ids.T));
  check("S's unused promo code deleted (and unlinked from the offer), used one kept anonymised", rows(Models.PromoCode, (p) => same(p._id, ids.pcSActiveC)).length === 0 && !oC.promoCodesGenerated.some((x) => same(x, ids.pcSActiveC)) && rows(Models.PromoCode, (p) => same(p._id, ids.pcSUsedC) && !same(p.student, ids.S) && !same(p.usedBy, ids.S)).length === 1);
  res = await call("GET", `/api/promo-codes/${pcSUsedCode}`, { tok: BRAND_C });
  check("brand C looks up that used code → 200 (no crash on the missing student)", res.status === 200, `${res.status} ${res.text.slice(0, 100)}`);
  check("S's posts, confessions, stories gone", rows(Models.Post, (p) => same(p.author, ids.S)).length === 0 && rows(Models.Confession, (c) => same(c.authorId, ids.S)).length === 0 && rows(Models.Story, (s) => same(s.author, ids.S)).length === 0);
  const pT = rows(Models.Post, (p) => same(p._id, ids.pT))[0];
  check("T's post: S's like, favourite, view, comment gone; T's reply moved up; mention removed", pT.likes.length === 1 && pT.favorites.length === 0 && pT.viewedBy.length === 1 && pT.comments.length === 2 && pT.comments.find((c) => same(c._id, ids.c2)).parentComment == null && pT.comments.find((c) => same(c._id, ids.c2)).mentions.length === 0);
  check("T's poll: S's vote removed, count lowered", pT.poll[0].votes === 1 && pT.poll[0].votedBy.length === 1);
  const cfT = rows(Models.Confession, (c) => same(c._id, ids.cfT))[0];
  check("T's confession: like counter 2 → 1, S's comment gone, mention gone", cfT.likes === 1 && cfT.likedBy.length === 1 && cfT.comments.length === 1 && cfT.comments[0].mentions.length === 0);
  const stT = rows(Models.Story, (s) => same(s._id, ids.stT))[0];
  check("T's story: S's like, view and comment gone", stT.likes.length === 0 && stT.seenBy.length === 1 && stT.comments.length === 1);
  check("the S–T chat and its messages gone for both; T–U chat untouched", rows(Models.Conversation, (c) => same(c._id, ids.cv)).length === 0 && rows(Models.Message, (m) => same(m.conversationId, ids.cv)).length === 0 && rows(Models.Conversation, (c) => same(c._id, ids.cvTU)).length === 1);
  const tUser = rows(Models.User, (u) => same(u._id, ids.T))[0];
  check("T's connections, requests and referredBy cleaned", tUser.connections.length === 0 && tUser.sentRequests.length === 0 && tUser.receivedRequests.length === 0 && tUser.referredBy === undefined);
  check("block, notifications and social notifications cleaned", rows(Models.BlockedUser).length === 0 && rows(Models.Notification, (n) => (n.readBy || []).some((x) => same(x, ids.S))).length === 0 && rows(Models.SocialNotification, (n) => same(n.sender, ids.S)).length === 0);
  const repBy = rows(Models.Report, (x) => same(x._id, ids.repBy))[0], repAbout = rows(Models.Report, (x) => same(x._id, ids.repAbout))[0];
  check("report by S kept anonymised; report about S resolved 'account deleted'", repBy && !same(repBy.reporterId, ids.S) && repAbout.status === "resolved" && repAbout.adminNotes === "account deleted");
  check("listing, inquiries, skill offers and matches (string ids) gone", rows(Models.Listing, (l) => same(l._id, ids.lS)).length === 0 && rows(Models.Inquiry).length === 0 && rows(Models.SkillOffer).length === 0 && rows(Models.Match).length === 0);
  check("upcoming registration deleted, seat freed (2 → 1)", rows(Models.Registration, (x) => same(x.eventId, ids.evUp)).length === 0 && rows(Models.Event, (e) => same(e._id, ids.evUp))[0].registeredCount === evUpBefore - 1);
  const regPast = rows(Models.Registration, (x) => same(x._id, ids.regPast))[0];
  check("past registration kept without the person (payment status and amount kept)", regPast && regPast.studentName === "deleted user" && regPast.email === "deleted@tdc.invalid" && !regPast.answers && regPast.payment.status === "verified" && regPast.payment.amount === 500 && !regPast.payment.transactionId && !regPast.payment.receiptUrl);
  check("S's own event deleted, T told in the app", rows(Models.Event, (e) => same(e._id, ids.evS)).length === 0 && rows(Models.Notification, (n) => same(n.recipient, ids.T) && n.title === "event cancelled").length === 1);
  check("booking kept anonymised", rows(Models.Booking, (b) => b.packageName === "Hunza" && b.customerName === "deleted user" && !same(b.userId, ids.S)).length === 1);
  check("career, scholarship, engagement and push records gone", [Models.Resume, Models.SkillGapCache, Models.ProfessionalProfile, Models.JobApplication, Models.JobInteraction, Models.Application, Models.UserBadge, Models.DropReaction, Models.SavedItem, Models.Credential, Models.PartnerApplication, Models.PartnerPost, Models.ReferralClick, Models.PushLog, Models.SocialPushDaily, Models.OtpCode].every((Mdl) => rows(Mdl).length === 0));
  check("engagement events kept anonymised (metrics history)", rows(Models.EngagementEvent).length === 2);
  check("S's queued social push item removed, T's kept", rows(Models.SocialPushGroup)[0].items.length === 1 && same(rows(Models.SocialPushGroup)[0].items[0].authorId, ids.T));
  check("S's active reward code deleted, used one kept anonymised", rows(Models.RewardRedemption, (x) => same(x.reward, ids.rC)).length === 1 && rows(Models.RewardRedemption, (x) => same(x.reward, ids.rC))[0].status === "used");
  check("C campaign with S as partner ended", rows(Models.Campaign)[0].status === "ended");
  check("AI assistant chats of S gone, T's kept", fake.STORE.get("chat_sessions").length === 1 && fake.STORE.get("chat_messages").length === 1 && fake.STORE.get("conversation_memory").length === 1 && fake.STORE.get("chat_sessions")[0].sessionId === "sess-t");
  check("S's images and files removed (profile, ID, post, chat both sides, listing, receipt, resume files)", ["image:TDC_Profiles/sana", "image:TDC_Profiles/sana-id", "image:TDC_Posts/sana-post", "image:TDC_Chat/s-pic", "image:TDC_Chat/t-pic", "image:TDC_Listings/l", "image:TDC_Events/receipt", "image:TDC_Partner/shot", "raw:TDC_Resumes/sana-cv.pdf", "raw:TDC_Job_Resumes/sana-app.pdf"].every((x) => destroyed.includes(x)), destroyed.filter((x) => !x.includes("TDC_Offers") && !x.includes("Logos")).join(" "));
  check("S's id appears nowhere (except the audit log)", whereIs(ids.S).length === 0, whereIs(ids.S).join(" "));
  check("S's name and e-mail appear nowhere", textAnywhere(NAMES.S).length === 0 && textAnywhere("sana.malik@test.local").length === 0, [...textAnywhere(NAMES.S), ...textAnywhere("sana.malik@test.local")].join());

  console.log("── interrupted, then run again (no transaction here)");
  const BranchModel = Models.Branch;
  const realDeleteMany = BranchModel.deleteMany;
  let failOnce = true;
  BranchModel.deleteMany = function (...a) { if (failOnce) { failOnce = false; throw new Error("simulated network drop"); } return realDeleteMany.apply(this, a); };
  const beforeX = await summary();
  res = await call("DELETE", `/api/admin/users/${ids.X}`, { tok: ADMIN, body: { confirmName: "Xpress Burgers" } });
  audit = rows(Models.AdminAuditLog, (a) => same(a.targetId, ids.X))[0];
  check("a failure part-way → 500, audit 'failed', the account still there", res.status === 500 && audit?.status === "failed" && rows(Models.User, (u) => same(u._id, ids.X)).length === 1, `${res.status} ${audit?.status}`);
  check("totals still unchanged mid-way (archive already holds X)", figs(await summary()) === figs(beforeX), figs(await summary()));
  res = await call("DELETE", `/api/admin/users/${ids.X}`, { tok: ADMIN, body: { confirmName: "Xpress Burgers" } });
  BranchModel.deleteMany = realDeleteMany;
  const xAudits = rows(Models.AdminAuditLog, (a) => same(a.targetId, ids.X));
  check("run again → 200, same audit entry, done", res.status === 200 && xAudits.length === 1 && xAudits[0].status === "done", `${res.status} ${xAudits.length}`);
  check("nothing counted twice: one brand-totals row for X, totals unchanged", rows(Models.RedemptionArchive, (a) => a.kind === "brand-totals").length === 2 && rows(Models.RedemptionArchive, (a) => same(a.redemptionId, red.xT._id)).length === 1 && figs(await summary()) === figs(beforeX), figs(await summary()));
  check("X's id appears nowhere", whereIs(ids.X).length === 0, whereIs(ids.X).join(" "));

  console.log("── the app's delete my account");
  res = await call("DELETE", "/api/auth/delete-account", { tok: U });
  const uAudit = rows(Models.AdminAuditLog, (a) => same(a.targetId, ids.U))[0];
  check("student U deletes their own account → 200, same response as before", res.status === 200 && res.json?.success === true && res.json?.message === "Account deleted successfully", `${res.status} ${res.text}`);
  check("audit: self-delete, no admin id", uAudit?.action === "self-delete" && uAudit.adminId == null && uAudit.status === "done");
  check("U's post and their chat with T gone; U's id appears nowhere", rows(Models.Post, (p) => same(p.author, ids.U)).length === 0 && rows(Models.Conversation, (c) => same(c._id, ids.cvTU)).length === 0 && whereIs(ids.U).length === 0, whereIs(ids.U).join(" "));
  res = await call("DELETE", "/api/auth/delete-account", { tok: E });
  check("an employer's own delete still works the old way → 200", res.status === 200 && rows(Models.User, (u) => same(u._id, ids.E)).length === 0, res.status);
  res = await call("DELETE", "/api/auth/delete-account", { tok: "guest-token-2024" });
  check("guest token → not 200, nothing deleted", res.status !== 200, res.status);

  // ---------- leak scan ----------
  const leaky = responses.filter((x) => x.leaks.length);
  check(`leak scan: ${responses.length} responses, none expose hidden user fields`, leaky.length === 0, leaky.map((x) => `${x.url} ${x.leaks.join(",")}`).join(" | "));
  const delResponses = responses.filter((x) => x.method === "DELETE" && x.status === 200);
  check("deletion responses hold no names, e-mails or links", delResponses.every((x) => !/@test\.local|Sana|Croissant|Xpress|cloudinary/.test(x.text)), delResponses.map((x) => x.url).join());

  server.close();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
