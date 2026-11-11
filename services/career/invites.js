// services/career/invites.js
// Suggested candidates and "invite to apply" (FLAG_CAREER_MATCHING; the employer also needs FLAG_CAREER_TIMELINE).
// Students who opted in (ProfessionalProfile.discoverable, off by default), haven't applied to the job and whose
// resume shows evidence for 70%+ of its listed skills (no mandatory criterion "not met") are suggested to the job's
// employer ANONYMOUSLY: a label ("candidate 3"), the estimate, which skills matched and in which part of the resume
// (never the resume text, which can name a university, an employer or a place), the criteria counts. Never a name,
// photo, university, city, contact detail or id. The employer can only invite; the student decides. The employer
// sees who the student is only if the student applies (the normal applicants list).
//   suggested(job)                        [{ label, token, score, quality, matchedSkills, missingSkills, ... }]
//   invite(job, employerId, token)        one CareerInvite (max 20 per job per Karachi day), the student is told
//   myInvites(studentId)                  the student's invites with the job, status worked out
//   respond(studentId, inviteId, answer)  "interested" | "declined"
const crypto = require("crypto");
const Job = require("../../models/Job");
const Resume = require("../../models/Resume");
const User = require("../../models/User");
const JobApplication = require("../../models/JobApplication");
const ProfessionalProfile = require("../../models/ProfessionalProfile");
const CareerInvite = require("../../models/CareerInvite");
const Notification = require("../../models/Notification");
const matching = require("./matchingService");
const { isEnabled } = require("../../config/featureFlags");
const { dayKey } = require("../../utils/karachiTime");

const MIN_SCORE = 70;
const MAX_SUGGESTED = 30;
const DAILY_INVITES_PER_JOB = 20;

class InviteError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const quality = (s) => (s == null ? "insufficient" : s >= 70 ? "strong" : s >= 40 ? "medium" : "weak");
const jobOpen = (job, now = new Date()) => !!job && job.active === true && !job.archivedAt && (!job.applicationDeadline || now < new Date(job.applicationDeadline));
const studentInPilot = (id) => isEnabled("careerMatching", { id: String(id), role: "student" });
const employerInPilot = (id) => isEnabled("careerMatching", { id: String(id), role: "employee" }) && isEnabled("careerTimeline", { id: String(id), role: "employee" });

// an opaque token per (job, student): the employer can invite without ever holding the student's id
const tokenKey = () => crypto.createHash("sha256").update(`career-invite:${process.env.JWT_SECRET || ""}`).digest();
const tokenOf = (jobId, studentId) => crypto.createHmac("sha256", tokenKey()).update(`${jobId}:${studentId}`).digest("hex").slice(0, 32); // 32 characters: never the shape of an account id

