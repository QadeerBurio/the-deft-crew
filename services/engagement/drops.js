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
// Target resolver — enriches DTO with route + params
// ────────────────────────────────────────────
function resolveTarget(contentRef) {
  if (!contentRef || !contentRef.kind || !contentRef.id) return null;
  const id = String(contentRef.id);

  switch (contentRef.kind) {
    case 'internship':
    case 'job':
      return { kind: 'job', route: 'Career', params: { jobId: id } };
    case 'scholarship':
      return { kind: 'scholarship', route: 'ExchangeScreen', params: { programId: id } };
    case 'event':
      return { kind: 'event', route: 'Events', params: { eventId: id } };
    case 'brand':
      return { kind: 'brand', route: 'Brands', params: { offerId: id } };
    case 'confession':
      return { kind: 'confession', route: 'Confession', params: { postId: id } };
    case 'listing':
      return { kind: 'listing', route: 'ListingDetail', params: { id } };
    default:
      return null;
  }
}

function toDTO(drop, myChoice = null, counts = null) {
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
    target: resolveTarget(drop.contentRef),
  };
}

module.exports = { todayDrop, react, toDTO, resolveTarget };