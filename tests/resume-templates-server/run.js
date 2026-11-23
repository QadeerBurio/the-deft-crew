// P3c template studio, server side (config/resumeTemplates.js):
//   template ids: the older 13 + the library's 10 are accepted by PUT /:id/template and PUT /:id; others refused as
//     before; the library ids match the app's services/templates/library.js
//   customStyles: the five older keys as before; the studio's keys (palette, fontPair, size, density, margins,
//     headingCase, headingStyle, headingIcons, sectionOrder, hiddenSections, headings, photo, dateFormat, pageSize,
//     linkStyle) saved when valid, dropped when not (never a failed save); only the sent keys change
//   node tests/resume-templates-server/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/resume", "./routes/resume.routes"]], models: ["Resume", "ResumeCreationLock"] });
const { call, check, oid, user, token, fake, coll, rows, same, reqS } = h;
const fs = require("fs");
const path = require("path");

const S = oid(); const R = oid();
fake.seed(coll("User"), [user(S, "student", "Sana Malik")]);
fake.seed(coll("Resume"), [{ _id: R, user: S, personalInfo: { firstName: "Sana" }, template: "modern_ats", customStyles: { font: "Inter", accentColor: "#1E3A8A", headingColor: "#0F172A", textColor: "#334155", bgColor: "#FFFFFF" }, education: [], skills: [], workExperience: [], projects: [], certifications: [], languages: [], achievements: [], interests: [], references: [], createdAt: new Date(), updatedAt: new Date() }]);
const T = token(S, "student");
const doc = () => rows("Resume", (x) => same(x._id, R))[0];
const cfg = reqS("./config/resumeTemplates");

