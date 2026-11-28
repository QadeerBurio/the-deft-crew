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

// ======================================================================================================================
// "Resume strength" v2 (resume full fix, behind resumeV2): scored on content depth, not on filled fields, plus how full
// the single page is. resumeStrength above stays exactly as it was (it is completionPercentage, which the 1.2.x app
// shows); this one is stored as resume.strength.
//   resumeStrengthV2(resume, page?) -> { score 0-100, label, sections: [{ key, label, points, got, ok, optional }],
//                                        gaps: [gap], suggestions: [gap], page: { fill, pages, measured, advice } }
//     page: { fill (0..n, 1 = exactly one full page), pages } from the real preview; missing = not measured yet
//   gap: { key, section, step, stepKey, required, text, why, example: { fresher, experienced }, waivable, need }
//   gapsFor(resume, stepKey, page?) -> the required gaps of one builder step (the "continue" block)
// 100% only when every minimum is met AND the page is measured, one page, at least FILL_TARGET full.
// "I really don't have this" (settings.waived): the item then counts as met once a fresher alternative is added
// (see ALTERNATIVES); a waiver alone never meets anything.
// ======================================================================================================================
var FILL_TARGET = 0.85;
var VERBS = ('achieved,analysed,analyzed,arranged,assisted,automated,built,calculated,coached,collaborated,collected,completed,conducted,configured,' +
  'coordinated,created,debugged,delivered,deployed,designed,developed,drafted,edited,engaged,engineered,established,evaluated,executed,' +
  'facilitated,filmed,founded,gathered,generated,grew,guided,handled,helped,hosted,identified,implemented,improved,increased,initiated,' +
  'installed,integrated,interviewed,introduced,launched,led,maintained,managed,mapped,marketed,measured,mentored,migrated,moderated,' +
  'monitored,negotiated,operated,optimised,optimized,organised,organized,painted,performed,photographed,planned,prepared,presented,' +
  'processed,produced,programmed,promoted,prototyped,published,raised,recorded,recruited,redesigned,reduced,represented,researched,' +
  'resolved,reviewed,ran,saved,scheduled,served,set,shipped,shot,simplified,sold,solved,started,streamlined,supervised,supported,surveyed,' +
  'taught,tested,trained,translated,tutored,volunteered,won,wrote,answered,cooked,cleaned,drove,packed,donated,captained,competed,debated,' +
  'directed,co-organised,co-organized,co-founded,co-led,modelled,modeled,sketched,styled,treated,assessed,diagnosed,examined,documented,' +
  'audited,budgeted,forecast,forecasted,reconciled,closed,pitched,secured,acquired,converted,expanded,boosted,cut,lowered,ranked,scored,' +
  'organise,organize,lead,manage,build,create,teach,run,write,help,design,develop,plan,host,sell,handle,coordinate,support,tutor,present,' +
  'maintain,test,serve,research,analyse,analyze,train,mentor,deliver,prepare,review').split(',');
var VERB_SET = {};
VERBS.forEach(function (v) { VERB_SET[v] = true; });
// words that show an outcome when there is no number (a number is always a result)
var RESULT_RE = /\d|\b(won|winner|ranked|first|second|third|selected|awarded|approved|adopted|launched|deployed|published|used by|graded|grade|cgpa|a\+|top|finalist|shortlisted|increased|reduced|improved|saved|grew|cut|boosted|faster|fewer|more|less|completed|delivered|on time|before the deadline|praised|recognised|recognized|featured|presented to|accepted|passed|certified|hired|promoted|record|achieved)\b/i;
var BULLET_MARK = /^\s*[-•*▪◦]\s*/;

