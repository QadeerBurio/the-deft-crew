// services/accountDeletion.js
// Permanently deletes a brand or student account and everything that points to it.
// Used by DELETE /api/admin/users/:id (an admin) and DELETE /api/auth/delete-account (the user).
//
//   1. an AdminAuditLog entry is written first (status "running"), outside the transaction, so a
//      failed or interrupted deletion can be found and run again with the same deletionId;
//   2. read only: collect the image and file links to remove later (kept in the audit entry until then);
//   3. one MongoDB transaction: delete, anonymise or update every collection below. Where the database
//      can't run transactions (tests, a standalone server) the same steps run without one; every step
//      matches by id, so running it again finishes what is left and changes nothing else;
//   4. after the commit, best-effort: Cloudinary images and files, the AI assistant's chat history, offer
//      caches. Results are recorded in the audit entry.
//
// Revenue and savings figures don't change: a deleted brand's redemptions go to RedemptionArchive (with
// the student, without the brand), a deleted student's redemptions, used promo codes, bookings and past
// event registrations stay with a random placeholder id instead of theirs (new per deletion, stored
// nowhere), so totals and unique-student counts stay the same and nothing leads back to the person.
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const AdminAuditLog = require("../models/AdminAuditLog");
const RedemptionArchive = require("../models/RedemptionArchive");
const Offer = require("../models/Offer");
const PromoCode = require("../models/PromoCode");
const Branch = require("../models/Branch");
const Campaign = require("../models/Campaign");
const Reward = require("../models/Reward");
const RewardRedemption = require("../models/RewardRedemption");
const ShopifyStore = require("../models/ShopifyStore");
const DailyDrop = require("../models/DailyDrop");
const EngagementProfile = require("../models/EngagementProfile");
const EngagementEvent = require("../models/EngagementEvent");
const PointsLedger = require("../models/PointsLedger");
const UserBadge = require("../models/UserBadge");
const DropReaction = require("../models/DropReaction");
const SavedItem = require("../models/SavedItem");
const Credential = require("../models/Credential");
const PartnerApplication = require("../models/PartnerApplication");
const PartnerPost = require("../models/PartnerPost");
const ReferralClick = require("../models/ReferralClick");
const Post = require("../models/Post");
const Confession = require("../models/Confession");
const Story = require("../models/Story");
const { Message, Conversation } = require("../models/Chat");
const Notification = require("../models/Notification");
const SocialNotification = require("../models/SocialNotification");
const BlockedUser = require("../models/BlockedUser");
const Report = require("../models/Report");
const Listing = require("../models/Listing");
const Inquiry = require("../models/Inquiry");
const SkillOffer = require("../models/SkillOffer");
const Match = require("../models/Match");
const Resume = require("../models/Resume");
const SkillGapCache = require("../models/SkillGapCache");
const ProfessionalProfile = require("../models/ProfessionalProfile");
const JobApplication = require("../models/JobApplication");
const JobInteraction = require("../models/JobInteraction");
const Application = require("../models/Application");
const { Event, Registration, EventNotification } = require("../models/Event");
const Booking = require("../models/Booking");
const PushLog = require("../models/PushLog");
const SocialPushDaily = require("../models/SocialPushDaily");
const SocialPushGroup = require("../models/SocialPushGroup");
const OtpCode = require("../models/OtpCode");
const { brandFigures, totalsOnly } = require("./brandRevenue");

const SUPPORTED_ROLES = new Set(["student", "brand"]);
const AI_DB_NAME = () => process.env.AI_DB_NAME || "The_deft_crew_Ai_assistant";
const DELETED_NAME = "deleted user";
const DELETED_EMAIL = "deleted@tdc.invalid";

class DeletionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// the name an admin must type to confirm: what the admin screens show for this account
const displayName = (u) => String((u.role === "brand" ? u.brandName || u.name : u.name) || "").trim();