(async () => {
  const server = h.start();
  console.log("-- template ids");
  const lib = path.join(h.SERVER, "..", "Testting", "app", "src", "services", "templates", "library.js");
  if (fs.existsSync(lib)) {
    const appIds = [...fs.readFileSync(lib, "utf8").matchAll(/\bid: '([a-z_]+)'/g)].map((m) => m[1]);
    check("the server's library ids are the app's library ids", JSON.stringify(appIds) === JSON.stringify(cfg.LIBRARY_IDS), `${appIds} vs ${cfg.LIBRARY_IDS}`);
  }
  let r = await call("PUT", `/api/resume/${R}/template`, { tok: T, body: { template: "campus" } });
  check("PUT /:id/template campus → saved", r.status === 200 && doc().template === "campus", r.text.slice(0, 120));
  r = await call("PUT", `/api/resume/${R}/template`, { tok: T, body: { template: "stanford" } });
  check("…an older id still saves", r.status === 200 && doc().template === "stanford");
  r = await call("PUT", `/api/resume/${R}/template`, { tok: T, body: { template: "made_up" } });
  check("…an unknown id is refused as before (400)", r.status === 400 && doc().template === "stanford");
  r = await call("PUT", `/api/resume/${R}`, { tok: T, body: { template: "two_tone" } });
  check("PUT /:id { template: two_tone } → saved", r.status === 200 && doc().template === "two_tone", r.text.slice(0, 120));

  console.log("-- customStyles");
  r = await call("PUT", `/api/resume/${R}`, { tok: T, body: { customStyles: { palette: "ocean", fontPair: "lora_source", size: "S", density: "compact", margins: "narrow", headingCase: "title", headingStyle: "bar", headingIcons: false, sectionOrder: ["projects", "education", "nope", "projects"], hiddenSections: ["languages", "bogus"], headings: { activities: "Extracurriculars", nope: "x", awards: "  " }, photo: { on: true, shape: "rounded" }, dateFormat: "mm/yyyy", pageSize: "Letter", linkStyle: "short" } } });
  let c = doc().customStyles;
  check("the studio's keys are saved", r.status === 200 && c.palette === "ocean" && c.fontPair === "lora_source" && c.size === "S" && c.density === "compact" && c.margins === "narrow" && c.headingCase === "title" && c.headingStyle === "bar" && c.headingIcons === false && c.dateFormat === "mm/yyyy" && c.pageSize === "Letter" && c.linkStyle === "short", JSON.stringify(c));
  check("…lists cleaned (unknown sections and repeats dropped)", JSON.stringify(c.sectionOrder) === JSON.stringify(["projects", "education"]) && JSON.stringify(c.hiddenSections) === JSON.stringify(["languages"]));
  check("…section names cleaned (unknown and empty dropped)", JSON.stringify(c.headings) === JSON.stringify({ activities: "Extracurriculars" }));
  check("…photo saved", c.photo.on === true && c.photo.shape === "rounded");
  check("…the older keys untouched", c.font === "Inter" && c.accentColor === "#1E3A8A" && c.bgColor === "#FFFFFF");
  r = await call("PUT", `/api/resume/${R}`, { tok: T, body: { customStyles: { size: "XXL", density: "squashed", pageSize: "A3", photo: "yes", fontPair: "<script>", sectionOrder: "projects" } } });
  c = doc().customStyles;
  check("invalid values are dropped, never a failed save (the saved ones stay)", r.status === 200 && c.size === "S" && c.density === "compact" && c.pageSize === "Letter" && c.fontPair === "lora_source" && c.photo.on === true, JSON.stringify(c));
  r = await call("PUT", `/api/resume/${R}`, { tok: T, body: { customStyles: { accentColor: "#AA0000" } } });
  c = doc().customStyles;
  check("an older app's colour-only save changes only that colour", c.accentColor === "#AA0000" && c.palette === "ocean" && c.size === "S");
  r = await call("PUT", `/api/resume/${R}`, { tok: T, body: { customStyles: { palette: null, fontPair: null, sectionOrder: null, accentColor: null } } });
  c = doc().customStyles;
  check("null clears a studio key (reset to the template's look); the older keys can't be cleared", r.status === 200 && c.palette === undefined && c.fontPair === undefined && c.sectionOrder === undefined && c.size === "S" && c.accentColor === "#AA0000", JSON.stringify(c));

  console.log("-- reset after a typed custom colour (the app sends null for the studio keys + the default colours)");
  r = await call("PUT", `/api/resume/${R}`, { tok: T, body: { customStyles: { palette: "custom", accentColor: "#7A1F5C" } } });
  check("a typed custom colour is saved", r.status === 200 && doc().customStyles.palette === "custom" && doc().customStyles.accentColor === "#7A1F5C", JSON.stringify(doc().customStyles));
  r = await call("PUT", `/api/resume/${R}`, { tok: T, body: { customStyles: { palette: null, size: null, density: null, margins: null, headingCase: null, headingStyle: null, headingIcons: null, hiddenSections: null, headings: null, photo: null, dateFormat: null, pageSize: null, linkStyle: null, accentColor: "#1E3A8A", headingColor: "#0F172A", textColor: "#334155" } } });
  c = doc().customStyles;
  const left = Object.keys(c).filter((k) => c[k] !== undefined).sort().join();
  check("reset: back to the never-customised styles (the model's default colours, no studio key, custom colour gone)", r.status === 200 && left === "accentColor,bgColor,font,headingColor,textColor" && c.accentColor === "#1E3A8A" && c.headingColor === "#0F172A" && c.textColor === "#334155", JSON.stringify(c));

  console.log("-- photo link");
  r = await call("PUT", `/api/resume/${R}`, { tok: T, body: { personalInfo: { photoUrl: "https://res.cloudinary.com/x/me.jpg" } } });
  check("an https photo link is saved (first name untouched)", r.status === 200 && doc().personalInfo.photoUrl === "https://res.cloudinary.com/x/me.jpg" && doc().personalInfo.firstName === "Sana");
  for (const bad of ["http://x/me.jpg", "javascript:alert(1)", "https://x/a b.jpg", 42]) {
    await call("PUT", `/api/resume/${R}`, { tok: T, body: { personalInfo: { photoUrl: bad } } });
    if (doc().personalInfo.photoUrl !== "") { check(`a bad photo link (${bad}) → none`, false, doc().personalInfo.photoUrl); break; }
  }
  check("bad photo links (http, javascript:, spaces, not text) → none", doc().personalInfo.photoUrl === "");
  check("cleanCustomStyles: nothing but known keys", Object.keys(cfg.cleanCustomStyles({ evil: 1, $where: "x", __proto__: { a: 1 }, size: "M" })).join() === "size");
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
