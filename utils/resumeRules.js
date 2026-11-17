// utils/resumeRules.js — the resume rules the server and the app share, byte for byte
// (server: utils/resumeRules.js, app: app/src/utils/resumeRules.js; a test checks they are identical).
//   resumeStrength(resume)    -> { score 0-100, label, missing: [{ key, text, step, points }] }
//   finishErrors(resume)      -> [{ field, step, text }]  only the truly required fields
//   defaultResumeName(resume) -> "Ayesha Khan – HR Intern" (never "Untitled", never a file name)
//   pdfFileName(resume)       -> "Ayesha Khan Resume.pdf"
// Builder steps: 1 personal, 2 education, 3 experience, 4 projects, 5 certifications, 6 target job / summary, 7 skills.
'use strict';

var STEP = { personal: 1, education: 2, experience: 3, projects: 4, certifications: 5, summary: 6, skills: 7 };

function str(v) { return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim(); }
function list(v) { return Array.isArray(v) ? v : []; }
function fullName(resume) {
  var pi = (resume && resume.personalInfo) || {};
  return [str(pi.firstName), str(pi.lastName)].filter(Boolean).join(' ').replace(/\s+/g, ' ');
}
function titleOf(resume) {
  var r = resume || {};
  var pi = r.personalInfo || {};
  var t = str(pi.title) || str(r.professionalSummary && r.professionalSummary.title) || str(r.targetJob && r.targetJob.jobTitle);
  // the old upload put the person's own name (or "Professional") in the title: not a title
  if (!t || t.toLowerCase() === fullName(r).toLowerCase() || t.toLowerCase() === 'professional') return '';
  return t;
}
function hasText(v, min) { return str(v).length >= (min || 1); }
function work(resume) { return list(resume && resume.workExperience).filter(function (w) { return w && (hasText(w.company) || hasText(w.position)); }); }
function schools(resume) { return list(resume && resume.education).filter(function (e) { return e && (hasText(e.institution) || hasText(e.degree)); }); }
function projects(resume) { return list(resume && resume.projects).filter(function (p) { return p && hasText(p.name); }); }
function skills(resume) { return list(resume && resume.skills).filter(function (s) { return s && hasText(typeof s === 'string' ? s : s.name); }); }
function bullets(w) { return list(w.achievements).filter(function (b) { return hasText(b); }).length + (hasText(w.description, 10) ? 1 : 0); }
function hasDates(x) { return !!(x.startDate || x.endDate || x.current); }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
function label(w) { return str(w.position) && str(w.company) ? str(w.position) + ' at ' + str(w.company) : str(w.company) || str(w.position) || str(w.institution) || str(w.degree) || str(w.name); }

