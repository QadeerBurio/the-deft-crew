// scripts/seed-staging.js
// Made-up test data for the STAGING database only (plan P0-2; docs/STAGING.md section 1b):
//   3 universities, 20 students, 10 confessions, 5 resumes (one empty, one fresher, one experienced, two partial).
// Every account's e-mail ends in @staging.test (no real inbox), names are "Test Student NN", phones are 0300000xxxx.
// Nobody real is copied.
//
// Refuses to run unless APP_ENV=staging AND the database name in MONGO_URI contains "staging". Without --apply it only
// prints what it would create; with --apply it asks you to type APPLY (or --yes for a non-interactive run).
// Running it again creates nothing new: it finds its own records (e-mails, university names, seed tags).
// It never prints MONGO_URI (only host and database), and it does NOT read .env: the staging string must be given on
// the command line, so a production .env in the server folder can never be picked up by mistake.
//   APP_ENV=staging MONGO_URI=<staging string> SEED_PASSWORD=<test password> node scripts/seed-staging.js [--apply] [--yes]
const mongoose = require("mongoose");

const DOMAIN = "staging.test";
const UNIS = [
  { name: "Staging Test University A", shortName: "STU-A", city: "Karachi" },
  { name: "Staging Test University B", shortName: "STU-B", city: "Lahore" },
  { name: "Staging Test University C", shortName: "STU-C", city: "Islamabad" },
];
const STUDENTS = 20;
const CONFESSIONS = [
  "the library wifi works better at 2am than at 2pm and nobody can explain it",
  "i have been pretending to understand the group project for three weeks",
  "the canteen chai is the only reason i come to the 8am class",
  "i signed up for five societies and attended zero meetings",
  "my notes are colour coded and i still don't know what's in the exam",
  "the lift has been 'under maintenance' since i was a first year",
  "i laughed at my own joke in class and nobody else did",
  "the best part of my day is when the teacher says 'that's all for today'",
  "i bought a planner in january and it's still empty",
  "hostel food tastes better when you're this tired",
];
const RESUMES = ["empty", "fresher", "experienced", "partial-a", "partial-b"];