// ---------- images and files ----------
// Cloudinary links anywhere in a document: https://res.cloudinary.com/<cloud>/<image|video|raw>/upload/...
const CLOUD_URL = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video|raw)\/upload\/(.+)$/;
function cloudLinks(value, out = new Set()) {
  if (typeof value === "string") {
    if (CLOUD_URL.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => cloudLinks(v, out));
  } else if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId)) {
    Object.values(value).forEach((v) => cloudLinks(v, out));
  }
  return out;
}
// link -> { cloud, resourceType, publicId }: transformations and the version are dropped; images and
// videos lose the extension, raw files keep it (that is how Cloudinary names them)
function parseCloudLink(url) {
  const m = String(url).split(/[?#]/)[0].match(CLOUD_URL);
  if (!m) return null;
  const [, cloud, resourceType, rest] = m;
  const parts = rest.split("/");
  while (parts.length > 1 && (/,/.test(parts[0]) || /^[a-z]{1,3}_[^/]*$/.test(parts[0]))) parts.shift(); // transformations
  if (parts.length > 1 && /^v\d+$/.test(parts[0])) parts.shift(); // version
  let publicId = decodeURIComponent(parts.join("/"));
  if (resourceType !== "raw") publicId = publicId.replace(/\.[a-z0-9]{2,5}$/i, "");
  return publicId ? { cloud, resourceType, publicId } : null;
}

// ---------- transaction ----------
const noTransactions = (err) =>
  err && (err.code === 20 || err.codeName === "IllegalOperation" || /Transaction numbers are only allowed|replica set|does not support (sessions|transactions)/i.test(err.message || ""));

async function withTransaction(work) {
  const conn = mongoose.connection;
  if (conn.readyState !== 1) return { transaction: false, result: await work(null) };
  try {
    let result;
    await conn.transaction(async (session) => {
      result = await work(session);
    });
    return { transaction: true, result };
  } catch (err) {
    if (!noTransactions(err)) throw err;
    return { transaction: false, result: await work(null) };
  }
}

// ---------- the database steps ----------
async function deleteInDatabase({ id, role, deletionId, ghost, session }) {
  const o = { session };
  const q = (query) => query.session(session).lean();
  const sid = String(id);
  const counts = {};
  const add = (coll, key, n) => {
    if (!n) return;
    counts[coll] = counts[coll] || {};
    counts[coll][key] = (counts[coll][key] || 0) + n;
  };
  const del = async (Model, filter) => {
    const r = await Model.deleteMany(filter, o);
    add(Model.collection.collectionName, "deleted", r.deletedCount || 0);
    return r.deletedCount || 0;
  };
  const upd = async (Model, filter, update, key = "updated") => {
    const r = await Model.updateMany(filter, update, o);
    add(Model.collection.collectionName, key, r.modifiedCount || 0);
    return r.modifiedCount || 0;
  };
  const isMe = (v) => v != null && String(v._id || v) === sid;
  const now = new Date();

  // ── brand: offers, revenue archive, promo codes, branches, campaigns, rewards, Shopify ──
  if (role === "brand") {
    const offers = await q(Offer.find({ brand: id }));
    const offerIds = offers.map((x) => x._id);
    const usedPromos = await q(PromoCode.find({ brand: id, status: "used" }));

    // the figures the revenue page showed for this brand, kept without the brand (once per deletion)
    await RedemptionArchive.updateOne(
      { deletionId, kind: "brand-totals" },
      { $setOnInsert: { totals: totalsOnly(brandFigures(offers, usedPromos)), createdAt: now } },
      { upsert: true, session }
    );
    add("redemptionarchives", "brandTotals", 1);
    // every redemption, with the student who made it: their savings and history stay right.
    // One read and one insert (a big brand has thousands); rows archived by an earlier run are skipped.
    const all = offers.flatMap((offer) => (offer.redemptions || []).filter((r) => r?._id).map((r) => ({ offer, r })));
    const alreadyArchived = new Set((await q(RedemptionArchive.find({ kind: "redemption", redemptionId: { $in: all.map((x) => x.r._id) } }).select("redemptionId"))).map((x) => String(x.redemptionId)));
    const rowsToAdd = all
      .filter(({ r }) => !alreadyArchived.has(String(r._id)))
      .map(({ offer, r }) => ({ kind: "redemption", deletionId, redemptionId: r._id, offerId: offer._id, student: r.student || undefined, billAmount: r.billAmount || 0, savedAmount: r.savedAmount || 0, redeemedAt: r.redeemedAt || now, createdAt: now }));
    if (rowsToAdd.length) await RedemptionArchive.insertMany(rowsToAdd, o);
    add("redemptionarchives", "redemptions", rowsToAdd.length);
    await upd(DailyDrop, { "contentRef.id": { $in: offerIds } }, { $set: { "contentRef.kind": null, "contentRef.id": null } });
    await del(Offer, { brand: id });

    const activePromos = await PromoCode.countDocuments({ brand: id, status: "active", externalProvider: { $in: ["shopify", "woocommerce"] } }).session(session);
    add("promocodes", "activeOnBrandStore", activePromos); // no coupon id is stored, so those stay on the brand's own store
    await del(PromoCode, { brand: id });
    await del(Branch, { brand: id });
    await del(Campaign, { brand: id });
    await del(ShopifyStore, { brandId: id });

    // rewards: active codes are cancelled and their points refunded; used ones stay, without the brand
    const rewards = await q(Reward.find({ brand: id }).select("_id"));
    const rewardIds = rewards.map((x) => x._id);
    const brandCodes = { $or: [{ rewardBrand: id }, { reward: { $in: rewardIds } }, { "snapshot.brand": id }] };
    const active = await q(RewardRedemption.find({ $and: [brandCodes, { status: "active" }] }));
    for (const code of active) {
      const done = await RewardRedemption.updateOne({ _id: code._id, status: "active" }, { $set: { status: "cancelled", cancelledAt: now, note: "brand account deleted" } }, o);
      if (!done.modifiedCount) continue;
      add("rewardredemptions", "cancelled", 1);
      const points = Math.max(0, Number(code.costPoints) || 0);
      if (!points) continue;
      await EngagementProfile.updateOne({ user: code.user }, { $inc: { "points.balance": points } }, o);
      const profile = await q(EngagementProfile.findOne({ user: code.user }).select("points.balance"));
      await PointsLedger.create([{
        user: code.user,
        delta: points,
        balanceAfter: profile?.points?.balance ?? points,
        reason: "reward_refund_brand_deleted",
        actorRole: "system",
        refType: "RewardRedemption",
        refId: String(code._id),
        idemKey: `refund:brand-deleted:${code._id}`,
        dedupeKey: `refund:brand-deleted:${code._id}`,
      }], o);
      add("pointsledgers", "refunds", 1);
      add("pointsledgers", "pointsRefunded", points);
    }
    await upd(RewardRedemption, { rewardBrand: id }, { $set: { rewardBrand: null } }, "anonymised");
    await upd(RewardRedemption, { "snapshot.brand": id }, { $set: { "snapshot.brand": null } }, "anonymised");
    await del(Reward, { brand: id });

    // a welcome perk from this brand: cleared if unused, brand removed if used
    await upd(EngagementProfile, { "welcomePerk.brand": id, "welcomePerk.usedAt": null }, { $set: { "welcomePerk.brand": null, "welcomePerk.campaign": null, "welcomePerk.percent": 0 } });
    await upd(EngagementProfile, { "welcomePerk.brand": id }, { $set: { "welcomePerk.brand": null } });
  }

  // ── student: claims, redemptions, promo codes, bookings (anonymised: totals stay) ──
  if (role === "student") {
    await upd(Offer, { claimedBy: id }, { $pull: { claimedBy: id } });
    const redeemed = await q(Offer.find({ "redemptions.student": id }).select("redemptions"));
    for (const offer of redeemed) {
      const redemptions = offer.redemptions.map((r) => (isMe(r.student) ? { ...r, student: ghost } : r));
      await Offer.updateOne({ _id: offer._id }, { $set: { redemptions } }, o);
      add("offers", "redemptionsAnonymised", offer.redemptions.filter((r) => isMe(r.student)).length);
    }
    const unused = await q(PromoCode.find({ student: id, status: "active" }).select("_id externalProvider"));
    add("promocodes", "activeOnBrandStore", unused.filter((x) => x.externalProvider === "shopify" || x.externalProvider === "woocommerce").length);
    const unusedIds = unused.map((x) => x._id);
    await upd(Offer, { promoCodesGenerated: { $in: unusedIds } }, { $pull: { promoCodesGenerated: { $in: unusedIds } } });
    await del(PromoCode, { _id: { $in: unusedIds } });
    await upd(PromoCode, { student: id }, { $set: { student: ghost } }, "anonymised");
    await upd(PromoCode, { usedBy: id }, { $set: { usedBy: ghost } }, "anonymised");
    await upd(RedemptionArchive, { student: id }, { $set: { student: ghost } }, "anonymised"); // their redemptions at brands deleted earlier
    await upd(Booking, { userId: id }, { $set: { userId: ghost, customerName: DELETED_NAME, customerEmail: DELETED_EMAIL, customerPhone: "-", specialRequests: "" } }, "anonymised");
    // reward codes: active ones go, used ones stay for the brand's history
    await del(RewardRedemption, { user: id, status: "active" });
    await upd(RewardRedemption, { user: id }, { $set: { user: ghost } }, "anonymised");
    await upd(RewardRedemption, { usedBy: id }, { $set: { usedBy: ghost } }, "anonymised");
    // campaigns where they were the partner end
    await upd(Campaign, { partner: id, status: { $ne: "ended" } }, { $set: { status: "ended" } });
    await upd(Campaign, { partner: id }, { $set: { partner: ghost } }, "anonymised");
  }

  // ── their own content ──
  await del(Post, { author: id });
  await del(Confession, { authorId: id });
  await del(Story, { author: id });

  const listings = await q(Listing.find({ ownerId: id }).select("_id"));
  const listingIds = listings.map((x) => x._id);
  await del(Inquiry, { $or: [{ listingId: { $in: listingIds } }, { userId: sid }] });
  await del(SkillOffer, { $or: [{ listingId: { $in: listingIds } }, { offerorId: sid }] });
  await del(Match, { $or: [{ listingId: { $in: listingIds } }, { listingOwnerId: sid }, { offerorId: sid }] });
  await del(Listing, { ownerId: id });

  // 1:1 chats are deleted for both people (media after the commit)
  const convs = await q(Conversation.find({ participants: id }).select("_id"));
  const convIds = convs.map((x) => x._id);
  await del(Message, { $or: [{ conversationId: { $in: convIds } }, { sender: id }] });
  await del(Conversation, { _id: { $in: convIds } });

  // ── their marks on other people's content ──
  await upd(Post, { likes: id }, { $pull: { likes: id } });
  await upd(Post, { favorites: id }, { $pull: { favorites: id } });
  await upd(Post, { viewedBy: id }, { $pull: { viewedBy: id } });
  const touchedPosts = await q(Post.find({ $or: [{ "comments.user": id }, { "comments.mentions": id }, { "poll.votedBy": id }] }).select("comments poll"));
  for (const p of touchedPosts) {
    const { comments, removed } = withoutTheirComments(p.comments, isMe);
    const poll = (p.poll || []).map((opt) => {
      const mine = (opt.votedBy || []).filter(isMe).length;
      return mine ? { ...opt, votedBy: opt.votedBy.filter((v) => !isMe(v)), votes: Math.max(0, (opt.votes || 0) - mine) } : opt;
    });
    await Post.updateOne({ _id: p._id }, { $set: { comments, poll } }, o);
    add("posts", "commentsRemoved", removed);
  }
  const touchedConfessions = await q(Confession.find({ $or: [{ likedBy: id }, { "comments.user": id }, { "comments.mentions": id }] }).select("likes likedBy comments"));
  for (const c of touchedConfessions) {
    const mine = (c.likedBy || []).filter(isMe).length;
    const { comments, removed } = withoutTheirComments(c.comments, isMe);
    await Confession.updateOne({ _id: c._id }, { $set: { likedBy: (c.likedBy || []).filter((v) => !isMe(v)), likes: Math.max(0, (c.likes || 0) - mine), comments } }, o);
    add("confessions", "commentsRemoved", removed);
  }
  await upd(Story, { likes: id }, { $pull: { likes: id } });
  await upd(Story, { seenBy: id }, { $pull: { seenBy: id } });
  await upd(Story, { "comments.user": id }, { $pull: { comments: { user: id } } });

  // ── people, notifications, moderation ──
  await upd(User, { connections: id }, { $pull: { connections: id } });
  await upd(User, { sentRequests: id }, { $pull: { sentRequests: id } });
  await upd(User, { receivedRequests: id }, { $pull: { receivedRequests: id } });
  await upd(User, { referredBy: id }, { $unset: { referredBy: "" } });
  await del(BlockedUser, { $or: [{ userId: id }, { blockedUserId: id }] });
  await del(Notification, { $or: [{ recipient: id }, { sender: id }] });
  await upd(Notification, { readBy: id }, { $pull: { readBy: id } });
  await upd(Notification, { deletedBy: id }, { $pull: { deletedBy: id } });
  await del(SocialNotification, { $or: [{ recipient: id }, { sender: id }] });
  await upd(SocialNotification, { readBy: id }, { $pull: { readBy: id } });
  await upd(Report, { reporterId: id }, { $set: { reporterId: ghost } }, "anonymised");
  await upd(Report, { reportedUserId: id, status: { $in: ["pending", "under_review"] } }, { $set: { status: "resolved", adminNotes: "account deleted", resolvedAt: now } });
  await upd(Report, { reportedUserId: id }, { $set: { reportedUserId: ghost } }, "anonymised");

  // ── events: registrations (upcoming ones free their seat, past ones stay without the person), events they created ──
  const regs = await q(Registration.find({ userId: id }).select("_id eventId seats"));
  const regEvents = await q(Event.find({ _id: { $in: regs.map((r) => r.eventId) } }).select("_id parsedDate expiredAt"));
  const isUpcoming = (ev) => !!ev && !ev.expiredAt && (!ev.parsedDate || new Date(ev.parsedDate) >= now);
  const eventsById = new Map(regEvents.map((e) => [String(e._id), e]));
  for (const r of regs) {
    if (isUpcoming(eventsById.get(String(r.eventId))) || !eventsById.has(String(r.eventId))) {
      await Registration.deleteOne({ _id: r._id }, o);
      add("registrations", "deleted", 1);
      if (r.seats > 0) await Event.updateOne({ _id: r.eventId, registeredCount: { $gte: r.seats } }, { $inc: { registeredCount: -r.seats } }, o);
    } else {
      await Registration.updateOne({ _id: r._id }, { $set: { userId: ghost, studentName: DELETED_NAME, userName: "", email: DELETED_EMAIL, whatsapp: "-", studentId: "Not provided", university: "" }, $unset: { answers: "", "payment.transactionId": "", "payment.receiptUrl": "" } }, o);
      add("registrations", "anonymised", 1);
    }
  }
  const ownEvents = await q(Event.find({ creator: id }).select("_id title"));
  const ownEventIds = ownEvents.map((x) => x._id);
  if (ownEventIds.length) {
    // the people registered hear about it in the app (no push from inside the transaction)
    const affected = await q(Registration.find({ eventId: { $in: ownEventIds } }).select("eventId userId"));
    const titles = new Map(ownEvents.map((e) => [String(e._id), e.title || "an event"]));
    const notes = affected
      .filter((r) => r.userId && !isMe(r.userId))
      .map((r) => ({ recipient: r.userId, title: "event cancelled", description: `"${titles.get(String(r.eventId))}" was cancelled.`, type: "Event", createdAt: now }));
    if (notes.length) {
      await Notification.insertMany(notes, o);
      add("notifications", "eventCancelledNotices", notes.length);
    }
    await del(Registration, { eventId: { $in: ownEventIds } });
    await del(EventNotification, { eventId: { $in: ownEventIds } });
    await del(Event, { _id: { $in: ownEventIds } });
  }
  await del(EventNotification, { $or: [{ registrantId: id }, { creatorId: id }] });

  // ── career, scholarships ──
  const resumes = await q(Resume.find({ user: id }).select("_id"));
  await del(SkillGapCache, { resumeId: { $in: resumes.map((x) => x._id) } });
  await del(Resume, { user: id });
  await del(ProfessionalProfile, { userId: id });
  await del(JobApplication, { userId: id });
  await del(JobInteraction, { userId: id });
  await del(Application, { userId: id });

  // ── engagement, partners, pushes ──
  await del(EngagementProfile, { user: id });
  await upd(EngagementEvent, { user: id }, { $set: { user: ghost } }, "anonymised"); // keeps the admin metrics history
  await del(PointsLedger, { user: id });
  await del(UserBadge, { user: id });
  await del(DropReaction, { user: id });
  await del(SavedItem, { user: id });
  await del(Credential, { user: id });
  await del(PartnerApplication, { user: id });
  await del(PartnerPost, { user: id });
  await del(ReferralClick, { referrer: id });
  await del(PushLog, { user: id });
  await del(SocialPushDaily, { user: id });
  await upd(SocialPushGroup, { "items.authorId": id }, { $pull: { items: { authorId: id } } });
  await del(OtpCode, { user: id });

  // ── the account itself ──
  await del(User, { _id: id });
  return counts;
}

// drop their comments; replies other people wrote to them move up a level; their mentions go
function withoutTheirComments(list = [], isMe) {
  const theirs = new Set(list.filter((c) => isMe(c.user)).map((c) => String(c._id)));
  const comments = list
    .filter((c) => !isMe(c.user))
    .map((c) => ({
      ...c,
      parentComment: c.parentComment && theirs.has(String(c.parentComment)) ? null : c.parentComment ?? null,
      mentions: (c.mentions || []).filter((m) => !isMe(m)),
    }));
  return { comments, removed: theirs.size };
}

// every image and file link that goes with the account (read before anything is deleted)
async function collectMedia(id, role) {
  const sid = String(id);
  const links = new Set();
  const raw = new Set();
  const grab = (docs) => docs.forEach((d) => cloudLinks(d, links));
  const user = await User.findById(id).select("+idCardFront +idCardBack +livePicture profileImage avatar logo paymentReceipt").lean();
  if (user) grab([user]);
  if (role === "brand") {
    grab(await Offer.find({ brand: id }).select("image").lean());
    grab(await Reward.find({ brand: id }).select("image").lean());
  }
  grab(await Post.find({ author: id }).select("image").lean());
  grab(await Confession.find({ authorId: id }).select("image").lean());
  grab(await Story.find({ author: id }).select("image").lean());
  grab(await Listing.find({ ownerId: id }).select("attachments").lean());
  grab(await PartnerPost.find({ user: id }).select("screenshotUrl").lean());
  grab(await Event.find({ creator: id }).select("image").lean());
  grab(await Registration.find({ userId: id }).select("payment").lean());
  const convIds = (await Conversation.find({ participants: id }).select("_id").lean()).map((x) => x._id);
  grab(await Message.find({ $or: [{ conversationId: { $in: convIds } }, { sender: id }] }).select("mediaUrl").lean());
  for (const r of await Resume.find({ user: id }).select("uploadedResume").lean()) {
    if (r.uploadedResume?.publicId) raw.add(r.uploadedResume.publicId);
    cloudLinks(r.uploadedResume?.fileUrl, links);
  }
  for (const a of await JobApplication.find({ userId: id }).select("resumeUrl resumePublicId").lean()) {
    if (a.resumePublicId) raw.add(a.resumePublicId);
    cloudLinks(a.resumeUrl, links);
  }
  return { links: [...links], raw: [...raw], aiUserId: sid };
}

// ---------- after the commit ----------
async function deleteMedia(pending) {
  const result = { deleted: 0, notFound: 0, failed: 0, skipped: 0 };
  const links = pending?.links || [];
  const raw = pending?.raw || [];
  if (!links.length && !raw.length) return result;
  let cloudinary;
  try {
    ({ cloudinary } = require("../config/cloudinary"));
  } catch {
    cloudinary = null;
  }
  const ours = cloudinary?.config?.()?.cloud_name;
  if (!cloudinary || !ours) {
    result.skipped = links.length + raw.length;
    return result;
  }
  const targets = [];
  for (const url of links) {
    const p = parseCloudLink(url);
    if (!p || p.cloud !== ours) { result.skipped += 1; continue; } // never someone else's cloud
    targets.push(p);
  }
  for (const publicId of raw) targets.push({ resourceType: "raw", publicId });
  const seen = new Set();
  for (const t of targets) {
    const key = `${t.resourceType}:${t.publicId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const r = await cloudinary.uploader.destroy(t.publicId, { resource_type: t.resourceType, invalidate: true });
      if (r?.result === "ok") result.deleted += 1;
      else if (r?.result === "not found") result.notFound += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

// the AI assistant (chat-service) keeps its chats in its own database on the same cluster
async function deleteAiChats(userId) {
  try {
    const ai = mongoose.connection.useDb(AI_DB_NAME(), { useCache: true });
    const sessions = await ai.collection("chat_sessions").find({ userId: String(userId) }).project({ sessionId: 1 }).toArray();
    const ids = sessions.map((s) => s.sessionId).filter(Boolean);
    const messages = ids.length ? await ai.collection("chat_messages").deleteMany({ sessionId: { $in: ids } }) : { deletedCount: 0 };
    const memory = ids.length ? await ai.collection("conversation_memory").deleteMany({ sessionId: { $in: ids } }) : { deletedCount: 0 };
    const sess = await ai.collection("chat_sessions").deleteMany({ userId: String(userId) });
    return { sessions: sess.deletedCount || 0, messages: messages.deletedCount || 0, memory: memory.deletedCount || 0 };
  } catch {
    return { error: "could not reach the AI assistant's database" };
  }
}

async function clearCaches(id, role) {
  try {
    const { clearOfferCaches } = require("../utils/cache");
    await clearOfferCaches(role === "brand" ? { brandId: String(id) } : { userId: String(id) });
    return { cleared: true };
  } catch {
    return { cleared: false };
  }
}

// ---------- public ----------
async function loadTarget(userId) {
  if (!mongoose.Types.ObjectId.isValid(String(userId))) throw new DeletionError(400, "invalid account id");
  return User.findById(userId).select("_id role name brandName").lean();
}

// counts shown in the confirm dialog before anything is deleted
async function preview(userId) {
  const user = await loadTarget(userId);
  if (!user) throw new DeletionError(404, "account not found");
  const id = user._id;
  const c = (Model, filter) => Model.countDocuments(filter);
  const counts = {
    posts: await c(Post, { author: id }),
    confessions: await c(Confession, { authorId: id }),
    stories: await c(Story, { author: id }),
    conversations: await c(Conversation, { participants: id }),
    listings: await c(Listing, { ownerId: id }),
    notifications: await c(Notification, { recipient: id }),
    eventRegistrations: await c(Registration, { userId: id }),
    eventsCreated: await c(Event, { creator: id }),
  };
  if (user.role === "brand") {
    counts.offers = await c(Offer, { brand: id });
    counts.promoCodes = await c(PromoCode, { brand: id });
    counts.branches = await c(Branch, { brand: id });
    counts.campaigns = await c(Campaign, { brand: id });
    counts.rewards = await c(Reward, { brand: id });
    counts.activeRewardCodesRefunded = await c(RewardRedemption, { $or: [{ rewardBrand: id }, { "snapshot.brand": id }], status: "active" });
    counts.shopifyStores = await c(ShopifyStore, { brandId: id });
  } else {
    counts.claims = await c(Offer, { claimedBy: id });
    counts.redemptionsKeptAnonymous = await c(Offer, { "redemptions.student": id });
    counts.promoCodes = await c(PromoCode, { student: id });
    counts.resumes = await c(Resume, { user: id });
    counts.jobApplications = await c(JobApplication, { userId: id });
    counts.bookingsKeptAnonymous = await c(Booking, { userId: id });
  }
  for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  return { id: String(id), role: user.role, name: displayName(user), supported: SUPPORTED_ROLES.has(user.role), counts };
}

// actor: { type: "admin", adminId } or { type: "self" }; confirmName: required for admins
async function deleteAccount(userId, { actor, confirmName } = {}) {
  const user = await loadTarget(userId);
  const isAdminActor = actor?.type === "admin";
  if (isAdminActor && String(actor.adminId) === String(userId)) throw new DeletionError(400, "you can't delete your own account here");

  let audit;
  if (!user) {
    // already gone: finish an interrupted deletion, if there is one
    audit = await AdminAuditLog.findOne({ targetId: userId, status: { $in: ["running", "failed"] } }).sort({ startedAt: -1 });
    if (!audit) throw new DeletionError(404, "account not found");
  } else {
    if (user.role === "admin") throw new DeletionError(403, "admin accounts can't be deleted");
    if (!SUPPORTED_ROLES.has(user.role)) throw new DeletionError(400, "not supported yet");
    if (isAdminActor && String(confirmName || "").trim() !== displayName(user)) throw new DeletionError(400, "the name doesn't match");
    audit = await AdminAuditLog.findOne({ targetId: user._id, status: { $in: ["running", "failed"] } }).sort({ startedAt: -1 });
    if (!audit) {
      audit = await AdminAuditLog.create({
        action: isAdminActor ? "delete-account" : "self-delete",
        adminId: isAdminActor ? actor.adminId : null,
        targetId: user._id,
        role: user.role,
        deletionId: crypto.randomBytes(12).toString("hex"),
        status: "running",
      });
    }
  }
  const id = new mongoose.Types.ObjectId(String(userId));
  const role = audit.role;

  // links to remove after the commit; merged with any kept from an earlier, interrupted run
  const found = await collectMedia(id, role);
  const kept = audit.external?.pending || {};
  const pending = {
    links: [...new Set([...(kept.links || []), ...found.links])],
    raw: [...new Set([...(kept.raw || []), ...found.raw])],
  };
  await AdminAuditLog.updateOne({ _id: audit._id }, { $set: { status: "running", "external.pending": pending, error: "" } });

  let counts;
  let transaction = false;
  try {
    const ghost = new mongoose.Types.ObjectId(); // placeholder for anonymised rows, new per run, stored nowhere
    const out = await withTransaction((session) => deleteInDatabase({ id, role, deletionId: audit.deletionId, ghost, session }));
    counts = out.result;
    transaction = out.transaction;
  } catch (err) {
    await AdminAuditLog.updateOne({ _id: audit._id }, { $set: { status: "failed", error: String(err.message || err).slice(0, 300) } });
    throw new DeletionError(500, "the deletion stopped part-way; run it again to finish");
  }

  const external = {
    media: await deleteMedia(pending),
    aiChat: await deleteAiChats(id),
    caches: await clearCaches(id, role),
  };
  const previous = audit.counts && Object.keys(audit.counts).length ? audit.counts : null;
  await AdminAuditLog.updateOne(
    { _id: audit._id },
    { $set: { status: "done", counts: previous ? { ...previous, rerun: counts } : counts, external, transaction, finishedAt: new Date() } }
  );
  return { auditId: String(audit._id), role, transaction, counts, external };
}

module.exports = { deleteAccount, preview, DeletionError, SUPPORTED_ROLES, parseCloudLink, cloudLinks, displayName };