function words(t) { return str(t).split(/\s+/).filter(Boolean); }
function firstWordOf(t) { var m = str(t).replace(BULLET_MARK, '').match(/^[A-Za-z-]+/); return m ? m[0].toLowerCase() : ''; }
/** a strong line: an action verb first, and enough words to say what */
function strongLine(t) { var w = firstWordOf(t); return words(t).length >= 5 && (VERB_SET[w] === true || /ed$/.test(w)); }
function resultIn(t) { return RESULT_RE.test(str(t)); }
// the lines of one entry (bullets the student kept, plus each line of the description)
function linesOf(entry, key) {
  var e = entry || {};
  var out = list(e[key]).map(str).filter(Boolean);
  str(e.description).split(/\n+/).map(function (l) { return str(l.replace(BULLET_MARK, '')); }).filter(Boolean).forEach(function (l) { out.push(l); });
  return out;
}
function settingsOf(r) { return (r && r.settings) || {}; }
function waived(r, key) { return list(settingsOf(r).waived).indexOf(key) >= 0; }
function targetRoleOf(r) {
  return str((r.targetJob && r.targetJob.jobTitle) || (list(r.targetJobs)[0] && list(r.targetJobs)[0].jobTitle)) || titleOf(r);
}
var SKILL_GROUPS = ['technical', 'tools', 'soft'];
function skillName(s) { return str(typeof s === 'string' ? s : s && s.name); }
function skillGroup(s) { var g = str(s && typeof s === 'object' ? s.group : '').toLowerCase(); return SKILL_GROUPS.indexOf(g) >= 0 ? g : ''; }
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// examples and reasons for each gap: one line why, a fresher and an experienced example
var GAP_TEXT = {
  name: { why: 'a recruiter can\'t shortlist a resume without a name.', fresher: 'Ayesha Khan', experienced: 'Bilal Ahmed' },
  email: { why: 'it is how most employers reply.', fresher: 'ayesha.khan@gmail.com', experienced: 'bilal.ahmed@outlook.com' },
  phone: { why: 'Pakistani recruiters often call or WhatsApp first.', fresher: '+92 300 1234567', experienced: '+92 321 7654321' },
  city: { why: 'employers filter by city for on-site roles.', fresher: 'Lahore', experienced: 'Karachi' },
  linkedin: { why: 'most recruiters open your LinkedIn next.', fresher: 'linkedin.com/in/ayesha-khan', experienced: 'linkedin.com/in/bilal-ahmed' },
  summary: { why: 'it is the first thing read: 2–3 lines on who you are and the role you want.', fresher: 'Final-year BBA student at IBA who ran the marketing society\'s Instagram. Looking for a marketing internship to grow brand pages.', experienced: 'Backend engineer with 2 years on payments at a fintech. Looking for a senior backend role building reliable APIs.' },
  summary_role: { why: 'a summary aimed at the job you want gets read; a general one gets skipped.', fresher: '…looking for a marketing internship.', experienced: '…looking for a senior backend engineer role.' },
  education: { why: 'for students, education is the first section a recruiter checks.', fresher: 'BBA, IBA Karachi, 2022 – 2026', experienced: 'BS Computer Science, FAST Lahore, 2018 – 2022' },
  education_degree: { why: 'the degree tells them what you studied.', fresher: 'BBA (Marketing)', experienced: 'BS Computer Science' },
  education_dates: { why: 'internship screeners look for your graduation year first.', fresher: '2022 – 2026 (expected)', experienced: '2018 – 2022' },
  education_extra: { why: 'one achievement or a few relevant courses make your degree specific.', fresher: 'Dean\'s list (2 semesters); courses: Digital Marketing, Consumer Behaviour', experienced: 'Final-year project on fraud detection (grade A)' },
  experience: { why: 'experienced resumes are read for what you did at work.', fresher: 'Tutor (part-time): taught O level maths to 3 students', experienced: 'Backend Engineer, Sample Payments, Jul 2024 – Present' },
  experience_bullets: { why: '2–4 lines per role show what you did; one line looks thin.', fresher: 'Taught O level maths to 3 students and prepared weekly tests', experienced: 'Built the refunds service used by 40 merchants' },
  experience_strong: { why: 'lines that start with a verb and say what you did are read in seconds.', fresher: 'Handled 30+ customers a day at the family pharmacy counter', experienced: 'Cut checkout errors by a third by adding retries to the payment API' },
  experience_result: { why: 'a result or a number makes a line believable.', fresher: '…for 3 students, all of whom passed', experienced: '…cutting response time from 2 s to 300 ms' },
  projects: { why: 'projects show what you can do when you have little work experience.', fresher: 'Campus Ride (final-year project): a React Native app that matches students going the same way', experienced: 'Budget Bot: a chat bot that tracks monthly spending' },
  project_detail: { why: 'say what it is, the tools you used and what came of it.', fresher: 'Built with React Native and Firebase; used by 120 students in the first month', experienced: 'Node.js and PostgreSQL; handles 2,000 messages a day' },
  skills: { why: 'portals match your skills to the job; 6 or more, grouped, read clearly.', fresher: 'Technical: Excel, SQL · Tools: Canva, Google Analytics · Soft: teamwork, presenting', experienced: 'Technical: Node.js, PostgreSQL · Tools: Docker, AWS · Soft: mentoring' },
  skills_groups: { why: 'grouping (technical / tools / soft) makes skills easy to scan.', fresher: 'Tools: Canva, Figma', experienced: 'Soft: code review, mentoring' },
  skills_backed: { why: 'a skill you used in a project or job is believed; a list alone isn\'t.', fresher: 'Excel → used in your sales survey project', experienced: 'Docker → used in your deployment work' },
  page_fill: { why: 'a half-empty page looks like there is little to say; fill one full page.', fresher: 'add 2 bullets to your society role and 1 project', experienced: 'add 2 bullets to your latest role' },
  page_over: { why: 'internship and graduate screeners expect one page.', fresher: 'use "fit on one page": tighter spacing first, then shorter lines', experienced: 'use "fit on one page": tighter spacing first, then shorter lines' },
  page_unmeasured: { why: 'we measure your real page to tell you how full it is.', fresher: 'open the preview once', experienced: 'open the preview once' },
  extras: { why: 'certificates, activities, awards and languages fill out a student resume.', fresher: 'Google Data Analytics certificate (Coursera); Urdu and English', experienced: 'AWS Cloud Practitioner (2024)' },
  activities: { why: 'societies and teams show leadership and teamwork.', fresher: 'Marketing lead, Business Society: ran the Instagram and organised welcome week for 300 students', experienced: 'Mentor, Google Developer Student Club' },
};
// what counts instead when the student really doesn't have it (fresher alternatives)
var ALTERNATIVES = {
  experience: 'a class project, a society role, freelance / Fiverr work, the family business, tuition or a hackathon: each with 2 lines on what you did',
  projects: 'a society role, volunteering, freelance or tuition work, or a competition: each with 2 lines on what you did',
  education_extra: 'a relevant course, a grade or CGPA, or an award',
};
// a role / activity / project with at least 2 lines: it can stand in for a missing item
function solidEntries(r) {
  var n = 0;
  list(r.activities).concat(list(r.volunteering)).forEach(function (a) { if (a && (hasText(a.organisation) || hasText(a.role)) && linesOf(a, 'bullets').length >= 2) n += 1; });
  list(r.awards).forEach(function (a) { if (a && hasText(a.title)) n += 1; });
  return n;
}

