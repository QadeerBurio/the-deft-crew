// utils/resumeRules.js — the resume rules the server and the app share, byte for byte
// (server: utils/resumeRules.js, app: app/src/utils/resumeRules.js; a test checks they are identical).
//   resumeStrength(resume)    -> { score 0-100, label, missing: [{ key, text, step, points, stepKey }] }
//   finishErrors(resume)      -> [{ field, step, text }]  only the truly required fields
//   defaultResumeName(resume) -> "Ayesha Khan – HR Intern" (never "Untitled", never a file name)
//   pdfFileName(resume)       -> "Ayesha Khan Resume.pdf"
// Builder steps: 1 personal, 2 education, 3 experience, 4 projects, 5 certifications, 6 target job / summary, 7 skills.
// P3-2 (flag resumeV2 in the app): resume.settings.track "fresher" scores without experience (see resumeStrength);
// a missing track or "experienced" scores exactly as before. Every missing item also has stepKey (the step's name),
// because the fresher builder orders its steps differently; step (the number) stays for older apps.
'use strict';

var STEP = { personal: 1, education: 2, experience: 3, projects: 4, certifications: 5, summary: 6, skills: 7 };
var STEP_KEYS = ['personal', 'education', 'experience', 'projects', 'certifications', 'summary', 'skills', 'activities', 'volunteering', 'awards', 'languages'];
function stepKeyOf(step) { for (var k in STEP) { if (STEP[k] === step) return k; } return null; }
function trackOf(resume) { return resume && resume.settings && resume.settings.track === 'fresher' ? 'fresher' : 'experienced'; }

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
function activities(resume) { return list(resume && resume.activities).concat(list(resume && resume.volunteering)).filter(function (a) { return a && (hasText(a.organisation) || hasText(a.role)); }); }
function activityLines(a) { return list(a.bullets).filter(function (b) { return hasText(b); }).length + (hasText(a.description, 10) ? 1 : 0); }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
function label(w) { return str(w.position) && str(w.company) ? str(w.position) + ' at ' + str(w.company) : str(w.company) || str(w.position) || str(w.institution) || str(w.degree) || str(w.name); }

