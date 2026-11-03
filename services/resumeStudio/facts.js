// services/resumeStudio/facts.js
// VerifiedResumeFacts (handoff PART B 6.1): the candidate's facts, each with provenance, built from a
// Resume. Only these may back a tailoring change.
//   - a resume the student typed in: source "user_entered_resume", verified when last saved
//   - a resume built from an uploaded PDF: "parsed_upload", UNVERIFIED until the student confirms this
//     exact revision (CareerResumeSourceConfirmation); then "user_confirmed_resume"
//   - the job description is never a fact
// Contact details (e-mail, phone, address) are not facts and are never sent to the model.
const crypto = require("crypto");

const fmtDate = (d) => {
  if (!d) return "";
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? String(d) : x.toISOString().slice(0, 7); // YYYY-MM
};
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// the content a tailored resume is made of (what the renderer prints); plain JSON, stable key order
function contentOf(resume) {
  const r = resume || {};
  const pi = r.personalInfo || {};
  return {
    personalInfo: {
      firstName: clean(pi.firstName), lastName: clean(pi.lastName), title: clean(pi.title),
      email: clean(pi.email), phone: clean(pi.phone), location: clean(pi.location || [pi.city, pi.country].filter(Boolean).join(", ")),
      linkedin: clean(pi.linkedin), github: clean(pi.github), portfolio: clean(pi.portfolio),
    },
    professionalSummary: { summary: clean(r.professionalSummary?.summary) },
    workExperience: (r.workExperience || []).map((w) => ({
      company: clean(w.company), position: clean(w.position), location: clean(w.location),
      startDate: fmtDate(w.startDate), endDate: fmtDate(w.endDate), current: !!w.current,
      description: clean(w.description), achievements: (w.achievements || []).map(clean).filter(Boolean),
    })),
    education: (r.education || []).map((e) => ({
      institution: clean(e.institution), degree: clean(e.degree), fieldOfStudy: clean(e.fieldOfStudy),
      startDate: fmtDate(e.startDate), endDate: fmtDate(e.endDate), current: !!e.current,
      gpa: e.gpa == null || e.gpa === "" ? "" : String(e.gpa), description: clean(e.description),
    })),
    projects: (r.projects || []).map((p) => ({
      name: clean(p.name), description: clean(p.description), technologies: (p.technologies || []).map(clean).filter(Boolean),
      startDate: fmtDate(p.startDate), endDate: fmtDate(p.endDate), url: clean(p.url), githubUrl: clean(p.githubUrl),
    })),
    skills: (r.skills || []).map((s) => (typeof s === "string" ? { name: clean(s), category: "" } : { name: clean(s.name), category: clean(s.category) })).filter((s) => s.name),
    certifications: (r.certifications || []).map((c) => ({ name: clean(c.name), organization: clean(c.organization), issueDate: fmtDate(c.issueDate), credentialUrl: clean(c.credentialUrl) })).filter((c) => c.name),
    languages: (r.languages || []).map((l) => ({ name: clean(l.name), proficiency: clean(l.proficiency) })).filter((l) => l.name),
  };
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const hashContent = (content) => sha256(canonical(content));
const revisionHashOf = (resume) => hashContent(contentOf(resume));

const isUploaded = (resume) => !!(resume?.uploadedResume?.fileUrl || resume?.uploadedResume?.uploadDate);

/**
 * @param resume a Resume (lean)
 * @param confirmation { revisionHash, confirmedAt } the student's confirmation of this revision, or null
 * @returns { facts, verified, provenance, revisionHash, content, editable }
 */
function buildVerifiedFacts(resume, confirmation = null) {
  const content = contentOf(resume);
  const revisionHash = hashContent(content);
  const uploaded = isUploaded(resume);
  const confirmed = !!confirmation && confirmation.revisionHash === revisionHash;
  const provenance = uploaded ? (confirmed ? "user_confirmed_resume" : "parsed_upload") : "user_entered_resume";
  const verifiedAt = uploaded ? (confirmed ? new Date(confirmation.confirmedAt) : null) : new Date(resume.updatedAt || resume.createdAt || Date.now());
  const facts = [];
  const add = (type, value, sourcePath) => {
    const v = clean(value);
    if (!v) return;
    facts.push({ factId: `fact_${facts.length + 1}`, type, value: v, source: provenance, sourcePath, verifiedByUserAt: verifiedAt });
  };
  add("headline", content.personalInfo.title, "personalInfo.title");
  add("summary", content.professionalSummary.summary, "professionalSummary.summary");
  content.workExperience.forEach((w, i) => {
    add("role", `${w.position} at ${w.company}${w.location ? `, ${w.location}` : ""} (${w.startDate || "?"} to ${w.current ? "present" : w.endDate || "?"})`, `workExperience[${i}]`);
    add("experience", w.description, `workExperience[${i}].description`);
    w.achievements.forEach((a, j) => add("achievement", a, `workExperience[${i}].achievements[${j}]`));
  });
  content.education.forEach((e, i) => {
    add("education", `${e.degree}${e.fieldOfStudy ? ` in ${e.fieldOfStudy}` : ""}, ${e.institution} (${e.startDate || "?"} to ${e.current ? "present" : e.endDate || "?"})${e.gpa ? `, GPA ${e.gpa}` : ""}`, `education[${i}]`);
    add("education_detail", e.description, `education[${i}].description`);
  });
  content.projects.forEach((p, i) => {
    add("project", `${p.name}${p.technologies.length ? ` (${p.technologies.join(", ")})` : ""}`, `projects[${i}]`);
    add("project_detail", p.description, `projects[${i}].description`);
  });
  content.skills.forEach((s, i) => add("skill", s.name, `skills[${i}]`));
  content.certifications.forEach((c, i) => add("certification", `${c.name}${c.organization ? `, ${c.organization}` : ""}${c.issueDate ? ` (${c.issueDate})` : ""}`, `certifications[${i}]`));
  content.languages.forEach((l, i) => add("language", `${l.name}${l.proficiency ? ` (${l.proficiency})` : ""}`, `languages[${i}]`));

  // the text fields the model may reword (and the lists it may reorder)
  const editable = [];
  if (content.professionalSummary.summary) editable.push({ fieldPath: "professionalSummary.summary", text: content.professionalSummary.summary });
  content.workExperience.forEach((w, i) => {
    if (w.description) editable.push({ fieldPath: `workExperience[${i}].description`, text: w.description });
    w.achievements.forEach((a, j) => editable.push({ fieldPath: `workExperience[${i}].achievements[${j}]`, text: a }));
  });
  content.projects.forEach((p, i) => { if (p.description) editable.push({ fieldPath: `projects[${i}].description`, text: p.description }); });
  content.education.forEach((e, i) => { if (e.description) editable.push({ fieldPath: `education[${i}].description`, text: e.description }); });

  return { facts, verified: provenance !== "parsed_upload", provenance, revisionHash, content, editable };
}

module.exports = { buildVerifiedFacts, contentOf, revisionHashOf, hashContent, canonical, isUploaded, clean };