function resumeStrengthV2(resume, page) {
  var r = resume || {};
  var pi = r.personalInfo || {};
  var fresher = trackOf(r) === 'fresher';
  var sections = [];
  var gaps = [];
  var suggestions = [];
  function gap(key, section, required, text, extra) {
    var t = GAP_TEXT[key] || GAP_TEXT[section] || {};
    var g = { key: key, section: section, step: STEP[section] || null, stepKey: section, required: !!required, text: text, why: t.why || '', example: { fresher: t.fresher || '', experienced: t.experienced || '' }, waivable: !!ALTERNATIVES[key] };
    if (g.waivable) g.alternative = ALTERNATIVES[key];
    if (extra) for (var k in extra) g[k] = extra[k];
    (required ? gaps : suggestions).push(g);
    return g;
  }
  function sec(key, label, points, checks, optional) {
    var total = checks.length || 1;
    var met = checks.filter(Boolean).length;
    sections.push({ key: key, label: label, points: points, got: Math.round(points * met / total * 10) / 10, ok: met === total, optional: !!optional });
  }
  var W = fresher ? { contact: 10, summary: 10, education: 20, experience: 0, projects: 30, skills: 20, page: 10 }
    : { contact: 10, summary: 10, education: 10, experience: 25, projects: 15, skills: 20, page: 10 };

  // contact: name, email, phone, city (LinkedIn optional)
  var c = [!!fullName(r), hasText(pi.email), hasText(pi.phone), hasText(pi.city) || hasText(pi.location)];
  if (!c[0]) gap('name', 'personal', true, 'add your full name');
  if (!c[1]) gap('email', 'personal', true, 'add your email');
  if (!c[2]) gap('phone', 'personal', true, 'add your phone number');
  if (!c[3]) gap('city', 'personal', true, 'add your city');
  if (!hasText(pi.linkedin)) gap('linkedin', 'personal', false, 'add your LinkedIn (optional)');
  sec('personal', 'contact', W.contact, c);

  // summary: 2–3 lines (about 120–450 characters), aimed at the role they want
  var summaryText = str(r.professionalSummary && r.professionalSummary.summary);
  var role = targetRoleOf(r);
  var roleWords = role.toLowerCase().split(/[^a-z]+/).filter(function (w) { return w.length > 3; });
  var sLen = summaryText.length >= 120 && summaryText.length <= 480;
  var sRole = !!role && roleWords.some(function (w) { return summaryText.toLowerCase().indexOf(w) >= 0; });
  if (!summaryText) gap('summary', 'summary', true, 'add a 2–3 line summary');
  else if (!sLen) gap('summary', 'summary', true, summaryText.length < 120 ? 'make your summary 2–3 lines (it is ' + plural(Math.max(1, Math.ceil(summaryText.length / 95)), 'line', 'lines') + ' now)' : 'shorten your summary to 2–3 lines');
  if (summaryText && !sRole) gap('summary_role', 'summary', true, role ? 'name the role you want ("' + role + '") in your summary' : 'pick the job you want, then aim your summary at it');
  sec('summary', 'summary', W.summary, [!!summaryText && sLen, sRole]);

  // education: degree, institute, years, plus 1–2 achievements or relevant courses (CGPA optional)
  var edu = schools(r);
  var e0 = [edu.length > 0, edu.length > 0 && edu.every(function (e) { return hasText(e.institution) && (hasText(e.degree) || hasText(e.fieldOfStudy)); }),
    edu.length > 0 && edu.every(function (e) { return !!(e.startDate || e.endDate || e.current); })];
  var eduExtra = edu.some(function (e) { return linesOf(e, 'achievements').length > 0; }) || list(r.coursework).filter(function (x) { return hasText(x); }).length > 0;
  var eduAlt = waived(r, 'education_extra') && (edu.some(function (e) { return hasText(e.grade) || !!e.gpa; }) || list(r.awards).some(function (a) { return a && hasText(a.title); }));
  e0.push(eduExtra || eduAlt);
  if (!e0[0]) gap('education', 'education', true, 'add your school, college or university');
  else {
    if (!e0[1]) gap('education_degree', 'education', true, 'add the degree and institute to every education entry');
    if (!e0[2]) gap('education_dates', 'education', true, 'add the years (start and finish, or expected) to your education');
    if (!e0[3]) gap('education_extra', 'education', true, waived(r, 'education_extra') ? 'add ' + ALTERNATIVES.education_extra + ' instead' : 'add 1–2 achievements or relevant courses to your education');
    if (!edu.some(function (e) { return hasText(e.grade) || !!e.gpa; })) gap('education_grade', 'education', false, 'add your CGPA or marks (optional)');
  }
  sec('education', 'education', W.education, e0);

  // experience: each role 2–4 lines, each an action verb + what, at least one with a result or number
  var jobs = work(r);
  var expChecks = [];
  if (!jobs.length) {
    var alt = waived(r, 'experience') && solidEntries(r) + Math.max(0, projects(r).length - (fresher ? 2 : 1)) >= 1;
    if (!fresher) {
      expChecks.push(alt);
      if (!alt) gap('experience', 'experience', true, waived(r, 'experience') ? 'add ' + ALTERNATIVES.experience : 'add an internship, job or volunteer role');
    } else gap('experience', 'experience', false, 'add an internship, part-time job, tuition or freelance work (optional)');
  } else {
    jobs.forEach(function (w) {
      var ls = linesOf(w, 'achievements');
      var name = label(w);
      var nBul = ls.length >= 2;
      var nStrong = ls.length > 0 && ls.every(strongLine);
      var nResult = ls.some(resultIn);
      expChecks.push(nBul, nStrong, nResult, hasDates(w));
      if (!nBul) gap('experience_bullets', 'experience', true, 'add ' + plural(2 - ls.length, 'more line', 'more lines') + ' to ' + name, { need: 2 - ls.length, entry: name });
      else if (!nStrong) gap('experience_strong', 'experience', true, 'start each line at ' + name + ' with what you did (a verb like built, led, handled)', { entry: name });
      if (ls.length && !nResult) gap('experience_result', 'experience', true, 'add a result or a number to one line at ' + name, { entry: name });
      if (!hasDates(w)) gap('experience_dates', 'experience', true, 'add dates to ' + name, { entry: name });
      if (ls.length > 4) gap('experience_trim', 'experience', false, 'keep 2–4 lines at ' + name + ' (it has ' + ls.length + ')', { entry: name });
    });
  }
  if (W.experience) sec('experience', 'experience', W.experience, expChecks.length ? expChecks : [false]);

  // projects: at least 2 for freshers, 1 with experience; each: what it is, tools used and a result
  var need = fresher ? 2 : 1;
  var proj = projects(r);
  var good = proj.filter(function (p) { var d = linesOf(p, 'bullets').join(' '); return d.length >= 30 && list(p.technologies).filter(function (x) { return hasText(x); }).length > 0 && resultIn(d); });
  var stand = waived(r, 'projects') ? Math.min(need, solidEntries(r)) : 0;
  var pChecks = [proj.length + stand >= need];
  proj.forEach(function (p) {
    var d = linesOf(p, 'bullets').join(' ');
    var tools = list(p.technologies).filter(function (x) { return hasText(x); }).length > 0;
    var ok = d.length >= 30 && tools && resultIn(d);
    pChecks.push(ok);
    if (!ok) {
      var miss = [d.length < 30 ? 'what it is' : '', tools ? '' : 'the tools you used', resultIn(d) ? '' : 'a result'].filter(Boolean);
      gap('project_detail', 'projects', true, 'add ' + miss.join(', ').replace(/, ([^,]*)$/, ' and $1') + ' to "' + label(p) + '"', { entry: label(p) });
    }
  });
  if (proj.length + stand < need) {
    var short = need - proj.length - stand;
    gap('projects', 'projects', true, waived(r, 'projects') ? 'add ' + ALTERNATIVES.projects : 'add ' + plural(short, 'more project', 'more projects') + ' to continue', { need: short });
  }
  if (!good.length && !proj.length) pChecks.push(false);
  sec('projects', 'projects', W.projects, pChecks);

  // skills: at least 6, grouped (technical / tools / soft), at least 2 used in a project or a job
  var sk = skills(r);
  var groups = {};
  sk.forEach(function (s) { var g = skillGroup(s); if (g) groups[g] = true; });
  var used = (list(r.projects).map(function (p) { return [str(p && p.name), list(p && p.technologies).join(' '), linesOf(p, 'bullets').join(' ')].join(' '); })
    .concat(list(r.workExperience).map(function (w) { return linesOf(w, 'achievements').join(' ') + ' ' + str(w && w.position); }))
    .concat(list(r.activities).concat(list(r.volunteering)).map(function (a) { return linesOf(a, 'bullets').join(' '); }))).join('\n').toLowerCase();
  var backed = sk.filter(function (s) { var n = skillName(s).toLowerCase(); return n.length > 1 && new RegExp('(^|[^a-z0-9+#])' + esc(n) + '($|[^a-z0-9+#])').test(used); }).length;
  var skChecks = [sk.length >= 6, Object.keys(groups).length >= 2, backed >= 2];
  if (!skChecks[0]) gap('skills', 'skills', true, 'add ' + plural(6 - sk.length, 'more skill', 'more skills') + ' (6 or more)', { need: 6 - sk.length });
  if (!skChecks[1]) gap('skills_groups', 'skills', true, 'group your skills: technical, tools and soft (at least 2 groups)');
  if (!skChecks[2]) gap('skills_backed', 'skills', true, 'use ' + plural(2 - backed, 'more skill', 'more skills') + ' in a project or job line, so it is backed', { need: 2 - backed });
  sec('skills', 'skills', W.skills, skChecks);

  // extras: suggestions only, never block
  var hasExtra = list(r.certifications).some(function (x) { return x && hasText(x.name); }) || list(r.languages).some(function (x) { return x && hasText(x.name); }) || list(r.awards).some(function (x) { return x && hasText(x.title); });
  if (!hasExtra) gap('extras', 'certifications', false, 'add a certificate, award or the languages you speak (optional)');
  if (fresher && !activities(r).length) gap('activities', 'activities', false, 'add a society, club, team or volunteer role (optional)');
  sections.push({ key: 'extras', label: 'extras', points: 0, got: 0, ok: hasExtra, optional: true });

  // the page: measured from the real preview; one page, at least FILL_TARGET full
  var p = page && typeof page.fill === 'number' && isFinite(page.fill) ? { fill: Math.max(0, page.fill), pages: Math.max(1, Math.round(page.pages || Math.ceil(page.fill) || 1)), measured: true } : { fill: null, pages: null, measured: false };
  var pageOk = p.measured && p.pages === 1 && p.fill >= FILL_TARGET && p.fill <= 1.0001;
  var advice = '';
  if (!p.measured) gap('page_unmeasured', 'page', true, 'open the preview so we can measure your page');
  else if (p.pages > 1 || p.fill > 1.0001) gap('page_over', 'page', true, 'your resume runs onto ' + plural(Math.max(2, p.pages), 'page', 'pages') + ': fit it on one page', { fit: true });
  else if (p.fill < FILL_TARGET) {
    advice = fillAdvice(r, p.fill);
    gap('page_fill', 'page', true, 'your resume fills ' + Math.round(p.fill * 100) + '% of the page: ' + advice, { advice: advice });
  }
  sections.push({ key: 'page', label: 'page fill', points: W.page, got: p.measured ? (pageOk ? W.page : Math.round(W.page * Math.min(1, p.fill / FILL_TARGET) * 10) / 10 * (p.pages > 1 ? 0.5 : 1)) : 0, ok: pageOk, optional: false });

  var score = sections.reduce(function (a, s) { return a + s.got; }, 0);
  score = Math.round(Math.max(0, Math.min(100, score)));
  if (gaps.length && score > 95) score = 95;
  if (!gaps.length) score = 100;
  return { score: score, label: score >= 100 ? 'ready' : score >= 80 ? 'strong' : score >= 50 ? 'good start' : 'needs more', sections: sections, gaps: gaps, suggestions: suggestions, page: { fill: p.fill, pages: p.pages, measured: p.measured, advice: advice } };
}