// What makes a resume strong, in points (total 100). Every missing point becomes one plain sentence.
//                 experienced (missing track: as before)   fresher (P3-2)
//   contact       20                                       20
//   title+summary 15                                       15
//   experience    20                                       0 (+ up to 5 bonus when added, the total capped at 100)
//   education     15                                       20 (school 10, programme 5, graduation date 5)
//   projects      10                                       15 (one 9, a line about it 6)
//   activities     0                                       10 (a society, club or volunteer role 7, a line about it 3)
//   skills        15                                       15
//   extras         5                                       5 (certificate, language, achievement or award)
function resumeStrength(resume) {
  var r = resume || {};
  var pi = r.personalInfo || {};
  var fresher = trackOf(r) === 'fresher';
  var score = 0;
  var missing = [];
  function part(ok, points, key, text, step, stepKey) { if (ok) score += points; else missing.push({ key: key, text: text, step: step, points: points, stepKey: stepKey || stepKeyOf(step) }); }

  // contact: 20
  part(!!fullName(r), 6, 'name', 'add your full name', STEP.personal);
  part(hasText(pi.email), 5, 'email', 'add your email', STEP.personal);
  part(hasText(pi.phone), 5, 'phone', 'add your phone number', STEP.personal);
  part(hasText(pi.city) || hasText(pi.location), 4, 'city', 'add your city', STEP.personal);
  // title: 5, summary: 10
  part(!!titleOf(r), 5, 'title', 'add a title, like "HR Intern"', STEP.personal);
  part(hasText(r.professionalSummary && r.professionalSummary.summary, 40), 10, 'summary', 'add a short summary (2–3 lines about you)', STEP.summary);

  // experience: 20 (one entry 12, dates 4, what you did 4); fresher: a bonus only, never missing
  var jobs = work(r);
  if (fresher) {
    if (jobs.length) score += 3 + (jobs.every(function (w) { return bullets(w) > 0; }) ? 2 : 0);
  } else part(jobs.length > 0, 12, 'experience', 'add an internship, job or volunteer role', STEP.experience);
  if (jobs.length && !fresher) {
    var noDates = jobs.filter(function (w) { return !hasDates(w); });
    part(!noDates.length, 4, 'experience_dates', 'add dates to your ' + (noDates.length === 1 ? 'experience at ' + label(noDates[0]) : plural(noDates.length, 'experience', 'experiences')), STEP.experience);
    var noBullets = jobs.filter(function (w) { return bullets(w) === 0; });
    part(!noBullets.length, 4, 'experience_bullets', 'add 1–3 lines on what you did' + (noBullets.length === 1 ? ' as ' + label(noBullets[0]) : ' in ' + plural(noBullets.length, 'role', 'roles')), STEP.experience);
  }

  // education: 15 (school 9, degree 3, dates 3); fresher: 20 (school 10, programme 5, graduation date 5)
  var edu = schools(r);
  if (fresher) {
    part(edu.length > 0, 10, 'education', 'add your school, college or university', STEP.education);
    if (edu.length) {
      part(edu.every(function (e) { return hasText(e.degree) || hasText(e.fieldOfStudy); }), 5, 'education_degree', 'add your degree or programme', STEP.education);
      var noGrad = edu.filter(function (e) { return !(e.endDate || e.current); });
      part(!noGrad.length, 5, 'education_dates', 'add your graduation date (or expected) to ' + (noGrad.length === 1 ? label(noGrad[0]) : plural(noGrad.length, 'education entry', 'education entries')), STEP.education);
    }
  } else part(edu.length > 0, 9, 'education', 'add your school, college or university', STEP.education);
  if (edu.length && !fresher) {
    part(edu.every(function (e) { return hasText(e.degree) || hasText(e.fieldOfStudy); }), 3, 'education_degree', 'add your degree or programme', STEP.education);
    var eduNoDates = edu.filter(function (e) { return !hasDates(e); });
    part(!eduNoDates.length, 3, 'education_dates', 'add dates to ' + (eduNoDates.length === 1 ? label(eduNoDates[0]) : plural(eduNoDates.length, 'education entry', 'education entries')), STEP.education);
  }

  // projects: 10 (one 6, description 4); fresher: 15 (one 9, description 6)
  var proj = projects(r);
  part(proj.length > 0, fresher ? 9 : 6, 'projects', fresher ? 'add a project (class, final-year or personal)' : 'add a project (class, personal or work)', STEP.projects);
  if (proj.length) {
    var noDesc = proj.filter(function (p) { return !hasText(p.description, 10); });
    part(!noDesc.length, fresher ? 6 : 4, 'project_description', 'add a line about ' + (noDesc.length === 1 ? 'your project "' + label(noDesc[0]) + '"' : plural(noDesc.length, 'project', 'projects')), STEP.projects);
  }

  // fresher only: activities, leadership, volunteering: 10 (one 7, a line about it 3)
  if (fresher) {
    var acts = activities(r);
    part(acts.length > 0, 7, 'activities', 'add a society, club or volunteer role', STEP.experience, 'activities');
    if (acts.length) {
      var quiet = acts.filter(function (a) { return activityLines(a) === 0; });
      part(!quiet.length, 3, 'activity_lines', 'add a line on what you did' + (quiet.length === 1 ? ' at ' + (str(quiet[0].organisation) || str(quiet[0].role)) : ' in ' + plural(quiet.length, 'activity', 'activities')), STEP.experience, 'activities');
    }
  }

  // skills: 15 (3 points each, up to 5)
  var n = Math.min(5, skills(r).length);
  score += n * 3;
  if (n < 5) missing.push({ key: 'skills', text: 'add ' + plural(5 - n, 'more skill', 'more skills'), step: STEP.skills, points: (5 - n) * 3, stepKey: 'skills' });

  // extras: 5 (any of certifications, languages, achievements; fresher: awards too)
  var extras = list(r.certifications).some(function (c) { return c && hasText(c.name); }) ||
    list(r.languages).some(function (l) { return l && hasText(l.name); }) ||
    list(r.achievements).some(function (a) { return hasText(a); }) ||
    (fresher && list(r.awards).some(function (a) { return a && hasText(a.title); }));
  part(extras, 5, 'extras', fresher ? 'add a certificate, language, award or achievement' : 'add a certificate, language or achievement', STEP.certifications);

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

module.exports = { STEP: STEP, STEP_KEYS: STEP_KEYS, trackOf: trackOf, resumeStrength: resumeStrength, finishErrors: finishErrors, defaultResumeName: defaultResumeName, resumeName: resumeName, pdfFileName: pdfFileName, titleOf: titleOf, fullName: fullName };