// where a skill shows on the resume, by section only (never the text)
const SECTION = [[/^skills\[|^careerProfile/, "skills list"], [/^projects\[/, "a project"], [/^workExperience\[/, "work experience"], [/^certifications\[/, "a certification"], [/^professionalSummary/, "summary"], [/^personalInfo\.title/, "headline"]];
const sectionOf = (p) => (SECTION.find(([re]) => re.test(String(p || ""))) || [null, "resume"])[1];

async function candidatesFor(job, now = new Date()) {
  const opted = await ProfessionalProfile.find({ discoverable: true }).select("userId").lean();
  const ids = opted.map((p) => p.userId).filter((id) => studentInPilot(id));
  if (!ids.length) return [];
  const [students, applied, resumes] = await Promise.all([
    User.find({ _id: { $in: ids }, role: "student" }).select("_id").lean(),
    JobApplication.find({ jobId: job._id, userId: { $in: ids } }).select("userId").lean(),
    Resume.find({ user: { $in: ids } }).sort({ isPrimary: -1, updatedAt: -1 }).lean(),
  ]);
  const appliedSet = new Set(applied.map((a) => String(a.userId)));
  const resumeOf = new Map();
  for (const r of resumes) if (!resumeOf.has(String(r.user))) resumeOf.set(String(r.user), r);
  const out = [];
  for (const s of students) {
    const sid = String(s._id);
    if (appliedSet.has(sid) || !resumeOf.has(sid)) continue;
    const m = matching.match(job, matching.profileOf({ resume: resumeOf.get(sid) }));
    const score = m.relevance.score;
    if (score == null || score < MIN_SCORE || m.mandatorySummary.notMet > 0) continue;
    out.push({ sid, token: tokenOf(job._id, sid), m, score });
  }
  // best first; ties in a stable order that reveals nothing (the token)
  out.sort((a, b) => b.score - a.score || (a.token < b.token ? -1 : 1));
  return out.slice(0, MAX_SUGGESTED);
}

async function ownedOpenJob(jobId, employerId, now = new Date()) {
  const job = await Job.findById(jobId).lean();
  if (!job || String(job.postedBy) !== String(employerId)) throw new InviteError(404, "NOT_FOUND", "Job not found");
  if (!employerInPilot(employerId)) throw new InviteError(404, "MATCHING_OFF", "Suggested candidates aren't available for your account yet");
  if (!jobOpen(job, now)) throw new InviteError(409, "JOB_CLOSED", "This job is closed");
  return job;
}

async function suggested(jobId, employerId, now = new Date()) {
  const job = await ownedOpenJob(jobId, employerId, now);
  const list = await candidatesFor(job, now);
  const invites = new Map((await CareerInvite.find({ job: job._id, student: { $in: list.map((c) => c.sid) } }).lean()).map((i) => [String(i.student), i]));
  const today = await CareerInvite.countDocuments({ job: job._id, dayKey: dayKey(now) });
  return {
    jobId: String(job._id),
    invitesLeftToday: Math.max(0, DAILY_INVITES_PER_JOB - today),
    note: "Students who chose to be found, shown by their skills only. You can invite them to apply; they decide. You see who they are only if they apply.",
    candidates: list.map((c, i) => {
      const inv = invites.get(c.sid);
      return {
        label: `candidate ${i + 1}`,
        token: c.token,
        score: c.score,
        quality: quality(c.score),
        matchedSkills: c.m.skills.matched.map((s) => ({ skill: s.skill, where: [...new Set(s.evidence.map((e) => sectionOf(e.path)))] })),
        missingSkills: c.m.skills.missing.map((s) => s.skill),
        mandatorySummary: c.m.mandatorySummary,
        invite: inv ? { status: inv.status, sentAt: inv.createdAt } : null,
      };
    }),
  };
}

async function invite(jobId, employerId, token, now = new Date()) {
  const job = await ownedOpenJob(jobId, employerId, now);
  const c = (await candidatesFor(job, now)).find((x) => x.token === String(token || ""));
  if (!c) throw new InviteError(404, "NOT_SUGGESTED", "This candidate isn't suggested for this job any more");
  const day = dayKey(now);
  if ((await CareerInvite.countDocuments({ job: job._id, dayKey: day })) >= DAILY_INVITES_PER_JOB) throw new InviteError(429, "INVITE_LIMIT", `At most ${DAILY_INVITES_PER_JOB} invites per job a day`);
  let inv;
  try {
    inv = await CareerInvite.create({ job: job._id, student: c.sid, employer: employerId, status: "sent", score: c.score, dayKey: day, expiresAt: job.applicationDeadline || null, createdAt: now });
  } catch (err) {
    if (err?.code === 11000) throw new InviteError(409, "ALREADY_INVITED", "You already invited this candidate to this job");
    throw err;
  }
  // the student is told: in-app always, a push when the gateway allows it (caps, quiet hours, "jobsScholarships")
  const company = job.companyName || "An employer";
  const title = "You're invited to apply";
  const body = `${company} invites you to apply for ${job.title}. They saw your skills only, not your name. You decide.`;
  const data = { careerInviteId: String(inv._id), screen: "Career", params: { openJobId: String(job._id) } };
  await Notification.create({ recipient: c.sid, title, description: body, type: "Job Posting", metadata: { ...data, jobId: String(job._id), skipPush: true } });
  try { await require("../engagement/pushGateway").send(c.sid, { type: "job", pref: "jobsScholarships", title, body, data }); } catch (err) { console.error(`[career] invite push failed: ${err.message}`); }
  return { invite: { status: "sent", sentAt: inv.createdAt } };
}

const statusOf = (inv, job, applied, now = new Date()) => (applied ? "applied" : !jobOpen(job, now) && inv.status !== "declined" ? "expired" : inv.status);

async function myInvites(studentId, now = new Date()) {
  if (!studentInPilot(studentId)) throw new InviteError(404, "MATCHING_OFF", "Invites aren't available for your account yet");
  const [profile, invites] = await Promise.all([
    ProfessionalProfile.findOne({ userId: studentId }).select("discoverable").lean(),
    CareerInvite.find({ student: studentId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const jobs = new Map((await Job.find({ _id: { $in: invites.map((i) => i.job) } }).select("title companyName location type active archivedAt applicationDeadline").lean()).map((j) => [String(j._id), j]));
  const applied = new Set((await JobApplication.find({ userId: studentId, jobId: { $in: invites.map((i) => i.job) } }).select("jobId").lean()).map((a) => String(a.jobId)));
  return {
    discoverable: !!profile?.discoverable,
    invites: invites.filter((i) => jobs.has(String(i.job))).map((i) => {
      const j = jobs.get(String(i.job));
      return { id: String(i._id), job: { id: String(j._id), title: j.title, companyName: j.companyName || "", location: j.location || "", type: j.type || "" }, status: statusOf(i, j, applied.has(String(i.job)), now), sentAt: i.createdAt };
    }),
  };
}

async function respond(studentId, inviteId, answer, now = new Date()) {
  if (!studentInPilot(studentId)) throw new InviteError(404, "MATCHING_OFF", "Invites aren't available for your account yet");
  if (!["interested", "declined"].includes(answer)) throw new InviteError(400, "INVALID_RESPONSE", "response must be interested or declined");
  const inv = /^[0-9a-f]{24}$/i.test(String(inviteId)) ? await CareerInvite.findOne({ _id: inviteId, student: studentId }).lean() : null;
  if (!inv) throw new InviteError(404, "NOT_FOUND", "Invite not found");
  const job = await Job.findById(inv.job).lean();
  if (!jobOpen(job, now)) throw new InviteError(409, "JOB_CLOSED", "This job is closed");
  await CareerInvite.updateOne({ _id: inv._id, student: studentId }, { $set: { status: answer, respondedAt: now } });
  return { id: String(inv._id), status: answer };
}

module.exports = { suggested, invite, myInvites, respond, tokenOf, InviteError, MIN_SCORE, DAILY_INVITES_PER_JOB };
