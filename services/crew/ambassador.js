// services/crew/ambassador.js
// Plan P2 (flag ambassadorV2): the ambassador programme for students.
//   invitation(userId)       P2-1: may we invite this student now? (server decides; asked at most once, "not now" →
//                            once more after 30 days, "don't ask again" → never). Eligible: a verified student, account
//                            ≥ 7 days, not an ambassador or applicant, and a good moment in the last 48 h: a friend
//                            joined with their code and verified their e-mail; a 3rd+ deal claimed; level "starter"
//                            reached; or a confession of theirs (last 7 days) with 10+ likes
//   answer(userId, answer)   "more" | "not_now" | "never"
//   apply(user, body)        P2-3: the in-app application (one document per student; a rejected student may apply again
//                            after 30 days: the same document back to pending)
//   status(userId)           none | pending | approved | rejected, with dates and the reviewer's note
//   campusCount(user)        approved ambassadors at the student's university (by id; older ones by name)
//   hub(user)                P2-5: invites this week / month, rank among ambassadors this month, live campaigns,
//                            credentials
//   dailyCard(user)          P2-7: today's share card from one of their live campaigns, or null (nothing real to share)
const User = require("../../models/User");
const EngagementProfile = require("../../models/EngagementProfile");
const PartnerApplication = require("../../models/PartnerApplication");

const DAY = 24 * 3600e3;
const REAPPLY_DAYS = 30;
const PKT_MS = 5 * 3600e3;
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";

class CrewError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

function karachiWeekStart(now = new Date()) {
  const pkt = new Date(now.getTime() + PKT_MS);
  const day = pkt.getUTCDay() || 7; // Monday = 1
  return new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate() - (day - 1)) - PKT_MS);
}
function karachiMonthStart(now = new Date()) {
  const pkt = new Date(now.getTime() + PKT_MS);
  return new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), 1) - PKT_MS);
}

/** Friends who joined with this student's code and verified their e-mail, since a date */
async function verifiedReferrals(userId, since) {
  return User.countDocuments({ referredBy: userId, emailVerified: true, ...(since ? { createdAt: { $gte: since } } : {}) });
}

async function goodMoment(user, profile, now) {
  const since = new Date(now.getTime() - 2 * DAY);
  if (await User.exists({ referredBy: user._id, emailVerified: true, createdAt: { $gte: since } })) return "friend_joined";
  const PromoCode = require("../../models/PromoCode");
  const claims = await PromoCode.find({ student: user._id }).select("createdAt").sort({ createdAt: -1 }).limit(3).lean();
  if (claims.length >= 3 && claims[0].createdAt && new Date(claims[0].createdAt) >= since) return "deals_claimed";
  if ((profile?.level?.tiersIssued || []).includes("starter") && profile.level.reachedAt && new Date(profile.level.reachedAt) >= since) return "level_starter";
  const Confession = require("../../models/Confession");
  const liked = await Confession.find({ authorId: user._id, createdAt: { $gte: new Date(now.getTime() - 7 * DAY) } }).select("likes status").lean();
  if (liked.some((c) => (!c.status || c.status === "live") && (Array.isArray(c.likes) ? c.likes.length : Number(c.likes) || 0) >= 10)) return "confession_liked";
  return null;
}

/** P2-1. → { show: false, reason } or { show: true, moment } (and records that it was shown) */
async function invitation(userId, now = new Date()) {
  const user = await User.findById(userId).select("role status createdAt").lean();
  if (!user || user.role !== "student") return { show: false, reason: "not_student" };
  if (user.status !== "Verified") return { show: false, reason: "not_verified" };
  if (!user.createdAt || now - new Date(user.createdAt) < 7 * DAY) return { show: false, reason: "too_new" };
  const profile = await EngagementProfile.findOne({ user: userId }).select("partner ambassadorInvite level").lean();
  if (profile?.partner?.type && profile.partner.type !== "none") return { show: false, reason: "already_partner" };
  if (await PartnerApplication.exists({ user: userId })) return { show: false, reason: "already_applied" };
  const inv = profile?.ambassadorInvite || {};
  if (inv.answer === "never" || inv.answer === "more") return { show: false, reason: "answered" };
  if ((inv.asks || 0) >= 2) return { show: false, reason: "asked_twice" };
  if (inv.shownAt && now - new Date(inv.answeredAt || inv.shownAt) < 30 * DAY) return { show: false, reason: "asked_recently" };
  const moment = await goodMoment(user, profile, now);
  if (!moment) return { show: false, reason: "no_good_moment" };
  await EngagementProfile.updateOne({ user: userId }, { $set: { "ambassadorInvite.shownAt": now }, $inc: { "ambassadorInvite.asks": 1 }, $unset: { "ambassadorInvite.answer": "" } }, { upsert: true });
  return { show: true, moment };
}

