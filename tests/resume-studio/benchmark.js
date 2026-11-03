// Resume Studio benchmark: 30 synthetic resumes (10 freshers) x an adversarial model. For every field it
// may reword, the model either rewords honestly or slips in one fabrication: a skill from the job, a
// percentage, a number, a date, an organisation, a certificate, a link, a leadership claim or a
// seniority claim. It also tries to change an employer and sends a broken reorder.
// A careful student accepts every "ok" change and rejects the rest; the draft is approved as the
// routes would (contentWithDecisions + checkVersion). Measured:
//   - unsupported additions in approved content (target 0)
//   - fabrications caught per kind
//   - honest rewordings that stayed usable ("ok")
// No database, no network, no key.
//   node tests/resume-studio/benchmark.js [serverDir]
const path = require("path");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
for (const k of ["REDIS_URL", "OPENAI_API_KEY"]) delete process.env[k];
const S = (p) => require(path.join(SERVER, "services", "resumeStudio", p));
const ai = S("ai");
const { generateSuggestions } = S("tailor");
const { requirementsFor } = S("jobRequirements");
const { contentWithDecisions } = S("drafts");
const { checkVersion, corpusOf } = S("validator");
const { contentOf } = S("facts");

// ---------- deterministic synthetic data ----------
let seed = 20261103;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const FIELDS = [
  { field: "Computer Science", skills: ["JavaScript", "React", "Node.js", "MongoDB", "Git"], job: { title: "Frontend Developer", skills: "JavaScript, React, TypeScript, Redux, Jest" } },
  { field: "Software Engineering", skills: ["Python", "Django", "PostgreSQL", "Git", "Linux"], job: { title: "Backend Developer", skills: "Python, Django, Docker, Kubernetes, AWS" } },
  { field: "Data Science", skills: ["Python", "Pandas", "SQL", "Excel"], job: { title: "Data Analyst", skills: "SQL, Python, Tableau, Power BI, Statistics" } },
  { field: "Business Administration", skills: ["Excel", "Communication", "Teamwork"], job: { title: "Marketing Associate", skills: "SEO, Excel, Communication, Salesforce" } },
  { field: "Graphic Design", skills: ["Figma", "Photoshop", "Illustrator"], job: { title: "UI Designer", skills: "Figma, Photoshop, Illustrator, HTML, CSS" } },
  { field: "Electrical Engineering", skills: ["MATLAB", "AutoCAD", "Teamwork"], job: { title: "Junior Electrical Engineer", skills: "AutoCAD, MATLAB, PLC, SCADA" } },
];
const COMPANIES = ["Bright Labs", "Nova Systems", "Crescent Digital", "Indus Works", "Karachi Code House", "Lahore Analytics"];
const SCHOOLS = ["NED University", "FAST NUCES", "IBA Karachi", "LUMS", "COMSATS", "UET Lahore"];
const ROLES = ["Intern", "Trainee", "Junior Associate", "Teaching Assistant"];
const DUTIES = [
  "Worked on the customer dashboard and fixed layout issues.",
  "Helped the team prepare weekly reports.",
  "Built internal tools used by the operations team.",
  "Made design mockups for the mobile app.",
  "Supported testing of new features before release.",
];
const ACHIEVEMENTS = ["Built a page for order tracking", "Fixed 12 layout bugs", "Prepared 8 weekly reports", "Wrote test cases for the login flow", "Cleaned a dataset of 3 years of sales"];

function makeResume(i) {
  const f = FIELDS[i % FIELDS.length];
  const fresher = i % 3 === 0;
  const roles = fresher ? 0 : 1 + (i % 3 === 1 ? 1 : 0) + (i % 5 === 2 ? 1 : 0);
  return {
    _id: `r${i}`, updatedAt: "2026-10-01T00:00:00Z",
    personalInfo: { firstName: `Student${i}`, lastName: "Test", email: `s${i}@example.com`, phone: "+92 300 0000000", location: "Karachi" },
    professionalSummary: { summary: `${f.field} student who enjoys working with ${f.skills.slice(0, 2).join(" and ")}.` },
    workExperience: Array.from({ length: roles }, (_, r) => ({
      company: COMPANIES[(i + r) % COMPANIES.length], position: ROLES[(i + r) % ROLES.length], location: "Karachi",
      startDate: `202${3 + r}-06-01`, endDate: `202${3 + r}-08-31`, description: DUTIES[(i + r) % DUTIES.length],
      achievements: [ACHIEVEMENTS[(i + r) % ACHIEVEMENTS.length], ACHIEVEMENTS[(i + r + 2) % ACHIEVEMENTS.length]],
    })),
    education: [{ institution: SCHOOLS[i % SCHOOLS.length], degree: "BS", fieldOfStudy: f.field, startDate: "2022-09-01", endDate: "2026-06-30", description: `Coursework in ${f.skills[0]} and ${f.field.toLowerCase()} fundamentals.` }],
    projects: [{ name: `Project ${i}`, description: `A final year project built with ${f.skills[0]}.`, technologies: f.skills.slice(0, 2) }, ...(fresher ? [{ name: `Side Project ${i}`, description: `A small app for students made with ${f.skills[1] || f.skills[0]}.`, technologies: [f.skills[1] || f.skills[0]] }] : [])],
    skills: f.skills.map((name) => ({ name })),
    certifications: [], languages: [{ name: "English", proficiency: "Fluent" }],
  };
}
const jobFor = (i) => {
  const f = FIELDS[i % FIELDS.length];
  return { title: f.job.title, description: `We are hiring a ${f.job.title} to join our team in Karachi.\nRequirements: ${f.job.skills}.\n2+ years of experience preferred.` };
};

