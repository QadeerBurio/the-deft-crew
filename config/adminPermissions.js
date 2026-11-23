// config/adminPermissions.js — the admin permissions the server and the admin portal share, byte for byte
// (server: config/adminPermissions.js, portal: src/portal/adminPermissions.js; a server test checks they are identical).
// Plan Phase A (A-2, A-3). A permission is "area.action": view = read, manage = create / edit, the rest are risky
// actions of their own. GROUPS follow the portal menu groups (safety has its own group, owner).
//   PERMISSIONS        every permission, with its group and a plain-language label
//   TEMPLATES          ready-made roles (the super admin can copy and change them)
//   expand(list)       a list with "area.*" written out
//   describe(list)     "can approve brands and edit offers; can't see student phone numbers" style summary
/* eslint-disable */
var GROUPS = [
  { id: "general", label: "general" },
  { id: "users", label: "users" },
  { id: "student_app", label: "student app" },
  { id: "brands", label: "brands" },
  { id: "employers", label: "employers" },
  { id: "engagement", label: "engagement" },
  { id: "crew", label: "crew" },
  { id: "safety", label: "safety" },
  { id: "data", label: "data" },
  { id: "settings", label: "settings" },
];

var PERMISSIONS = [
  ["dashboard.view", "general", "see the dashboard"],
  ["analytics.view", "general", "see metrics and analytics"],
  ["audit.view", "general", "see admin actions"],
  ["students.view", "users", "see students"],
  ["students.edit", "users", "edit students"],
  ["students.verify", "users", "verify students (sees their ID cards)"],
  ["students.suspend", "users", "suspend or ban accounts"],
  ["students.delete", "users", "delete accounts for good"],
  ["universities.manage", "users", "manage universities"],
  ["cards.manage", "users", "manage tdc cards and their payments"],
  ["jobs.manage", "student_app", "manage jobs"],
  ["scholarships.manage", "student_app", "manage scholarships, exchange programmes and courses"],
  ["events.manage", "student_app", "manage events and tickets"],
  ["travel.manage", "student_app", "manage travel packages and bookings"],
  ["rewards.manage", "student_app", "manage rewards and redemptions"],
  ["brands.view", "brands", "see brands"],
  ["brands.approve", "brands", "approve brands"],
  ["offers.manage", "brands", "manage offers and sliders"],
  ["loyalty.manage", "brands", "manage loyalty programs"],
  ["surplus.manage", "brands", "manage Surprise Box"],
  ["revenue.view", "brands", "see revenue"],
  ["employers.view", "employers", "see employers"],
  ["employers.verify", "employers", "verify companies (sees their documents)"],
  ["hiring.manage", "employers", "manage hiring timelines and plans"],
  ["disputes.manage", "employers", "decide hire disputes"],
  ["ratings.moderate", "employers", "moderate ratings"],
  ["plans.manage", "employers", "manage hiring plans and trials"],
  ["drops.manage", "engagement", "manage daily drops"],
  ["push.send", "engagement", "send pushes to everyone"],
  ["points.award", "engagement", "award or adjust points and badges"],
  ["crew.view", "crew", "see the crew"],
  ["crew.manage", "crew", "manage the crew and campaigns"],
  ["credentials.issue", "crew", "issue credentials"],
  ["safety.view", "safety", "see reports and held posts"],
  ["safety.act", "safety", "decide reports, hide or restore posts, strikes"],
  ["identity.reveal", "safety", "see who wrote an anonymous post"],
  ["pii.view", "data", "see full phone numbers, e-mails and documents"],
  ["data.export", "data", "download CSV files"],
  ["features.manage", "settings", "change feature switches"],
  ["team.manage", "settings", "manage the admin team (super admins only)"],
].map(function (p) { return { key: p[0], group: p[1], label: p[2] }; });

var KEYS = PERMISSIONS.map(function (p) { return p.key; });

function expand(list) {
  var out = [];
  (list || []).forEach(function (k) {
    if (typeof k !== "string") return;
    if (/\.\*$/.test(k)) {
      var area = k.slice(0, -2);
      KEYS.forEach(function (x) { if (x.split(".")[0] === area && out.indexOf(x) < 0) out.push(x); });
    } else if (KEYS.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k);
  });
  return out;
}
var allBut = function (except) { return KEYS.filter(function (k) { return except.indexOf(k) < 0; }); };
var views = KEYS.filter(function (k) { return /\.view$/.test(k) && k !== "pii.view"; });

var TEMPLATES = [
  { id: "super", label: "super admin", level: "super", permissions: KEYS.slice() },
  { id: "core_team", label: "core team", permissions: allBut(["team.manage", "identity.reveal", "students.delete"]) },
  { id: "employer_success", label: "employer success", permissions: expand(["employers.*", "jobs.manage", "hiring.manage", "disputes.manage", "ratings.moderate", "students.view", "dashboard.view"]) },
  { id: "brand_partnerships", label: "brand partnerships", permissions: expand(["brands.*", "offers.manage", "loyalty.manage", "surplus.manage", "revenue.view", "dashboard.view"]) },
  { id: "campus_students", label: "campus & students", permissions: expand(["students.view", "students.edit", "students.verify", "universities.manage", "cards.manage", "crew.*", "events.manage", "scholarships.manage"]) },
  { id: "community_safety", label: "community & safety", permissions: expand(["safety.view", "safety.act", "students.suspend", "drops.manage"]) },
  { id: "growth_marketing", label: "growth & marketing", permissions: expand(["analytics.view", "drops.manage", "push.send", "rewards.manage", "crew.view", "crew.manage"]) },
  { id: "finance", label: "finance", permissions: expand(["revenue.view", "plans.manage", "cards.manage", "data.export"]) },
  { id: "viewer", label: "viewer", permissions: views },
];

function describe(list) {
  var have = expand(list);
  var can = PERMISSIONS.filter(function (p) { return have.indexOf(p.key) >= 0; }).map(function (p) { return p.label; });
  var cant = [];
  if (have.indexOf("pii.view") < 0) cant.push("see full phone numbers, e-mails and documents");
  if (have.indexOf("team.manage") < 0) cant.push("manage the admin team");
  return (can.length ? "can " + can.join("; ") : "can't do anything yet") + (cant.length ? ". can't " + cant.join(" or ") : "") + ".";
}

module.exports = { GROUPS: GROUPS, PERMISSIONS: PERMISSIONS, KEYS: KEYS, TEMPLATES: TEMPLATES, expand: expand, describe: describe };