async function answer(userId, ans, now = new Date()) {
  if (!["more", "not_now", "never"].includes(ans)) throw new CrewError(400, "BAD_ANSWER", "answer: more | not_now | never");
  await EngagementProfile.updateOne({ user: userId }, { $set: { "ambassadorInvite.answer": ans, "ambassadorInvite.answeredAt": now } }, { upsert: true });
  return { answer: ans };
}

const clean = (v, max) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanList = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => clean(x, max)).filter(Boolean).slice(0, n);

async function universityOf(user) {
  if (!user.university) return { id: null, name: clean(user.universityName, 120) };
  const U = require("../../models/University");
  const u = await U.findById(user.university).select("name").lean();
  return { id: u ? u._id : null, name: clean(u?.name || user.universityName, 120) };
}

/** P2-3: the application. body: { why, whyChips?, groups?, handle? } */
async function apply(userId, body = {}, now = new Date()) {
  const user = await User.findById(userId).select("role university universityName name").lean();
  if (!user || user.role !== "student") throw new CrewError(403, "STUDENTS_ONLY", "the ambassador programme is for students.");
  const whyChips = cleanList(body.whyChips, 6, 40);
  const why = clean(body.why, 600) || whyChips.join(", ");
  if (why.length < 3) throw new CrewError(400, "WHY_REQUIRED", "tell us why you (one line is enough).");
  const groups = cleanList(body.groups, 8, 60);
  const handle = clean(body.handle, 40).replace(/^@/, "");
  const uni = await universityOf(user);
  if (!uni.name) throw new CrewError(400, "UNIVERSITY_REQUIRED", "add your university to your profile first.");
  const existing = await PartnerApplication.findOne({ user: userId }).lean();
  if (existing && existing.status !== "rejected") throw new CrewError(409, "ALREADY_APPLIED", existing.status === "approved" ? "you're already a tdc ambassador." : "your application is in. we reply within 7 working days.");
  if (existing && existing.reviewedAt && now - new Date(existing.reviewedAt) < REAPPLY_DAYS * DAY) {
    throw new CrewError(409, "TOO_SOON", `you can apply again from ${new Date(new Date(existing.reviewedAt).getTime() + REAPPLY_DAYS * DAY).toISOString().slice(0, 10)}.`);
  }
  const doc = { university: uni.name, universityId: uni.id, why, whyChips, groups, handle, source: "app", status: "pending", appliedAt: now, reviewedBy: null, reviewedAt: null, reviewNote: "" };
  await PartnerApplication.updateOne({ user: userId }, { $set: doc, $setOnInsert: { user: userId } }, { upsert: true });
  return status(userId);
}

async function status(userId) {
  const a = await PartnerApplication.findOne({ user: userId }).lean();
  if (!a) {
    const p = await EngagementProfile.findOne({ user: userId }).select("partner").lean();
    if (p?.partner?.type === "ambassador") return { status: "approved", since: p.partner.since || null };
    return { status: "none" };
  }
  const out = { status: a.status, appliedAt: a.appliedAt || a.createdAt, reviewedAt: a.reviewedAt || null, reviewNote: a.reviewNote || "" };
  if (a.status === "rejected" && a.reviewedAt) out.canApplyAgainAt = new Date(new Date(a.reviewedAt).getTime() + REAPPLY_DAYS * DAY);
  return out;
}

