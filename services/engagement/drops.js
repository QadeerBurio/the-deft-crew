// services/engagement/drops.js
const DailyDrop = require('../../models/DailyDrop');
const DropReaction = require('../../models/DropReaction');
const { dayKey } = require('../../utils/karachiTime');

async function todayDrop() {
  return DailyDrop.findOne({ dayKey: dayKey(), status: 'live' }).lean();
}

async function react(userId, dayKeyStr, choice) {
  const drop = await DailyDrop.findOne({ dayKey: dayKeyStr });
  if (!drop) throw new Error('drop_not_found');
  if (drop.status !== 'live') throw new Error('drop_not_live');

  // Options are matched case/space-insensitively so the stored choice
  // always equals one of the drop's options (counts stay correct)
  const opts = drop.action?.options || [];
  if (opts.length) {
    const want = String(choice).trim().toLowerCase();
    const match = opts.find((o) => String(o).trim().toLowerCase() === want);
    if (!match) throw new Error('invalid_choice');
    choice = match;
  }

  try {
    await DropReaction.create({ drop: drop._id, user: userId, choice });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }

  const myChoice =
    (await DropReaction.findOne({ drop: drop._id, user: userId }).lean())?.choice || null;

  const counts = {};
  for (const opt of drop.action?.options || []) counts[opt] = 0;
  const agg = await DropReaction.aggregate([
    { $match: { drop: drop._id } },
    { $group: { _id: '$choice', n: { $sum: 1 } } },
  ]);
  for (const row of agg) counts[row._id] = row.n;

  return { drop, myChoice, counts };
}

// ────────────────────────────────────────────
// Target resolver: where tapping the drop takes the student.
// Route names must match the app's navigators exactly:
//   Career, Exchange, Events, OfferScreen, Brands, FeedScreen (HomeStack)
//   Dashboard → ListingDetail (SkillShare stack, nested)
// The "open*" params make each screen open that exact item.
// ────────────────────────────────────────────
const TYPE_FALLBACK = {
  internship: { kind: 'job', route: 'Career', params: {} },
  brand: { kind: 'brand', route: 'Brands', params: {} },
  event: { kind: 'event', route: 'Events', params: {} },
  scholarship: { kind: 'scholarship', route: 'Exchange', params: {} },
  confession: { kind: 'confession', route: 'FeedScreen', params: { tab: 'Confession' } },
  best_confession: { kind: 'confession', route: 'FeedScreen', params: { tab: 'Confession' } },
  listing: { kind: 'listing', route: 'Dashboard', params: {} },
};

// Sync version (no DB). Brand targets without a known brandId open Brands.
function resolveTarget(contentRef, dropType = null, brandId = null) {
  if (!contentRef || !contentRef.kind || !contentRef.id) {
    return TYPE_FALLBACK[dropType] || null;
  }
  const id = String(contentRef.id);

  switch (contentRef.kind) {
    case 'internship':
    case 'job':
      return { kind: 'job', route: 'Career', params: { openJobId: id, jobId: id } };
    case 'scholarship':
      return { kind: 'scholarship', route: 'Exchange', params: { openProgramId: id, programId: id } };
    case 'event':
      return { kind: 'event', route: 'Events', params: { openEventId: id, eventId: id } };
    case 'brand':
    case 'offer':
      return brandId
        ? {
            kind: 'brand',
            route: 'OfferScreen',
            params: { brand: { _id: String(brandId) }, offerId: id },
          }
        : { kind: 'brand', route: 'Brands', params: { offerId: id } };
    case 'confession':
      return { kind: 'confession', route: 'FeedScreen', params: { tab: 'Confession', postId: id } };
    case 'listing':
      return {
        kind: 'listing',
        route: 'Dashboard',
        params: { screen: 'ListingDetail', params: { id, listingId: id } },
      };
    default:
      return TYPE_FALLBACK[dropType] || null;
  }
}

// Async version: for brand drops, contentRef.id can be an OFFER id or a BRAND id.
// Looks up the brand so the app can open OfferScreen directly.
async function resolveTargetAsync(contentRef, dropType = null) {
  if (contentRef?.id && (contentRef.kind === 'brand' || contentRef.kind === 'offer')) {
    try {
      const Offer = require('../../models/Offer');
      const offer = await Offer.findById(contentRef.id).select('brand').lean();
      if (offer?.brand) return resolveTarget(contentRef, dropType, offer.brand);
      const User = require('../../models/User');
      const brand = await User.findOne({ _id: contentRef.id, role: 'brand' }).select('_id').lean();
      if (brand) return resolveTarget(contentRef, dropType, brand._id);
    } catch (e) {}
  }
  return resolveTarget(contentRef, dropType);
}

function toDTO(drop, myChoice = null, counts = null, target = undefined) {
  if (!drop) return null;
  return {
    dayKey: drop.dayKey,
    type: drop.type,
    title: drop.title,
    body: drop.body,
    image: drop.image,
    mood: drop.mood,
    action: {
      kind: drop.action?.kind,
      options: drop.action?.options || [],
    },
    myChoice,
    counts: counts || undefined,
    target: target !== undefined ? target : resolveTarget(drop.contentRef, drop.type),
  };
}

// Full drop for one student: their vote, live counts and the target
async function dropForUser(drop, userId) {
  if (!drop) return null;
  const counts = {};
  for (const opt of drop.action?.options || []) counts[opt] = 0;
  const [mine, agg, target] = await Promise.all([
    userId ? DropReaction.findOne({ drop: drop._id, user: userId }).lean() : null,
    DropReaction.aggregate([
      { $match: { drop: drop._id } },
      { $group: { _id: '$choice', n: { $sum: 1 } } },
    ]),
    resolveTargetAsync(drop.contentRef, drop.type),
  ]);
  for (const row of agg) counts[row._id] = row.n;
  return toDTO(drop, mine?.choice || null, counts, target);
}

module.exports = { todayDrop, react, toDTO, resolveTarget, resolveTargetAsync, dropForUser };