// What makes a resume strong, in points (total 100). Every missing point becomes one plain sentence.
function resumeStrength(resume) {
  var r = resume || {};
  var pi = r.personalInfo || {};
  var score = 0;
  var missing = [];
  function part(ok, points, key, text, step) { if (ok) score += points; else missing.push({ key: key, text: text, step: step, points: points }); }

  // contact: 20
  part(!!fullName(r), 6, 'name', 'add your full name', STEP.personal);
  part(hasText(pi.email), 5, 'email', 'add your email', STEP.personal);
  part(hasText(pi.phone), 5, 'phone', 'add your phone number', STEP.personal);
  part(hasText(pi.city) || hasText(pi.location), 4, 'city', 'add your city', STEP.personal);
  // title: 5, summary: 10
  part(!!titleOf(r), 5, 'title', 'add a title, like "HR Intern"', STEP.personal);
  part(hasText(r.professionalSummary && r.professionalSummary.summary, 40), 10, 'summary', 'add a short summary (2–3 lines about you)', STEP.summary);

  // experience: 20 (one entry 12, dates 4, what you did 4)
  var jobs = work(r);
  part(jobs.length > 0, 12, 'experience', 'add an internship, job or volunteer role', STEP.experience);
  if (jobs.length) {
    var noDates = jobs.filter(function (w) { return !hasDates(w); });
    part(!noDates.length, 4, 'experience_dates', 'add dates to your ' + (noDates.length === 1 ? 'experience at ' + label(noDates[0]) : plural(noDates.length, 'experience', 'experiences')), STEP.experience);
    var noBullets = jobs.filter(function (w) { return bullets(w) === 0; });
    part(!noBullets.length, 4, 'experience_bullets', 'add 1–3 lines on what you did' + (noBullets.length === 1 ? ' as ' + label(noBullets[0]) : ' in ' + plural(noBullets.length, 'role', 'roles')), STEP.experience);
  }

  // education: 15 (school 9, degree 3, dates 3)
  var edu = schools(r);
  part(edu.length > 0, 9, 'education', 'add your school, college or university', STEP.education);
  if (edu.length) {
    part(edu.every(function (e) { return hasText(e.degree) || hasText(e.fieldOfStudy); }), 3, 'education_degree', 'add your degree or programme', STEP.education);
    var eduNoDates = edu.filter(function (e) { return !hasDates(e); });
    part(!eduNoDates.length, 3, 'education_dates', 'add dates to ' + (eduNoDates.length === 1 ? label(eduNoDates[0]) : plural(eduNoDates.length, 'education entry', 'education entries')), STEP.education);
  }

  // projects: 10 (one 6, description 4)
  var proj = projects(r);
  part(proj.length > 0, 6, 'projects', 'add a project (class, personal or work)', STEP.projects);
  if (proj.length) {
    var noDesc = proj.filter(function (p) { return !hasText(p.description, 10); });
    part(!noDesc.length, 4, 'project_description', 'add a line about ' + (noDesc.length === 1 ? 'your project "' + label(noDesc[0]) + '"' : plural(noDesc.length, 'project', 'projects')), STEP.projects);
  }

  // skills: 15 (3 points each, up to 5)
  var n = Math.min(5, skills(r).length);
  score += n * 3;
  if (n < 5) missing.push({ key: 'skills', text: 'add ' + plural(5 - n, 'more skill', 'more skills'), step: STEP.skills, points: (5 - n) * 3 });

  // extras: 5 (any of certifications, languages, achievements)
  var extras = list(r.certifications).some(function (c) { return c && hasText(c.name); }) ||
    list(r.languages).some(function (l) { return l && hasText(l.name); }) ||
    list(r.achievements).some(function (a) { return hasText(a); });
  part(extras, 5, 'extras', 'add a certificate, language or achievement', STEP.certifications);

  score = Math.max(0, Math.min(100, Math.round(score)));
  missing.sort(function (a, b) { return b.points - a.points; });
  return { score: score, label: score >= 80 ? 'strong' : score >= 50 ? 'good start' : 'needs more', missing: missing };
}

// Only these block "finish": a name, a way to reach the student, and one of experience / education / projects.
function finishErrors(resume) {
  var r = resume || {};
  var pi = r.personalInfo || {};
  var errors = [];
  if (!fullName(r)) errors.push({ field: 'name', step: STEP.personal, text: 'add your full name' });
  if (!hasText(pi.email) && !hasText(pi.phone)) errors.push({ field: 'contact', step: STEP.personal, text: 'add your email or phone so employers can reach you' });
  if (!work(r).length && !schools(r).length && !projects(r).length) {
    errors.push({ field: 'background', step: STEP.education, text: 'add at least one: education, experience or a project' });
  }
  return errors;
}

var FILE_EXT = /\.(pdf|docx?|rtf|txt|odt|pages)$/i;
function cleanName(s) { return str(s).replace(FILE_EXT, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function defaultResumeName(resume) {
  var name = cleanName(fullName(resume));
  var title = cleanName(titleOf(resume));
  if (name && title) return name + ' – ' + title;
  if (name) return name + ' – Resume';
  if (title) return title + ' resume';
  return 'My resume';
}

// the name the student sees: their own if they set one (minus any file extension), else the default
function resumeName(resume) {
  var own = resume && resume.nameCustom ? cleanName(resume.name) : '';
  if (own && !/^untitled\b/i.test(own)) return own;
  return defaultResumeName(resume);
}

function pdfFileName(resume) {
  var name = cleanName(fullName(resume)).replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, '').trim();
  return (name || 'My') + ' Resume.pdf';
}

module.exports = { STEP: STEP, resumeStrength: resumeStrength, finishErrors: finishErrors, defaultResumeName: defaultResumeName, resumeName: resumeName, pdfFileName: pdfFileName, titleOf: titleOf, fullName: fullName };