// what to add, and how much, to fill the page (each addition roughly in lines of a typical template)
function fillAdvice(resume, fill) {
  var r = resume || {};
  var missing = Math.ceil(Math.max(0, FILL_TARGET - (fill || 0)) * 58); // ~58 text lines on an A4 page at 10 pt
  if (!missing) return '';
  var out = [];
  function add(text, lines) { if (missing <= 0) return; out.push(text); missing -= lines; }
  var fresher = trackOf(r) === 'fresher';
  var thin = work(r).concat(list(r.activities)).filter(function (e) { return e && linesOf(e, e.company !== undefined || e.position !== undefined ? 'achievements' : 'bullets').length < 3; });
  thin.slice(0, 2).forEach(function (e) {
    var have = linesOf(e, e.company !== undefined || e.position !== undefined ? 'achievements' : 'bullets').length;
    var n = Math.min(2, 3 - have);
    if (n > 0) add('add ' + plural(n, 'bullet', 'bullets') + ' to ' + (label(e) || str(e.organisation) || 'your role'), n * 1.3);
  });
  var pCount = projects(r).length;
  if (pCount < 3) add('add ' + (missing > 6 && pCount < 2 ? '2 projects' : '1 project'), missing > 6 && pCount < 2 ? 7 : 3.5);
  if (!activities(r).length) add('add a society or volunteer role with 2 lines', 4);
  if (skills(r).length < 9) add('add ' + (9 - skills(r).length) + ' more skills', 1.5);
  if (!list(r.certifications).length) add('add a certificate', 1.5);
  if (!list(r.languages).length) add('add the languages you speak', 1.2);
  if (missing > 0 && !fresher) add('add another line to each role', 3);
  if (!out.length) out.push('add a little more detail to your projects');
  out = out.slice(0, 3);
  return out.join(', ').replace(/, ([^,]*)$/, ' and $1') + ' to fill the page';
}

// the required gaps of one builder step: what blocks "continue" on that step (page gaps belong to the final check)
function gapsFor(resume, stepKey, page) {
  var g = resumeStrengthV2(resume, page).gaps;
  var map = { personal: ['personal'], summary: ['summary'], education: ['education'], experience: ['experience'], projects: ['projects'], skills: ['skills'] };
  var keys = map[stepKey] || [];
  return g.filter(function (x) { return keys.indexOf(x.section) >= 0; });
}

module.exports = { STEP: STEP, STEP_KEYS: STEP_KEYS, trackOf: trackOf, resumeStrength: resumeStrength, finishErrors: finishErrors, defaultResumeName: defaultResumeName, resumeName: resumeName, pdfFileName: pdfFileName, titleOf: titleOf, fullName: fullName,
  resumeStrengthV2: resumeStrengthV2, gapsFor: gapsFor, fillAdvice: fillAdvice, FILL_TARGET: FILL_TARGET, VERBS: VERBS, strongLine: strongLine, resultIn: resultIn, linesOf: linesOf, SKILL_GROUPS: SKILL_GROUPS, ALTERNATIVES: ALTERNATIVES, GAP_TEXT: GAP_TEXT };