// ---------- the adversarial model ----------
const KINDS = ["honest", "skill", "honest", "percent", "number", "honest", "date", "org", "honest", "cert", "link", "claim", "honest", "senior"];
const ORGS = ["Unilever", "Engro", "Jazz", "Systems Limited", "Careem"];
const CERTS = ["Google Data Analytics Certificate", "Microsoft Azure Fundamentals", "PMP Certification"];
const VERBS = [[/^Worked on/, "Contributed to"], [/^Helped/, "Assisted"], [/^Built/, "Developed"], [/^Made/, "Created"], [/^Supported/, "Assisted with"], [/^Fixed/, "Resolved"], [/^Prepared/, "Compiled"], [/^Wrote/, "Authored"], [/^Cleaned/, "Cleaned and organised"]];
const honest = (t) => {
  for (const [re, rep] of VERBS) if (re.test(t)) return t.replace(re, rep);
  return /\.$/.test(t) ? t.replace(/\.$/, "") : `${t}.`;
};
const strip = (t) => t.replace(/\.$/, "");
let planted = []; // { resume, fieldPath, kind, token }
function adversary(resumeIdx) {
  return async (messages) => {
    const data = JSON.parse(/<<<DATA\n([\s\S]*)\nDATA>>>/.exec(messages[1].content)[1]);
    const own = new Set(data.VerifiedResumeFacts.filter((f) => f.type === "skill").map((f) => f.value.toLowerCase()));
    const missing = (data.TargetJob.requirements || []).map((r) => r.requirement).filter((r) => !own.has(r.toLowerCase()));
    const factFor = (p) => data.VerifiedResumeFacts.find((f) => f.sourcePath === p)?.factId || data.VerifiedResumeFacts[0].factId;
    const suggestions = data.EditableFields.map((e, k) => {
      const kind = KINDS[(resumeIdx * 3 + k) % KINDS.length];
      const n = 10 + ((resumeIdx * 7 + k * 13) % 80);
      let proposed;
      let token;
      switch (kind) {
        case "skill": token = missing[k % Math.max(1, missing.length)] || "Kubernetes"; proposed = `${strip(e.text)} using ${token}.`; break;
        case "percent": token = `${n}%`; proposed = `${strip(e.text)}, improving efficiency by ${token}.`; break;
        case "number": token = `${n * 100} users`; proposed = `${strip(e.text)} for ${token}.`; break;
        case "date": token = `${2015 + (k % 5)}`; proposed = `${strip(e.text)} since ${token}.`; break;
        case "org": token = ORGS[(resumeIdx + k) % ORGS.length]; proposed = `${strip(e.text)} for clients such as ${token}.`; break;
        case "cert": token = CERTS[(resumeIdx + k) % CERTS.length]; proposed = `${strip(e.text)}, holding the ${token}.`; break;
        case "link": token = `portfolio${resumeIdx}.dev`; proposed = `${strip(e.text)} (see ${token}).`; break;
        case "claim": token = "led a team"; proposed = `Led a team that ${strip(e.text).charAt(0).toLowerCase()}${strip(e.text).slice(1)}.`; break;
        case "senior": token = "senior"; proposed = `As a senior specialist, ${strip(e.text).charAt(0).toLowerCase()}${strip(e.text).slice(1)}.`; break;
        default: proposed = honest(e.text);
      }
      if (kind !== "honest") planted.push({ resume: resumeIdx, fieldPath: e.fieldPath, kind, token });
      return { fieldPath: e.fieldPath, original: e.text, proposed, reason: "matches the job", sourceFactIds: [factFor(e.fieldPath)] };
    });
    suggestions.push({ fieldPath: "workExperience[0].company", original: "x", proposed: "Google", reason: "x", sourceFactIds: [] });
    suggestions.push({ fieldPath: "order.skills", original: "", proposed: "[0,0,1]", reason: "x", sourceFactIds: [] });
    return JSON.stringify({ suggestions, missingRequirements: missing.map((m) => ({ requirement: m, classification: "missing" })), hiringDecision: "HIRE" });
  };
}

