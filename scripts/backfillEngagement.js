// scripts/backfillEngagement.js
// Idempotent. Run: node scripts/backfillEngagement.js [--dry]
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const User = require('../models/User');
const Offer = require('../models/Offer');
const PromoCode = require('../models/PromoCode');
const Resume = require('../models/Resume');
const JobApplication = require('../models/JobApplication');
const Post = require('../models/Post');
const Confession = require('../models/Confession');
const Registration = require('../models/Registration');
const Application = require('../models/Application');
const Listing = require('../models/Listing');
const SkillOffer = require('../models/SkillOffer');
const Booking = require('../models/Booking');
const EngagementProfile = require('../models/EngagementProfile');
const { ensureProfile } = require('../services/engagement');
const { award } = require('../services/engagement/points');
const { grant } = require('../services/engagement/badges');
const { addDays, dayKey } = require('../utils/karachiTime');

const DRY = process.argv.includes('--dry');

async function main() {
  await connectDB();
  console.log(`🚀 Backfilling engagement profiles${DRY ? ' (DRY RUN)' : ''}...`);

  const students = await User.find({ role: 'student' }).select('_id createdAt').lean();
  console.log(`Found ${students.length} students.`);

  let processed = 0;

  for (const s of students) {
    processed++;
    if (processed % 100 === 0) console.log(`  ...${processed}/${students.length}`);

    const profile = await EngagementProfile.findOne({ user: s._id });
    if (profile?.backfilledAt) continue; // already done

    await ensureProfile(s._id);

    // ---- Compute sorted cards ----
    const [redemptions, promos, resumes, apps, jobs, posts, confessions, events, scholarshipApps, listings, swaps, bookings] = await Promise.all([
      Offer.find({ 'redemptions.student': s._id }).select('_id redemptions').lean(),
      PromoCode.find({ student: s._id, status: 'used' }).select('_id').lean(),
      Resume.find({ user: s._id, isComplete: true }).select('_id').limit(1).lean(),
      JobApplication.find({ userId: s._id }).select('_id').limit(1).lean(),
      JobApplication.find({ userId: s._id }).select('_id').limit(1).lean(), // jobs
      Post.find({ author: s._id }).select('_id').limit(1).lean(),
      Confession.find({ authorId: s._id }).select('_id').limit(1).lean(),
      Registration.find({ userId: s._id }).select('_id').limit(1).lean(),
      Application.find({ userId: s._id }).select('_id').limit(1).lean(),
      Listing.find({ ownerId: s._id }).select('_id').limit(1).lean(),
      SkillOffer.find({ $or: [{ offerorId: String(s._id) }], status: 'accepted' }).select('_id').limit(1).lean(),
      Booking.find({ userId: s._id }).select('_id').limit(1).lean(),
    ]);

    const hasDiscount = redemptions.length > 0 || promos.length > 0;
    const hasResume = resumes.length > 0;
    const hasJobs = apps.length > 0 || jobs.length > 0;
    const hasSocial = posts.length > 0 || confessions.length > 0;
    const hasEvents = events.length > 0;
    const hasScholarship = scholarshipApps.length > 0;
    const hasSkill = listings.length > 0 || swaps.length > 0;
    const hasTravel = bookings.length > 0;

    const set = {};
    const now = new Date();
    if (hasDiscount)   set['sorted.discounts'] = now;
    if (hasResume)     set['sorted.resume'] = now;
    if (hasJobs)       set['sorted.jobs'] = now;
    if (hasSocial)     set['sorted.social'] = now;
    if (hasEvents)     set['sorted.events'] = now;
    if (hasScholarship) set['sorted.scholarship'] = now;
    if (hasSkill)      set['sorted.skillshare'] = now;
    if (hasTravel)     set['sorted.traveling'] = now;

    const sortedCount =
      (hasDiscount?1:0) + (hasResume?1:0) + (hasJobs?1:0) + (hasSocial?1:0) +
      (hasEvents?1:0) + (hasScholarship?1:0) + (hasSkill?1:0) + (hasTravel?1:0);

    set['sortedCount'] = sortedCount;
    if (sortedCount === 8) set['fullySortedAt'] = now;

    // ---- Total saved ----
    let totalSaved = 0;
    for (const o of redemptions) {
      for (const r of o.redemptions || []) {
        if (String(r.student) === String(s._id)) totalSaved += Number(r.savedAmount) || 0;
      }
    }
    set['stats.totalSaved'] = totalSaved;

    // ---- Silent points award ----
    // D2 default: yes, backfilled cards give points silently.
    if (!DRY) {
      await EngagementProfile.updateOne({ user: s._id }, { $set: set });

      const silentFeatures = [
        hasDiscount && 'discounts', hasResume && 'resume', hasJobs && 'jobs',
        hasSocial && 'social', hasEvents && 'events', hasScholarship && 'scholarship',
        hasSkill && 'skillshare', hasTravel && 'traveling',
      ].filter(Boolean);

      for (const feature of silentFeatures) {
        await award(s._id, 50, 'mission_sorted', 'feature', feature, `mission:${s._id}:${feature}`)
          .catch(() => {});
      }
      if (sortedCount === 8) {
        await award(s._id, 200, 'fully_sorted', 'user', String(s._id), `fully:${s._id}`).catch(() => {});
      }

      // OG badge
      const cutoff = new Date(process.env.OG_CUTOFF || '2026-12-31T23:59:59+05:00');
      if (new Date(s.createdAt) <= cutoff) {
        await grant(s._id, 'og').catch(() => {});
      }

      await EngagementProfile.updateOne(
        { user: s._id },
        { $set: { backfilledAt: new Date() } }
      );
    }
  }

  console.log(`✅ Backfill complete. Processed ${processed} students.`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Backfill error:', err);
  process.exit(1);
});