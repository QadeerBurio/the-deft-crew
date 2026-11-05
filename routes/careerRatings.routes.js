// routes/careerRatings.routes.js — /api/career/ratings (services/career/ratingService.js), behind
// FLAG_CAREER_RATINGS (for the rater and the person rated; for the viewer of an employer's average).
//   GET  /applications/:id          the candidate or the job's employer: what they can rate (completed interviews,
//                                   a verified hire), the questions, the 14-day window, their own rating
//   POST /                          { applicationId, kind: interview | hire, ref?, answers: { q: 1-5 x3 }, comment? }
//                                   201 rated; 200 the same rating again; 409 ALREADY_RATED / WINDOW_CLOSED /
//                                   NOT_ELIGIBLE; 400 INVALID_ANSWERS / COMMENT_NOT_ALLOWED
//   GET  /jobs/:jobId/employer      any signed-in user with the flag: the job's employer average, only from 5
//                                   released ratings, half stars, no comments
//   GET  /me/received               a student: the released ratings employers gave them (to read and report);
//                                   an employer: its average and, from 5 on, the ratings anonymised
//   POST /:id/report                the person rated: { reason } (unfair rating)
//   GET  /admin/reports?status=     admin: reports with the rating; POST /admin/reports/:id/decide { action:
//                                   hide | keep, reason } (recorded). 404 unless FLAG_CAREER_RATINGS is set
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const Job = require("../models/Job");
const ratings = require("../services/career/ratingService");

const router = express.Router();
const { RatingError } = ratings;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const ok = (req, res, data, status = 200) => res.status(status).json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: { code, message, ...extra }, requestId: req.id || null });
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof RatingError) return fail(req, res, err.status, err.code, err.message, err.extra);
    console.error("[career-ratings]", err?.message);
    return fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};
const signedIn = async (req, res, next) => {
  if (req.isGuest || !isId(req.userId)) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const u = await User.findById(req.userId).select("role").lean();
  if (!u) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  req.ratingRole = u.role;
  next();
};
const flagged = (req, res, next) => (ratings.flagOn(req.userId, req.ratingRole) ? next() : fail(req, res, 404, "RATINGS_OFF", "Ratings aren't available for your account yet"));
const pilotConfigured = () => !["", "off", "false", "0", "no"].includes(String(process.env.FLAG_CAREER_RATINGS || "").trim().toLowerCase());
const admin = (req, res, next) => {
  if (req.ratingRole !== "admin") return fail(req, res, 403, "FORBIDDEN", "Not allowed for your account");
  if (!pilotConfigured()) return fail(req, res, 404, "RATINGS_OFF", "Ratings aren't set up");
  next();
};

router.get("/applications/:id", auth, signedIn, handle(async (req, res) => ok(req, res, await ratings.forApplication(req.params.id, req.userId))));

router.post("/", auth, signedIn, handle(async (req, res) => {
  const { rating, created } = await ratings.rate(req.userId, req.body || {});
  ok(req, res, { id: String(rating._id), kind: rating.kind, answers: rating.answers, comment: rating.comment, createdAt: rating.createdAt, released: !!rating.releasedAt, duplicate: !created }, created ? 201 : 200);
}));

router.get("/jobs/:jobId/employer", auth, signedIn, flagged, handle(async (req, res) => {
  if (!isId(req.params.jobId)) return fail(req, res, 404, "NOT_FOUND", "Job not found");
  const job = await Job.findById(req.params.jobId).select("postedBy isExternal").lean();
  if (!job) return fail(req, res, 404, "NOT_FOUND", "Job not found");
  if (!job.postedBy || job.isExternal) return ok(req, res, { count: 0, shown: false, minimum: ratings.MIN_PUBLIC, average: null, questions: null });
  ok(req, res, await ratings.employerSummary(job.postedBy));
}));

router.get("/me/received", auth, signedIn, flagged, handle(async (req, res) => {
  if (!["student", "employee"].includes(req.ratingRole)) return fail(req, res, 403, "FORBIDDEN", "Not allowed for your account");
  ok(req, res, await ratings.received(req.userId, req.ratingRole));
}));

router.post("/:id/report", auth, signedIn, flagged, handle(async (req, res) => {
  const rep = await ratings.report(req.userId, req.params.id, req.body?.reason);
  ok(req, res, { id: String(rep._id), status: rep.status }, 201);
}));

router.get("/admin/reports", auth, signedIn, admin, handle(async (req, res) => ok(req, res, await ratings.reports(String(req.query.status || "open")))));
router.post("/admin/reports/:id/decide", auth, signedIn, admin, handle(async (req, res) => {
  const rep = await ratings.decide(req.userId, req.params.id, req.body || {});
  ok(req, res, { id: String(rep._id), status: rep.status, decisionReason: rep.decisionReason });
}));

module.exports = router;
