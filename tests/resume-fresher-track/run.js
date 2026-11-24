// P3-2 fair strength score (utils/resumeRules.js, shared byte for byte with the app):
//   a missing track or "experienced": exactly the old result (old-strength.json = the previous file's answers for 14
//     resumes, frozen before the change), only with stepKey added to each missing item
//   fresher: contact 20, title + summary 15, education 20 (school 10, programme 5, graduation date 5), projects 15,
//     activities / leadership / volunteering 10, skills 15, extras 5 (awards count); no experience needed: 100 is
//     possible without it, and experience adds up to 5, the total capped at 100
//   fresher sentences: "add a society, club or volunteer role", never "add an internship"
//   every missing item has a stepKey (the builder's step name); the numbers stay for older apps
//   node tests/resume-fresher-track/run.js [serverDir]
const path = require("path");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const rules = require(path.join(SERVER, "utils", "resumeRules.js"));
const fixtures = require("./old-strength.json");
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const strip = (r) => ({ ...r, missing: r.missing.map(({ stepKey, ...m }) => m) });

console.log("-- no track / experienced: the old score");
for (const [name, f] of Object.entries(fixtures)) {
  const got = rules.resumeStrength(f.input);
  check(`${name}: score ${f.expect.score}, same missing items`, JSON.stringify(strip(got)) === JSON.stringify(f.expect), JSON.stringify(got).slice(0, 300));
}
const any = rules.resumeStrength({});
check("every missing item has a stepKey from the builder's steps", any.missing.every((m) => rules.STEP_KEYS.includes(m.stepKey)));
check("…the number stays (older apps)", any.missing.every((m) => Number.isInteger(m.step)));
check("an unknown track scores as experienced", rules.resumeStrength({ settings: { track: "junior" } }).score === rules.resumeStrength({}).score && rules.trackOf({ settings: { track: "junior" } }) === "experienced");

console.log("-- fresher");
const D = "2027-06-01";
const base = () => ({
  settings: { track: "fresher" },
  personalInfo: { firstName: "Ayesha", lastName: "Khan", email: "ayesha@x.co", phone: "03001234567", city: "Karachi", title: "BBA student" },
  professionalSummary: { summary: "Final-year BBA student who runs the marketing society's events." },
  education: [{ institution: "IBA", degree: "BBA", endDate: D }],
  projects: [{ name: "Cafe business plan", description: "A business plan for a campus cafe, for a class." }],
  activities: [{ organisation: "Marketing Society", role: "events lead", bullets: ["organised the welcome week"] }],
  skills: ["Excel", "Canva", "Public speaking", "Teamwork", "Research"].map((name) => ({ name })),
  languages: [{ name: "Urdu", proficiency: "Native" }],
});
let r = rules.resumeStrength(base());
check("a complete fresher resume with no experience scores 100", r.score === 100 && r.label === "strong", JSON.stringify(r));
const exp = base(); delete exp.settings;
check("…the same resume on the experienced track: 80 (it lacks the 20 experience points)", rules.resumeStrength(exp).score === 80);
const noAct = base(); noAct.activities = [];
r = rules.resumeStrength(noAct);
check("no activity: -10, 'add a society, club or volunteer role' (activities step)", r.score === 90 && r.missing[0].key === "activities" && r.missing[0].text === "add a society, club or volunteer role" && r.missing[0].stepKey === "activities" && r.missing[0].points === 7, JSON.stringify(r.missing));
check("…never 'add an internship'", !r.missing.some((m) => /internship/.test(m.text)));
const vol = base(); vol.activities = []; vol.volunteering = [{ organisation: "Edhi", role: "volunteer", description: "packed and delivered food parcels" }];
check("volunteering counts as an activity (a description line counts too)", rules.resumeStrength(vol).score === 100);
const quiet = base(); quiet.activities[0].bullets = [];
r = rules.resumeStrength(quiet);
check("an activity with no line: -3 'add a line on what you did at Marketing Society'", r.score === 97 && r.missing.some((m) => m.key === "activity_lines" && m.text === "add a line on what you did at Marketing Society"));
const noGrad = base(); noGrad.education[0].endDate = null;
r = rules.resumeStrength(noGrad);
check("no graduation date: -5 'add your graduation date (or expected) to IBA'", r.score === 95 && r.missing.some((m) => m.key === "education_dates" && m.text === "add your graduation date (or expected) to IBA" && m.points === 5));
noGrad.education[0].current = true;
check("…'currently studying' counts", rules.resumeStrength(noGrad).score === 100);
const noDeg = base(); noDeg.education[0].degree = "";
check("no programme: -5", rules.resumeStrength(noDeg).score === 95);
const noEdu = base(); noEdu.education = [];
check("no education: -20 (10 + 5 + 5)", rules.resumeStrength(noEdu).score === 80);
const noProj = base(); noProj.projects = [];
r = rules.resumeStrength(noProj);
check("no project: -15, 'add a project (class, final-year or personal)'", r.score === 85 && r.missing.some((m) => m.key === "projects" && m.points === 9 && /final-year/.test(m.text)));
const noDesc = base(); noDesc.projects[0].description = "";
check("a project with no line: -6", rules.resumeStrength(noDesc).score === 94);
const awards = base(); awards.languages = []; awards.awards = [{ title: "Dean's list" }];
check("an award counts as an extra on the fresher track", rules.resumeStrength(awards).score === 100);
const noExtras = base(); noExtras.languages = [];
check("…no extra: 'add a certificate, language, award or achievement'", rules.resumeStrength(noExtras).missing.some((m) => m.key === "extras" && /award/.test(m.text)));
const partial = base(); partial.activities = []; partial.workExperience = [{ company: "Daraz", position: "intern", achievements: ["answered seller questions"] }];
check("experience on the fresher track: a bonus of 5 (90 → 95)", rules.resumeStrength(partial).score === 95);
partial.workExperience[0].achievements = [];
check("…3 without a line on what they did", rules.resumeStrength(partial).score === 93);
const capped = base(); capped.workExperience = [{ company: "Daraz", position: "intern", achievements: ["x"] }];
check("…never above 100", rules.resumeStrength(capped).score === 100);
const empty = rules.resumeStrength({ settings: { track: "fresher" } });
check("an empty fresher resume: 0, the missing points add up to 81 before any entry exists", empty.score === 0 && empty.missing.reduce((a, m) => a + m.points, 0) === 81);
check("fresher missing items have step keys too", empty.missing.every((m) => rules.STEP_KEYS.includes(m.stepKey)));

console.log("-- the shared file");
const fs = require("fs");
const app = path.join(SERVER, "..", "Testting", "app", "src", "utils", "resumeRules.js");
if (fs.existsSync(app)) check("the app's copy is identical (also checked by the app's resume-pdf-save test)", fs.readFileSync(app, "utf8").replace(/\r\n/g, "\n") === fs.readFileSync(path.join(SERVER, "utils", "resumeRules.js"), "utf8").replace(/\r\n/g, "\n"));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