/** Approved ambassadors at this student's university: by id, older ones by the name. null when unknown. */
async function campusCount(userId) {
  const user = await User.findById(userId).select("university universityName").lean();
  const uni = user ? await universityOf(user) : null;
  if (!uni || (!uni.id && !uni.name)) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const or = [];
  if (uni.id) or.push({ "partner.universityId": uni.id });
  if (uni.name) or.push({ "partner.university": { $regex: `^${esc(uni.name)}$`, $options: "i" } });
  const count = await EngagementProfile.countDocuments({ "partner.type": "ambassador", $or: or });
  return { count, university: uni.name };
}

async function isAmbassador(userId) {
  const p = await EngagementProfile.findOne({ user: userId }).select("partner").lean();
  return p?.partner?.type === "ambassador" ? p.partner : null;
}

/** P2-5 */
async function hub(userId, now = new Date()) {
  const partner = await isAmbassador(userId);
  if (!partner) throw new CrewError(403, "NOT_AMBASSADOR", "the dashboard is for approved ambassadors.");
  const monthStart = karachiMonthStart(now);
  const [week, month] = await Promise.all([verifiedReferrals(userId, karachiWeekStart(now)), verifiedReferrals(userId, monthStart)]);
  // rank this month among ambassadors, by verified friends
  const ambassadors = await EngagementProfile.find({ "partner.type": "ambassador" }).select("user").lean();
  const ids = ambassadors.map((p) => p.user);
  const counts = new Map(ids.map((id) => [String(id), 0]));
  const rows = await User.find({ referredBy: { $in: ids }, emailVerified: true, createdAt: { $gte: monthStart } }).select("referredBy").lean();
  for (const r of rows) counts.set(String(r.referredBy), (counts.get(String(r.referredBy)) || 0) + 1);
  const mine = counts.get(String(userId)) || 0;
  const rank = 1 + [...counts.values()].filter((n) => n > mine).length;
  const Campaign = require("../../models/Campaign");
  const camps = await Campaign.find({ partner: userId, status: "live", endsAt: { $gte: now } }).sort({ endsAt: 1 }).populate("brand", "brandName name").lean();
  const Credential = require("../../models/Credential");
  const creds = await Credential.find({ user: userId, status: { $in: ["issued", "revoked"] } }).sort({ issuedAt: -1 }).lean();
  return {
    since: partner.since || null, university: partner.university || "",
    invites: { week, month }, rank: { position: rank, of: ids.length, month: mine },
    campaigns: camps.map((c) => ({ id: String(c._id), name: c.name, brand: c.brand?.brandName || c.brand?.name || "", followerPercent: c.followerPercent, cap: c.cap ?? null, startsAt: c.startsAt, endsAt: c.endsAt })),
    credentials: creds.map((c) => ({ id: String(c._id), type: c.type, status: c.status, issuedAt: c.issuedAt, pdf: c.status === "issued" && require("./certificate").printable(c) })),
  };
}

/** P2-7: one of today's live campaigns to share, or null (nothing real to share) */
async function dailyCard(userId, now = new Date()) {
  if (!(await isAmbassador(userId))) return null;
  const Campaign = require("../../models/Campaign");
  const camps = await Campaign.find({ partner: userId, status: "live", startsAt: { $lte: now }, endsAt: { $gte: now } }).populate("brand", "brandName name").lean();
  if (!camps.length) return null;
  const pick = camps[Math.floor((now.getTime() / DAY)) % camps.length]; // a different one each day when there are several
  const brand = pick.brand?.brandName || pick.brand?.name || "";
  const me = await User.findById(userId).select("referralCode").lean();
  if (!brand || !(pick.followerPercent > 0)) return null;
  return { campaignId: String(pick._id), brand, followerPercent: pick.followerPercent, endsAt: pick.endsAt, code: me?.referralCode || null, line: `today: share ${brand}'s ${pick.followerPercent}% off with your campus group.` };
}

module.exports = { invitation, answer, apply, status, campusCount, hub, dailyCard, verifiedReferrals, karachiWeekStart, karachiMonthStart, isAmbassador, CrewError, firstName };
