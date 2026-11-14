// Feature flag values (config/featureFlags.js): how FLAG_* values are read, however they were typed or pasted,
// and the startup log lines (rule types and counts only, never the ids).
//   node tests/feature-flags/run.js [serverDir]
// No database, no network, no .env: only the flag module, with variables set and restored per check.
const path = require("path");
const fs = require("fs");
const Module = require("module");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
// these checks are about Railway rules / admin rows: no built-in "on" default (as before features-on-by-default)
require(path.join(SERVER, "tests", "hide-user-secrets", "defaults-off"))(reqS("./config/featureFlags"));
for (const k of Object.keys(process.env)) if (/^(FLAG|JOB)_/.test(k) || k === "META_EVENTS_ENABLED") delete process.env[k];
const flags = reqS("./config/featureFlags");

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { ok ? passed++ : failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== "" ? "  (" + detail + ")" : ""}`); };
const withEnv = (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const A = "6a1f00000000000000000aa1", B = "6a1f00000000000000000bb2", C = "6a1f00000000000000000cc3", X = "6a1f00000000000000000ff9";
const on = (value, id, role = "brand") => withEnv({ FLAG_LOYALTY_V2: value }, () => flags.isEnabled("loyaltyV2", { id, role }));
const all = (value, ids) => ids.every((id) => on(value, id));
const none = (value, ids) => ids.every((id) => !on(value, id));

console.log("── the formats that already worked are unchanged");
check("ids:A,B → A and B on, X off", all(`ids:${A},${B}`, [A, B]) && none(`ids:${A},${B}`, [X]));
check("users:A → same as ids:", on(`users:${A}`, A) && !on(`users:${A}`, X));
check("spaces around ids and rules", all(` ids: ${A} , ${B} ; ids:${C} `, [A, B, C]));
check("on / true / 1 / yes → everyone", ["on", "true", "1", "yes", "ON"].every((v) => on(v, X)));
check("off / false / 0 / no → nobody", ["off", "false", "0", "no"].every((v) => !on(v, A)));
check("roles:brand → brands only", on("roles:brand", X, "brand") && !on("roles:brand", X, "student"));
check("rules combine with ;", on(`roles:admin;ids:${B}`, B, "student") && on(`roles:admin;ids:${B}`, X, "admin") && !on(`roles:admin;ids:${B}`, X, "student"));
const pctUsers = Array.from({ length: 2000 }, (_, i) => `user${i}`);
const shareOf = () => withEnv({ FLAG_LOYALTY_V2: "30%" }, () => pctUsers.filter((id) => flags.isEnabled("loyaltyV2", { id })).length) / pctUsers.length;
const share = shareOf();
check("30% → about 30%, the same users every time", share > 0.25 && share < 0.35 && shareOf() === share, share);
check("signed out never matches ids or %", !withEnv({ FLAG_LOYALTY_V2: `ids:${A};100%` }, () => flags.isEnabled("loyaltyV2", null)));
check("an unreadable value keeps the default (off)", !on("yes please", A) && !on("loyalty for alpha", A));
check("not set → the default (off)", withEnv({ FLAG_LOYALTY_V2: null }, () => !flags.isEnabled("loyaltyV2", { id: A })));
check("a flag that defaults to on stays on when unreadable (domainEvents)", withEnv({ FLAG_DOMAIN_EVENTS: "whatever" }, () => flags.isEnabled("domainEvents", null)));
check("the older META_EVENTS_ENABLED still works", withEnv({ META_EVENTS_ENABLED: "true" }, () => flags.isEnabled("metaEvents", null)));

console.log("── quotes");
check('"ids:A,B" (double quotes around the value)', all(`"ids:${A},${B}"`, [A, B]) && none(`"ids:${A},${B}"`, [X]));
check("'ids:A' (single quotes)", on(`'ids:${A}'`, A));
check('ids:"A","B" (quotes around each id)', all(`ids:"${A}","${B}"`, [A, B]));
check("ids:'A', 'B'", all(`ids:'${A}', '${B}'`, [A, B]));
check("typographic quotes from a phone or a doc", on(`“ids:${A}”`, A));
check('"on" → everyone', on('"on"', X));
check('quotes around each rule: "ids:A";"ids:B"', all(`"ids:${A}";"ids:${B}"`, [A, B]));

console.log("── line breaks");
check("ids on separate lines", all(`ids:${A}\n${B}\n${C}`, [A, B, C]) && none(`ids:${A}\n${B}`, [X]));
check("Windows line breaks", all(`ids:${A}\r\n${B}`, [A, B]));
check("ids separated by spaces", all(`ids:${A} ${B}  ${C}`, [A, B, C]));
check("rules on separate lines", on(`roles:admin\nids:${B}`, B, "student") && on(`roles:admin\nids:${B}`, X, "admin"));
check("a trailing line break or ;", on(`ids:${A}\n`, A) && on(`ids:${A};`, A));

console.log("── two Copy ids outputs pasted together");
check("one under the other", all(`ids:${A},${B}\nids:${C}`, [A, B, C]) && none(`ids:${A},${B}\nids:${C}`, [X]));
check("with ; between them", all(`ids:${A},${B};ids:${C}`, [A, B, C]));
check("each in quotes, one per line", all(`"ids:${A},${B}"\n"ids:${C}"`, [A, B, C]));
check("side by side with only a space", all(`ids:${A},${B} ids:${C}`, [A, B, C]) && none(`ids:${A},${B} ids:${C}`, [X]));

console.log("── empty values");
check("empty → default (off)", !on("", A));
check("only spaces / line breaks → default", !on("  \n ", A));
check('only quotes "" → default', !on('""', A));
check('"ids:" with no ids → nobody', !on("ids:", A) && !on("ids:", X));

console.log("── startup log lines: types and counts, never ids");
const lines = withEnv({ FLAG_LOYALTY_V2: `"ids:${A},${B}"\nids:${C},${A}`, FLAG_SURPLUS_BOXES: "loyalty for alpha", FLAG_META_EVENTS: "roles:admin;10%", FLAG_CAREER_TIMELINE: "", FLAG_DOMAIN_EVENTS: null, FLAG_CAREER_RATINGS: `ids:${A};nonsense`, FLAG_CAREER_MATCHING: "on" }, () => flags.describeFlags());
const line = (name) => lines.find((l) => l.startsWith(`[flags] ${name}:`));
check("one line per flag", lines.length === Object.keys(flags.FLAGS).length && lines.every((l) => l.startsWith("[flags] FLAG_")), lines.length);
check("ids counted once each: '3 ids'", line("FLAG_LOYALTY_V2") === "[flags] FLAG_LOYALTY_V2: 3 ids", line("FLAG_LOYALTY_V2"));
check("unreadable: 'unreadable value, using off'", line("FLAG_SURPLUS_BOXES") === "[flags] FLAG_SURPLUS_BOXES: unreadable value, using off", line("FLAG_SURPLUS_BOXES"));
check("% and roles: '10% of users, 1 role'", line("FLAG_META_EVENTS") === "[flags] FLAG_META_EVENTS: 10% of users, 1 role", line("FLAG_META_EVENTS"));
check("empty: 'empty, using off'", line("FLAG_CAREER_TIMELINE") === "[flags] FLAG_CAREER_TIMELINE: empty, using off", line("FLAG_CAREER_TIMELINE"));
check("not set, default on: 'not set, using on'", line("FLAG_DOMAIN_EVENTS") === "[flags] FLAG_DOMAIN_EVENTS: not set, using on", line("FLAG_DOMAIN_EVENTS"));
check("not set, default off: 'not set, using off'", line("FLAG_RESUME_STUDIO_V2") === "[flags] FLAG_RESUME_STUDIO_V2: not set, using off", line("FLAG_RESUME_STUDIO_V2"));
check("on: 'on for everyone'", line("FLAG_CAREER_MATCHING") === "[flags] FLAG_CAREER_MATCHING: on for everyone", line("FLAG_CAREER_MATCHING"));
check("partly unreadable: the bad rule is reported", line("FLAG_CAREER_RATINGS") === "[flags] FLAG_CAREER_RATINGS: 1 id; 1 unreadable rule ignored", line("FLAG_CAREER_RATINGS"));
check("no id appears in any line", !lines.some((l) => [A, B, C].some((id) => l.includes(id))));
check("server.js prints them at startup", /for \(const line of describeFlags\(\)\) console\.log\(line\);/.test(fs.readFileSync(path.join(SERVER, "server.js"), "utf8")));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