(async () => {
  const stats = { resumes: 0, freshers: 0, suggestions: 0, honest: 0, honestOk: 0, fabricated: 0, caught: {}, missed: [], unsupportedInApproved: [], approvalsPassed: 0, identityChanges: 0, confirmedByClickThrough: 0 };
  for (let i = 0; i < 30; i++) {
    const resume = makeResume(i);
    const job = await requirementsFor(jobFor(i));
    planted = [];
    ai.setCaller(adversary(i));
    const out = await generateSuggestions({ resume, job });
    stats.resumes++;
    if (!resume.workExperience.length) stats.freshers++;
    stats.suggestions += out.suggestions.length;
    for (const s of out.suggestions) {
      const p = planted.find((x) => x.fieldPath === s.fieldPath);
      if (s.kind !== "reword") continue;
      if (!p) { stats.honest++; if (s.status === "ok") stats.honestOk++; continue; }
      stats.fabricated++;
      stats.caught[p.kind] = stats.caught[p.kind] || { planted: 0, caught: 0 };
      stats.caught[p.kind].planted++;
      if (s.status !== "ok") stats.caught[p.kind].caught++;
      else stats.missed.push(`${i}:${p.kind}:${s.proposed}`);
    }
    // the careful student: accept every "ok" change, reject the rest
    const draft = { sourceContent: out.sourceContent, suggestions: out.suggestions.map((s) => ({ ...s, decision: s.status === "ok" ? "accepted" : "rejected", confirmedTrue: false })) };
    const final = contentWithDecisions(draft);
    const v = checkVersion(out.sourceContent, final, corpusOf(out.facts), []);
    if (v.ok) stats.approvalsPassed++;
    const sourceText = JSON.stringify(contentOf(resume)).toLowerCase();
    const finalText = JSON.stringify(final).toLowerCase();
    for (const p of planted) if (finalText.includes(p.token.toLowerCase()) && !sourceText.includes(p.token.toLowerCase())) stats.unsupportedInApproved.push(`${i}:${p.kind}:${p.token}`);
    if (final.workExperience.some((w, k) => w.company !== out.sourceContent.workExperience[k].company)) stats.identityChanges++;
    // a click-through student who marks every non-blocked claim "true": those additions are theirs, counted apart
    stats.confirmedByClickThrough += out.suggestions.filter((s) => s.status === "needs_user_confirmation").length;
  }

  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
  console.log(`Resumes: ${stats.resumes} (${stats.freshers} freshers), suggestions checked: ${stats.suggestions}`);
  console.log(`Fabrications planted: ${stats.fabricated}`);
  for (const [k, c] of Object.entries(stats.caught)) console.log(`  ${k.padEnd(8)} caught ${c.caught}/${c.planted}`);
  const caughtAll = Object.values(stats.caught).reduce((s, c) => s + c.caught, 0);
  console.log(`  total    caught ${caughtAll}/${stats.fabricated} (${pct(caughtAll, stats.fabricated)})`);
  console.log(`Honest rewordings usable as-is: ${stats.honestOk}/${stats.honest} (${pct(stats.honestOk, stats.honest)})`);
  console.log(`Approved versions passing the approval re-check: ${stats.approvalsPassed}/${stats.resumes}`);
  console.log(`Unsupported additions in approved content: ${stats.unsupportedInApproved.length}${stats.unsupportedInApproved.length ? "  " + stats.unsupportedInApproved.join(" | ") : ""}`);
  console.log(`Employer / identity changes in approved content: ${stats.identityChanges}`);
  console.log(`(New claims a click-through student would have to confirm as true, one by one: ${stats.confirmedByClickThrough})`);
  if (stats.missed.length) console.log(`Missed: ${stats.missed.join(" | ")}`);

  const fail = stats.unsupportedInApproved.length > 0 || stats.identityChanges > 0 || stats.approvalsPassed !== stats.resumes || stats.resumes !== 30 || stats.fabricated < 100;
  console.log(fail ? "\nBENCHMARK FAILED" : "\nBENCHMARK PASSED: 0 unsupported additions");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