/** Why it must not run here, or null when it may. env: process.env-like. */
function refusal(env) {
  if (String(env.APP_ENV || "").trim().toLowerCase() !== "staging") return "APP_ENV must be 'staging'.";
  if (!env.MONGO_URI) return "MONGO_URI is not set.";
  let db = "";
  try { db = new URL(env.MONGO_URI).pathname.replace(/^\//, ""); } catch { return "MONGO_URI is unreadable."; }
  if (!/staging/i.test(db)) return `the database name ('${db || "(none)"}') must contain 'staging'.`;
  if (!env.SEED_PASSWORD || String(env.SEED_PASSWORD).length < 8) return "SEED_PASSWORD (at least 8 characters) is required.";
  return null;
}

const email = (i) => `student${String(i).padStart(2, "0")}@${DOMAIN}`;
const resumeName = (kind) => `seed: ${kind}`;
const confessionTag = (i) => ` (seed ${i + 1})`;

function resumeDoc(kind, userId, student) {
  const base = { user: userId, name: resumeName(kind), nameCustom: true };
  const first = "Test"; const last = student.name.replace(/^Test /, ""); // "Test" + "Student NN"
  const contact = { firstName: first, lastName: last, email: student.email, phone: student.phone, city: "Karachi", country: "Pakistan" };
  const edu = [{ institution: student.universityName, degree: "BS", fieldOfStudy: "Computer Science", startDate: new Date("2023-09-01"), current: true }];
  if (kind === "empty") return base;
  if (kind === "fresher") return { ...base, personalInfo: { ...contact, title: "CS student" }, professionalSummary: { summary: "Second-year CS student who builds small web apps and organises society events." }, education: edu,
    projects: [{ name: "Campus events board", description: "A web page listing society events.", technologies: ["React"] }], skills: [{ name: "JavaScript" }, { name: "Teamwork", category: "Soft" }] };
  if (kind === "experienced") return { ...base, personalInfo: { ...contact, title: "Software intern" }, professionalSummary: { summary: "CS student with one internship in web development." }, education: edu,
    workExperience: [{ company: "Example Labs (test)", position: "Software Intern", startDate: new Date("2025-06-01"), endDate: new Date("2025-08-31"), description: "Built internal tools." }],
    projects: [{ name: "Chat app", description: "A small chat app.", technologies: ["Node.js"] }], skills: [{ name: "Node.js" }, { name: "SQL" }], certifications: [{ name: "Intro to Git (test)", organization: "Test Academy" }] };
  if (kind === "partial-a") return { ...base, personalInfo: contact, education: edu };
  return { ...base, personalInfo: { firstName: first, lastName: last }, skills: [{ name: "Excel" }] };
}

/**
 * Plan (and with apply, write) the seed. models: { University, User, Confession, Resume }; hash: async (pw) → hash.
 * Returns { create: { universities, students, confessions, resumes }, existing: {…} }.
 */
async function seed({ University, User, Confession, Resume }, { apply = false, password, hash, log = () => {} }) {
  const out = { create: { universities: 0, students: 0, confessions: 0, resumes: 0 }, existing: { universities: 0, students: 0, confessions: 0, resumes: 0 } };

  const unis = [];
  for (const u of UNIS) {
    let doc = await University.findOne({ name: u.name }).lean();
    if (doc) out.existing.universities++;
    else { out.create.universities++; if (apply) doc = (await University.create({ ...u, status: "approved", source: "admin", aliases: [] })).toObject(); }
    unis.push(doc || { _id: null, ...u });
  }

  const students = [];
  const pwHash = apply ? await hash(password) : null;
  for (let i = 1; i <= STUDENTS; i++) {
    const uni = unis[(i - 1) % unis.length];
    const plan = { name: `Test Student ${String(i).padStart(2, "0")}`, email: email(i), phone: `0300000${String(i).padStart(4, "0")}`, role: "student", emailVerified: true, university: uni._id, universityName: uni.name };
    let doc = await User.findOne({ email: plan.email }).lean();
    if (doc) out.existing.students++;
    else { out.create.students++; if (apply) doc = (await User.create({ ...plan, password: pwHash })).toObject(); }
    students.push(doc ? { ...plan, ...doc } : plan);
  }

  for (let i = 0; i < CONFESSIONS.length; i++) {
    const author = students[i % students.length];
    const text = CONFESSIONS[i] + confessionTag(i);
    const exists = await Confession.findOne({ text }).lean();
    if (exists) { out.existing.confessions++; continue; }
    out.create.confessions++;
    if (apply) await Confession.create({ authorId: author._id, text, university: author.university, location: author.universityName, visibility: i % 3 === 0 ? "campus" : "public" });
  }

  for (let i = 0; i < RESUMES.length; i++) {
    const owner = students[i];
    const name = resumeName(RESUMES[i]);
    const exists = owner._id ? await Resume.findOne({ user: owner._id, name }).lean() : null;
    if (exists) { out.existing.resumes++; continue; }
    out.create.resumes++;
    if (apply) await Resume.create(resumeDoc(RESUMES[i], owner._id, owner));
  }

  log(`${apply ? "created" : "would create"}: ${JSON.stringify(out.create)}; already there: ${JSON.stringify(out.existing)}`);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const why = refusal(process.env);
  if (why) { console.error(`Refusing to run: ${why} This script is for the staging database only.`); process.exit(1); }
  const where = (() => { const u = new URL(process.env.MONGO_URI); return `${u.hostname}${u.pathname}`; })();
  console.log(`database: ${where}  (${apply ? "APPLY: writes" : "DRY RUN: reads only"})`);
  if (apply && !args.includes("--yes")) {
    const answer = await new Promise((resolve) => { process.stdout.write(`This WRITES test data to ${where}. Type APPLY to continue: `); process.stdin.once("data", (d) => resolve(String(d).trim())); });
    if (answer !== "APPLY") { console.log("stopped: nothing was written."); process.exit(1); }
  }
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const bcrypt = require("bcryptjs");
    await seed(
      { University: require("../models/University"), User: require("../models/User"), Confession: require("../models/Confession"), Resume: require("../models/Resume") },
      { apply, password: process.env.SEED_PASSWORD, hash: (pw) => bcrypt.hash(pw, 10), log: console.log }
    );
  } finally {
    await mongoose.disconnect();
  }
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error(`failed: ${e.name}: ${String(e.message).replace(/mongodb(\+srv)?:\/\/\S+/g, "mongodb://[redacted]")}`); process.exit(1); });

module.exports = { refusal, seed, DOMAIN, UNIS, STUDENTS, CONFESSIONS, RESUMES };
