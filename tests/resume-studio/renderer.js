// ATS Classic renderer: text extracts in reading order (pdftotext, when installed), dates under their
// headings, clickable links, DRAFT only on previews, freshers get projects first, no heading stranded
// at the bottom of a page. No database, no network.
//   node tests/resume-studio/renderer.js [serverDir]
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const reqS = require("module").createRequire(path.join(SERVER, "server.js"));
const { render, RENDERER_VERSION } = require(path.join(SERVER, "services", "resumeStudio", "renderer"));
const { contentOf } = require(path.join(SERVER, "services", "resumeStudio", "facts"));

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : `  -> ${extra}`}`); };

const base = {
  personalInfo: { firstName: "Ayesha", lastName: "Khan", title: "Frontend Developer", email: "ayesha@example.com", phone: "+92 300 0000000", location: "Karachi", linkedin: "linkedin.com/in/ayesha", github: "https://github.com/ayesha" },
  professionalSummary: { summary: "Computer science student who builds web apps with React and Node.js \u2014 \u201cfast\u201d and accessible." },
  workExperience: [{ company: "Bright Labs", position: "Frontend Intern", location: "Karachi", startDate: "2025-06-01", endDate: "2025-08-31", description: "Worked on the customer dashboard.", achievements: ["Built a React page for order tracking", "Fixed 12 layout bugs"] }],
  education: [{ institution: "NED University", degree: "BS", fieldOfStudy: "Computer Science", startDate: "2022-09-01", endDate: "2026-06-30", gpa: "3.6" }],
  projects: [{ name: "Campus Eats", description: "A food ordering web app.", technologies: ["React", "MongoDB"], url: "campuseats.example.com" }],
  skills: [{ name: "JavaScript" }, { name: "React" }],
  certifications: [{ name: "AWS Cloud Practitioner", organization: "Amazon", issueDate: "2025-01-01", credentialUrl: "https://aws.example.com/cert/1" }],
  languages: [{ name: "English", proficiency: "Fluent" }],
};
const long = () => {
  const r = JSON.parse(JSON.stringify(base));
  r.workExperience = Array.from({ length: 9 }, (_, i) => ({ company: `Company ${i + 1}`, position: `Role ${i + 1}`, location: "Lahore", startDate: `20${10 + i}-01-01`, endDate: `20${11 + i}-01-01`, description: "Long description of the work done in this role, with enough words to wrap over more than one line of the page.", achievements: Array.from({ length: 4 }, (_, j) => `Achievement ${j + 1} of role ${i + 1}, written out at a realistic length so that it wraps.`) }));
  return r;
};

const pdftotext = (() => {
  for (const p of ["pdftotext", "/mingw64/bin/pdftotext", "C:/Program Files/Git/mingw64/bin/pdftotext.exe"]) {
    const r = require("child_process").spawnSync(p, ["-v"], { stdio: "ignore" });
    if (!r.error) return p; // "-v" exits non-zero on some builds; only a missing binary is an error
  }
  return null;
})();
const textOf = (buf) => {
  const f = path.join(os.tmpdir(), `rs-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, buf);
  try { return execFileSync(pdftotext, [f, "-"], { encoding: "utf8" }); } finally { fs.unlinkSync(f); }
};
const ordered = (text, parts) => {
  let at = -1;
  for (const p of parts) { const i = text.indexOf(p, at + 1); if (i < 0) return `missing "${p}"`; at = i; }
  return true;
};

(async () => {
  const mod = await reqS("pdf.js-extract");
  const PDFExtract = mod.PDFExtract || mod;
  const extract = async (buf) => new PDFExtract().extractBuffer(buf, {});

  const content = contentOf(base);
  const approved = await render(content);
  const preview = await render(content, { draft: true });
  check("renders a PDF buffer", Buffer.isBuffer(approved) && approved.slice(0, 5).toString() === "%PDF-");
  check("renderer version recorded", /^ats-classic-\d+$/.test(RENDERER_VERSION));
  const raw = approved.toString("latin1");
  check("links are clickable (URI annotations)", ["mailto:ayesha@example.com", "https://linkedin.com/in/ayesha", "https://github.com/ayesha", "https://campuseats.example.com", "https://aws.example.com/cert/1"].every((u) => raw.includes(`/URI (${u})`)));

  const pa = await extract(approved);
  const pp = await extract(preview);
  const words = (d) => d.pages.map((p) => p.content.map((c) => c.str).join("")).join("\n");
  check("approved version has no DRAFT label", !/DRAFT/.test(words(pa)));
  check("preview has the DRAFT label", /DRAFT - not approved/.test(words(pp)));
  check("smart quotes and dashes come out as plain text (no lost glyphs)", words(pa).includes('React and Node.js - "fast" and accessible.') && !words(pa).includes("\ufffd"));
  const dateItem = pa.pages[0].content.find((c) => c.str.includes("Jun 2025 - Aug 2025"));
  check("dates are left-aligned under the heading (not a right column)", dateItem && dateItem.x < 100, JSON.stringify(dateItem));

  if (pdftotext) {
    const t = textOf(approved);
    check("pdftotext: reading order header > summary > experience > skills > projects > education",
      ordered(t, ["Ayesha Khan", "SUMMARY", "EXPERIENCE", "Frontend Intern, Bright Labs", "Jun 2025 - Aug 2025", "Built a React page", "SKILLS", "PROJECTS", "Campus Eats", "EDUCATION", "NED University"]) === true, ordered(t, ["Ayesha Khan", "SUMMARY", "EXPERIENCE", "Frontend Intern, Bright Labs", "Jun 2025 - Aug 2025", "Built a React page", "SKILLS", "PROJECTS", "Campus Eats", "EDUCATION", "NED University"]));
    const f = textOf(await render(contentOf({ ...base, workExperience: [] })));
    check("pdftotext: fresher gets projects and education before skills", ordered(f, ["SUMMARY", "PROJECTS", "EDUCATION", "SKILLS"]) === true && !f.includes("EXPERIENCE"));
  } else {
    console.log("SKIP  pdftotext not installed: reading-order checks skipped");
  }

  const big = await extract(await render(contentOf(long()), { draft: true }));
  check("long resume breaks onto more pages", big.pages.length >= 2, String(big.pages.length));
  check("every page of a preview has the DRAFT label", big.pages.every((p) => p.content.some((c) => c.str.includes("DRAFT"))));
  const pageH = big.pages[0].pageInfo?.height || 841.89; // A4
  const stranded = [];
  for (const [i, p] of big.pages.entries()) {
    for (const c of p.content) {
      if (/^Role \d+, Company \d+$/.test(c.str) || /^[A-Z]{4,}$/.test(c.str)) {
        const below = p.content.filter((o) => o.y > c.y + 2);
        if (!below.length && i < big.pages.length - 1) stranded.push(`${c.str}@p${i + 1}`);
      }
      if (c.y > pageH - 45) stranded.push(`text in bottom margin: ${c.str}@p${i + 1}`);
    }
  }
  check("no heading left alone at the bottom of a page", stranded.length === 0, stranded.join("; "));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
