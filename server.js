// First: everything written to the logs is redacted (e-mails, phones, tokens, connection strings) and
// lines inside a request carry its id (utils/logSafety.js)
const logSafety = require("./utils/logSafety");
logSafety.install();

const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Tokens are signed and checked with JWT_SECRET. There is no fallback: refuse to start without it.
if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Add it to the environment (Railway variables) and restart.");
  process.exit(1);
}
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");
const dns = require("dns");
const path = require("path");
const axios = require("axios");

const connectDB = require("./config/db");

const app = express();
const server = http.createServer(app);

// every request gets an id: X-Request-Id response header, and [rid:<id>] on its log lines
app.use(logSafety.requestId());

const io = new Server(server, {
  cors: { origin: require("./config/corsOrigins").corsOptions.origin } // the website, the portal, the server itself (config/corsOrigins.js)
});

// Make io available to routes
app.set('io', io);

// Initialize Event Socket Broadcaster
const eventSocket = require("./socket/eventSocket");
eventSocket.init(io);

// ---------------- DNS CONFIG ----------------
dns.setServers(["1.1.1.1", "8.8.8.8"]);

// ---------------- MIDDLEWARE ----------------
app.use(cors(require("./config/corsOrigins").corsOptions)); // the website, the portal, the server itself; no Origin (the app, webhooks) allowed
app.use(express.json({
  limit: "5mb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
// gzip, except the AI chat / travel streams (middleware/compress.js)
app.use(require("./middleware/compress")());
// [perf] time + size of the most used GET routes (middleware/perfLog.js)
app.use(require("./middleware/perfLog")());

// Static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/r", require("./routes/publicResume.routes")); // P3d public resume page (gettdc.pk/r/<link> via the portal)
app.use("/c", require("./routes/publicConfession.routes")); // P4c shared confession page (gettdc.pk/c/<id> via the portal)
// Mood emoji images used as the picture in push notifications
// Mood images for push + admin. Looks in public/dots first, then uploads/dots.
app.use("/assets/dots",
  express.static(path.join(__dirname, "public", "dots"), { maxAge: "7d" }),
  express.static(path.join(__dirname, "uploads", "dots"), { maxAge: "7d" })
);

// ---------------- DATABASE ----------------
// Background jobs: each one can be switched off with JOB_<NAME>=off, all with BACKGROUND_JOBS=off, and
// in staging all are off unless switched on by name (config/featureFlags.js)
const { jobEnabled, describeJobs, describeFlags } = require("./config/featureFlags");
// one line per feature flag: rule types and counts only, never the ids (config/featureFlags.js)
for (const line of describeFlags()) console.log(line);
// admin access to features per account (services/featureAccess.js): API requests wait for the first load (at most
// 5 s), then it's re-read every 30 s; prints "[flags] admin access: <flag> <count>, …" (counts only)
const featureAccess = require("./services/featureAccess");
featureAccess.expectLoad();

connectDB().then(() => {
  // after admin access has loaded: a Surprise Box pilot set up only from the admin portal still gets the
  // "pickup-code secret missing" warning
  featureAccess.start().then(() => require("./routes/surplus.routes").warnIfNoPickupSecret("after admin access loaded")).catch(() => {});
  console.log(describeJobs());

  // Automated event ingestion (hourly, plus a pass 10s after start)
  if (jobEnabled("eventIngestion")) {
    const eventScheduler = require("./services/events/scheduler");
    eventScheduler.initialize();
  }

  // social pushes (new posts / confessions / listings): sends the groups that are due, every minute
  if (jobEnabled("socialPush")) {
    require("./services/socialPush").startScheduler();
  }

  // push receipts every 30 minutes (JOB_PUSH_RECEIPTS): delivered / failed on PushLog rows (the engagement gateway's
  // and every tracked push), dead tokens removed; the first pass 2 minutes after start
  if (jobEnabled("pushReceipts")) {
    require("./services/engagement/pushGateway").startReceiptChecks();
  }

  if (jobEnabled("jobCleanup")) {
    // Imported jobs outside Pakistan leave the feed: archived (hidden, kept), never deleted, and never a
    // job an employer posted (only isExternal imports with no postedBy). Applications stay with the job.
    const Job = require("./models/Job");
    const { archiveForeignImportedJobs } = require("./services/jobArchive");
    archiveForeignImportedJobs().then((r) => {
      console.log(`🧹 [Startup] Archived ${r.archived} imported jobs outside Pakistan (${r.checked} imported jobs checked; employer jobs are never touched).`);
    }).catch(err => {
      console.error("❌ [Startup] Failed to purge non-Pakistan jobs:", err);
    });

    // Patch existing admin/manual jobs to ensure flags exist
    Job.updateMany({ isExternal: { $exists: false } }, { $set: { isExternal: false } }).exec();
    Job.updateMany({ active: { $exists: false } }, { $set: { active: true } }).exec();
    Job.updateMany(
      { applicationDeadline: { $exists: false } },
      { $set: { applicationDeadline: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) } }
    ).exec();

    const jobIngestionService = require("./services/jobIngestionService");
    jobIngestionService.cleanupExpiredJobs().then(count => {
      if (count > 0) console.log(`⏰ [Startup] Cleaned up ${count} expired jobs.`);
    }).catch(err => {
      console.error("❌ [Startup] Failed to run expired jobs cleanup:", err);
    });

    // Schedule periodic cleanup every 6 hours
    setInterval(() => {
      jobIngestionService.cleanupExpiredJobs().catch(err => {
        console.error("❌ [Periodic] Expired jobs cleanup failed:", err);
      });
    }, 6 * 60 * 60 * 1000);
  }

  // hiring-timeline notifications: retries and interview reminders every 5 minutes (FLAG_CAREER_TIMELINE)
  if (jobEnabled("careerOutbox")) {
    require("./services/career/careerOutboxJob").start();
  }

  // Surprise Box: expired holds, closed listings, no-shows, pickup reminders, notifications, every minute (FLAG_SURPLUS_BOXES)
  if (jobEnabled("surplusSweep")) {
    require("./services/surplus/sweep").start();
  }

  // career data retention: daily; counts only (dry run) unless CAREER_RETENTION_MODE=apply
  if (jobEnabled("careerRetention")) {
    require("./services/career/careerRetentionJob").start();
  }

  // the chat database is connected either way (chat routes need it); its schedulers are switches
  const { connectDB: connectChatDB } = require("./chat-service/dist/config/db");
  connectChatDB().then(() => {
    // Engagement scheduler (drops, streaks, rollover)
    if (jobEnabled("engagementScheduler")) {
      const engagementScheduler = require('./services/engagement/schedular');
      engagementScheduler.start();
    }
    if (jobEnabled("chatSync")) {
      const { schedulerService } = require("./chat-service/dist/services/scheduler.service");
      schedulerService.initialize().catch((err) => {
        console.error("❌ Failed to initialize sync scheduler:", err);
      });
    }
  }).catch((err) => {
    console.error("❌ Failed to connect to chat database:", err);
  });
});

// ==================== SHOPIFY WEBHOOKS ====================

// Shopify webhooks (compliance, app/uninstalled, app/scopes_update): signature checked on the raw body from
// express.json's verify hook above, length-safe; rate-limited (routes/shopifyWebhooks.js). Same paths as before.
app.use("/webhooks", require("./routes/shopifyWebhooks"));
// ---------------- ROUTES ----------------
// IMPORTANT: Register webhook routes FIRST
app.use("/api", featureAccess.waitReady); // until admin feature access has loaded once (at most 5 s after start)
app.use("/api", require("./middleware/rejectGuestWrites")); // signed-out callers can't write (an allowlist of public routes: login, sign-up, webhooks ...)
app.use("/api/webhooks/woocommerce", require("./routes/storeWebhook.routes")); // connected WooCommerce stores
app.use("/api/webhooks", require("./routes/webhook.routes"));

// Now register all other routes
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/me", require("./routes/meCity.routes")); // P5b: "is your city right?" (flag cityCheck; 404 otherwise)
app.use("/api/universities", require("./routes/university.routes"));
app.use("/api/offers", require("./routes/offer.routes"));
app.use("/api/brands", require("./routes/brands.routes"));
app.use("/api/brand/store", require("./routes/brandStore.routes")); // a brand's own online store (WooCommerce)
app.use("/api/notification", require("./routes/notification.routes"));
app.use("/api/profile", require("./routes/profile.routes"));
app.use("/api/admin/actions", require("./routes/adminActions.routes")); // the unified admin action log (read-only)
app.use("/api/admin/universities", require("./routes/adminUniversities.routes")); // the shared university list (admin only, logged)
app.use("/api/admin/features", require("./routes/adminFeatures.routes")); // features per account (admin only, logged)
app.use("/api/safety", require("./routes/safetyReports.routes").intake);
app.use("/api/admin/safety-reports", require("./routes/safetyReports.routes").moderation);
app.use("/api/admin/safety", require("./routes/adminSafety.routes")); // confession safety log (plan P4-7, admins only)
app.use("/api/admin/resume-settings", require("./routes/adminResumeSettings.routes")); // owner: hide a template without an app update
app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/admin/team", require("./routes/adminTeam.routes")); // Phase A: team & access (super admins)
app.use("/api/admin/me", require("./routes/adminMe.routes")); // Phase A: an admin's own access and sessions
app.use("/api/membership", require("./routes/membership.route"));
app.use("/api/bookings", require("./routes/booking.routes"));
app.use("/api/social", require("./routes/confessionSafety.routes")); // report / mute / rules (flag confessionSafety; 404 otherwise)
app.use("/api/social", require("./routes/confessionsV2.routes")); // P4a: composer config, me too (flag confessionsV2; 404 otherwise)
app.use("/api/social", require("./routes/social.routes"));
app.use("/api/safety", require("./routes/safetyActions.routes")); // one-time links in the safety e-mail (plan P4-1b)
app.use("/api/events", require("./routes/event.routes"));
app.use("/api/app", require("./routes/appFlags.routes")); // public app switches (Meta events kill switch)
app.use("/api/invites", require("./routes/invites.routes")); // the invite page reports opens (P1-2, public, rate-limited)
app.use("/api/jobs", require("./routes/jobs.routes"));
app.use("/api/traveler", require("./routes/traveler.routes"));
// P3b: the resume coach (flags resumeV2 + resumeCoach; speech: resumeSpeak), before the resume routes
app.use("/api/resume/ai", require("./routes/resumeCoach.routes"));
app.use("/api/resume", require("./routes/resumeFinish.routes")); // P3d: feedback, verified facts, public page, outcomes (new paths only)
app.use("/api/resume", require("./routes/resume.routes"));
app.use('/api/career/resume', require('./routes/careerResume.routes')); // AI Resume Studio, before /api/career (FLAG_RESUME_STUDIO_V2)
app.use('/api/career/matching', require('./routes/careerMatching.routes')); // candidate matching, before /api/career (FLAG_CAREER_MATCHING)
app.use('/api/career/invites', require('./routes/careerInvites.routes')); // a student's invites to apply, before /api/career (FLAG_CAREER_MATCHING)
app.use("/api/brand-approval", require("./routes/brandApproval.routes"));
app.use("/api/promo-codes", require("./routes/promoCode.routes"));
app.use("/api/shopify-app", require("./middleware/shopifyAppLimit")); // per-address limit (the tdc Shopify app, server to server)
app.use("/api/shopify-app", require("./routes/shopifyApp.routes"));
app.use("/api/branches", require("./routes/branch.routes"));
app.use("/api/v1", require("./chat-service/dist/routes/index").default);

// ============ SKILLSWAP ROUTES ============
app.use('/api/professional-profile', require('./routes/professionalProfile.routes'));
app.use('/api/listings', require('./routes/listing.routes'));
app.use('/api/skill-offers', require('./routes/skillOffer.routes'));
app.use('/api/chat', require('./routes/chat.routes'));
app.use('/api/inquiries', require('./routes/inquiry.routes'));
app.use('/api/chat/upload', require('./routes/chatUpload.routes'));
app.use('/api/engagement', require('./routes/engagement.routes'));
// 🆕 admin engagement
app.use('/api/admin/engagement', require('./routes/adminEngagement.routes'));
app.use('/api/rewards', require('./routes/rewards.routes'));
app.use('/api/loyalty', require('./routes/loyalty.routes')); // brand loyalty (FLAG_LOYALTY_V2)
app.use('/api/career/ratings', require('./routes/careerRatings.routes')); // mutual ratings, before /api/career (FLAG_CAREER_RATINGS)
app.use('/api/career', require('./routes/hiringAccess.routes')); // free trial and hiring plans (every employer); unmatched requests continue below
app.use('/api/career', require('./routes/careerTrial.routes')); // First Hire Free (FLAG_EMPLOYER_FIRST_HIRE_FREE); unmatched requests continue below
app.use('/api/career', require('./routes/career.routes')); // hiring timeline (FLAG_CAREER_TIMELINE)
app.use('/api/surplus', require('./routes/surplus.routes')); // Surprise Box (FLAG_SURPLUS_BOXES)
app.use('/api/analytics', require('./routes/analytics.routes')); // admin / brand / employer figures from authoritative records (read-only)

// 🆕 admin crew
app.use('/api/admin/crew', require('./routes/adminCrew.routes'));
app.use("/api/crew", require("./routes/crew.routes")); // P2: the ambassador programme for students (flag ambassadorV2)
// ---------------- SOCKET.IO CHAT & CALL HANDLER ----------------
// moved unchanged to socket/chatHandlers.js (SEC-1)
require("./socket/chatHandlers").attach(io);

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
});
