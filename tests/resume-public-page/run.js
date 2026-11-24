// P3d public resume page (owner #1 + P3d #2-#4; flags resumeV2 + resumePublicPage)
//   the student's controls (/api/resume/:id/public-page): off by default; on → an unguessable 22-character link on
//     gettdc.pk/r/; off → gone; on again → the same link; new link → the old one stops at once; only the owner
//   the page (/r/<link>): the PDF's own HTML (the shared renderer) + noindex + a footer; headers: noindex, no-store,
//     no referrer, a CSP without scripts; phone / e-mail only when the student turns them on; never the street
//     address, postal code, free-text location or target-job location; the city only when typed on the resume; the
//     photo only when on in customise; "verified by tdc" only when added and the flag is on
//   not available (the same page): unknown or malformed link, page off, the owner's flag off, a suspended owner
//   views: a real count only for the student: not their own (selfUrl), not link previews / crawlers, the same visitor
//     within 30 minutes once; no IP stored anywhere
//   fonts: /r/fonts/<file> only for the bundled files and licences, cached for a year
//   node tests/resume-public-page/run.js [serverDir]
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-only-not-a-key";
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/r", "./routes/publicResume.routes"], ["/api/resume", "./routes/resumeFinish.routes"], ["/api/resume", "./routes/resume.routes"]], models: ["Resume", "Credential"] });
const { call, check, oid, user, token, fake, coll, rows, same, reqS } = h;

const S = oid(); const O = oid();
fake.seed(coll("User"), [user(S, "student", "Sana Malik", { universityName: "Sample University" }), user(O, "student", "Other Student")]);
fake.seed(coll("Credential"), [{ _id: oid(), user: S, type: "certificate", status: "issued", issuedAt: new Date() }]);
const R = oid();
fake.seed(coll("Resume"), [{
  _id: R, user: S, template: "modern_ats", customStyles: { font: "Inter", accentColor: "#1E3A8A", headingColor: "#0F172A", textColor: "#334155" },
  personalInfo: { firstName: "Sana", lastName: "Malik", title: "BBA Student", email: "sana.private@example.com", phone: "+92 300 7654321", location: "House 7, Street 9, Gulshan", address: "House 7, Street 9", city: "Karachi", state: "Sindh", country: "Pakistan", postalCode: "75300", linkedin: "linkedin.com/in/sana-sample", photoUrl: "https://res.cloudinary.com/x/sana.jpg" },
  targetJob: { jobTitle: "Marketing Intern", location: "Lahore office" },
  professionalSummary: { summary: "BBA student who runs campus events." },
  education: [{ institution: "Sample University", degree: "BBA", startDate: "2022-09", endDate: "2026-06" }],
  references: [{ name: "Dr Referee", phone: "0300 1112223", email: "referee@example.com" }],
  skills: [{ name: "Excel" }], workExperience: [], projects: [], certifications: [], languages: [], achievements: [], interests: [],
  settings: { track: "fresher" }, createdAt: new Date(), updatedAt: new Date(),
}]);
const T = { S: token(S, "student"), O: token(O, "student") };
const doc = () => rows("Resume", (x) => same(x._id, R))[0];
const BROWSER = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
const visit = (link, { ua = BROWSER, ip = "203.0.113.7", method = "GET" } = {}) => call(method, link.replace(/^https:\/\/gettdc\.pk/, ""), { headers: { "user-agent": ua, "x-forwarded-for": ip } });
const api = `/api/resume/${R}/public-page`;

(async () => {
  const server = h.start();
  const pub = reqS("./services/publicResume");
  const render = reqS("./utils/resumeRender");

  console.log("-- flags and the student's controls");
  let r = await call("GET", api, { tok: T.S });
  check("flags off → 404", r.status === 404);
  process.env.FLAG_RESUME_V2 = `ids:${S},${O}`;
  process.env.FLAG_RESUME_PUBLIC_PAGE = `ids:${S},${O}`;
  r = await call("GET", api, {});
  check("signed out → 401", r.status === 401);
  r = await call("GET", api, { tok: T.S });
  check("off by default: no link, no views", r.status === 200 && JSON.stringify(r.json.data) === JSON.stringify({ on: false, url: null, selfUrl: null, showPhone: false, showEmail: false, views: 0 }), r.text);
  r = await call("PUT", api, { tok: T.O, body: { on: true } });
  check("another student can't turn my page on (404)", r.status === 404 && !doc().publicPage?.on);
  r = await call("PUT", api, { tok: T.S, body: { on: true, showPhone: "yes", slug: "my-own-pick", views: 999 } });
  const page = r.json?.data || {};
  check("on → a link on gettdc.pk/r/ with 22 random characters", r.status === 200 && page.on === true && /^https:\/\/gettdc\.pk\/r\/[A-Za-z0-9_-]{22}$/.test(page.url), r.text);
  check("…the student can't pick the link, the views or a non-true/false value", !page.url.endsWith("my-own-pick") && page.views === 0 && page.showPhone === false);
  check("…selfUrl (\"open my page\") carries the student's private key", page.selfUrl.startsWith(`${page.url}?k=`) && page.selfUrl.length > page.url.length + 20);
  check("the link and key are never sent with the resume (select: false)", reqS("./models/Resume").schema.path("publicPage.slug").options.select === false && reqS("./models/Resume").schema.path("publicPage.selfKey").options.select === false);
  check("a duplicated resume starts with its page off", /delete dupData\.publicPage;/.test(require("fs").readFileSync(require("path").join(h.SERVER, "routes", "resume.routes.js"), "utf8")));

  console.log("-- the page");
  r = await visit(page.url);
  const html = r.text;
  check("200, the student's resume", r.status === 200 && /<h1 dir="auto">Sana Malik<\/h1>/.test(html) && /BBA student who runs campus events/.test(html));
  check("headers: noindex, no-store, no referrer, no scripts", r.headers["x-robots-tag"] === "noindex, nofollow" && r.headers["cache-control"] === "no-store" && r.headers["referrer-policy"] === "no-referrer" && /default-src 'none'/.test(r.headers["content-security-policy"]) && !/script-src/.test(r.headers["content-security-policy"]) && /<meta name="robots" content="noindex, nofollow">/.test(html));
  check("phone and e-mail hidden by default", !/7654321/.test(html) && !/sana\.private@example\.com/.test(html));
  check("never: street address, postal code, free-text location, target-job location, references", !/House 7|Street 9|75300|Gulshan|Lahore office|Referee|1112223|referee@/.test(html));
  check("the city typed on the resume shows (no state / country)", /<div class="contact">Karachi<span/.test(html) && !/Sindh|Pakistan/.test(html), html.slice(html.indexOf('<div class="contact">'), html.indexOf('<div class="contact">') + 120));
  check("the photo only when switched on in customise (it's off)", !/sana\.jpg/.test(html));
  check("no 'verified by tdc' unless the student added it", !/verified by tdc/.test(html));
  const same5 = render.renderResumeHTML(pub.publicCopy({ ...doc(), personalInfo: doc().personalInfo }), "modern_ats", doc().customStyles, false, {});
  check("the design is the PDF's: the same HTML + noindex + the footer", html.replace(/<meta name="robots"[^\n]*\n<meta name="referrer"[^\n]*\n/, "").replace(/<footer[\s\S]*<\/footer>/, "") === same5);
  r = await call("PUT", api, { tok: T.S, body: { showPhone: true, showEmail: true } });
  r = await visit(page.url, { ip: "203.0.113.50" });
  check("phone and e-mail show once the student turns them on", /\+92 300 7654321/.test(r.text) && /sana\.private@example\.com/.test(r.text));
  doc().customStyles = { ...doc().customStyles, photo: { on: true, shape: "circle" } };
  doc().settings.verifiedLine = true;
  r = await visit(page.url, { ip: "203.0.113.51" });
  check("photo on in customise → the photo", /<img class="photo" src="https:\/\/res\.cloudinary\.com\/x\/sana\.jpg"/.test(r.text));
  check("verified line added but resumeVerified off → no line", !/verified by tdc/.test(r.text));
  process.env.FLAG_RESUME_VERIFIED = `ids:${S}`;
  r = await visit(page.url, { ip: "203.0.113.52" });
  check("…with resumeVerified on → 'verified by tdc' with the verify link", /✓ verified by tdc: verified student at Sample University · campus ambassador/.test(r.text));
  doc().template = "campus";
  r = await visit(page.url, { ip: "203.0.113.53" });
  check("a library template: its fonts from /r/fonts (no data: fonts)", /src: url\(\/r\/fonts\/Outfit_700Bold\.ttf\)/.test(r.text) && /url\(\/r\/fonts\/DMSans_400Regular\.ttf\)/.test(r.text) && !/data:font/.test(r.text));
  doc().template = "modern_ats";

  console.log("-- views");
  pub._recent.clear();
  const before = doc().publicPage.views;
  await visit(page.url, { ip: "198.51.100.1" });
  await visit(page.url, { ip: "198.51.100.1" });
  check("a visitor counts once within 30 minutes", doc().publicPage.views === before + 1, `${before} → ${doc().publicPage.views}`);
  await visit(page.selfUrl, { ip: "198.51.100.2" });
  check("the student's own visit (selfUrl) isn't counted", doc().publicPage.views === before + 1);
  for (const ua of ["WhatsApp/2.23.20 A", "facebookexternalhit/1.1", "Googlebot/2.1", "LinkedInBot/1.0", ""]) await visit(page.url, { ua, ip: `198.51.100.${10 + ua.length}` });
  check("link previews, crawlers and no user agent aren't counted", doc().publicPage.views === before + 1);
  await visit(page.url, { ip: "198.51.100.3", method: "HEAD" });
  check("a HEAD request isn't counted", doc().publicPage.views === before + 1);
  await visit(page.url, { ip: "198.51.100.4" });
  r = await call("GET", api, { tok: T.S });
  check("another visitor counts; the student sees the real total", doc().publicPage.views === before + 2 && r.json.data.views === before + 2);
  const everything = JSON.stringify([...rows("Resume"), ...rows("User"), ...rows("EngagementEvent")]);
  check("no visitor address stored anywhere", !/198\.51\.100|203\.0\.113/.test(everything));

  console.log("-- off, new link, not available");
  const notAvailable = (t) => /this resume page isn't available/.test(t);
  r = await call("PUT", api, { tok: T.S, body: { on: false } });
  check("off → the API says so", r.json.data.on === false && r.json.data.url === null);
  r = await visit(page.url, { ip: "198.51.100.5" });
  check("off → the page is gone (404, 'not available')", r.status === 404 && notAvailable(r.text) && r.headers["x-robots-tag"] === "noindex, nofollow");
  r = await call("PUT", api, { tok: T.S, body: { on: true } });
  check("on again → the same link", r.json.data.url === page.url);
  r = await call("POST", `${api}/new-link`, { tok: T.S });
  const fresh = r.json?.data?.url;
  check("new link → a different link", r.status === 200 && fresh && fresh !== page.url && /\/r\/[A-Za-z0-9_-]{22}$/.test(fresh));
  r = await visit(page.url, { ip: "198.51.100.6" });
  const r2 = await visit(fresh, { ip: "198.51.100.7" });
  check("…the old link stops at once; the new one works", r.status === 404 && notAvailable(r.text) && r2.status === 200);
  r = await visit("/r/AAAAAAAAAAAAAAAAAAAAAA", { ip: "198.51.100.8" });
  const r3 = await visit("/r/short", { ip: "198.51.100.8" });
  check("an unknown or malformed link → the same 'not available' page", r.status === 404 && notAvailable(r.text) && r3.status === 404 && notAvailable(r3.text));
  process.env.FLAG_RESUME_PUBLIC_PAGE = `ids:${O}`;
  r = await visit(fresh, { ip: "198.51.100.9" });
  check("the owner's resumePublicPage flag off → not available", r.status === 404 && notAvailable(r.text));
  process.env.FLAG_RESUME_PUBLIC_PAGE = `ids:${S},${O}`;
  rows("User", (x) => same(x._id, S))[0].accountStatus = "suspended";
  r = await visit(fresh, { ip: "198.51.100.10" });
  check("a suspended owner → not available", r.status === 404 && notAvailable(r.text));
  rows("User", (x) => same(x._id, S))[0].accountStatus = "active";

  console.log("-- fonts");
  r = await call("GET", "/r/fonts/Inter-400.ttf");
  check("a bundled font: font/ttf, cached for a year", r.status === 200 && /font\/ttf/.test(r.headers["content-type"]) && /max-age=31536000, immutable/.test(r.headers["cache-control"]));
  r = await call("GET", "/r/fonts/OFL-inter.txt");
  check("its licence is served too", r.status === 200 && /SIL OPEN FONT LICENSE/i.test(r.text));
  for (const bad of ["..%2Fserver.js", "server.js", "Inter-400.TTF", "%2e%2e%2f.env"]) {
    r = await call("GET", `/r/fonts/${bad}`);
    if (r.status !== 404) { check(`/r/fonts/${bad} → 404`, false, r.status); break; }
  }
  check("anything else under /r/fonts → 404", r.status === 404);
  const fs = require("fs");
  const missing = [...pub.FONT_FILES].filter((f) => !fs.existsSync(require("path").join(pub.FONT_DIR, f)));
  check(`every font the page can ask for is on the server (${pub.FONT_FILES.size}), with an OFL licence per family`, missing.length === 0 && pub.LICENCES.size >= 16, missing.join());

  console.log("-- behind the portal (gettdc.pk → this server): the real visitor, only from the portal");
  // every forwarded request reaches the server from the same edge address (Vercel's, added by Railway's edge)
  const EDGE = "76.76.21.21";
  const SECRET = "test-only-portal-proxy-secret-0123456789";
  const viaPortal = (ip, { secret = SECRET, ua = BROWSER } = {}) => call("GET", fresh.replace(/^https:\/\/gettdc\.pk/, ""), { headers: { "user-agent": ua, "x-forwarded-for": EDGE, "x-tdc-proxy": secret, "x-tdc-visitor-ip": ip } });
  const views = () => doc().publicPage.views;
  pub._recent.clear();
  let v0 = views();
  await viaPortal("198.18.0.1"); await viaPortal("198.18.0.2");
  check("no PORTAL_PROXY_SECRET on the server: the header is ignored (two 'visitors' from one edge address = one view)", views() === v0 + 1, `${v0} → ${views()}`);
  process.env.PORTAL_PROXY_SECRET = SECRET;
  pub._recent.clear();
  v0 = views();
  await viaPortal("198.18.0.1"); await viaPortal("198.18.0.2"); await viaPortal("198.18.0.1");
  check("with the secret: two visitors behind the portal = two views (the same one again within 30 minutes: not counted)", views() === v0 + 2, `${v0} → ${views()}`);
  pub._recent.clear();
  v0 = views();
  await viaPortal("198.18.0.9", { secret: "a-wrong-secret-of-good-length" }); await viaPortal("198.18.0.10", { secret: "a-wrong-secret-of-good-length" });
  check("a wrong secret (someone calling the server directly with made-up headers): the edge address, one view", views() === v0 + 1);
  pub._recent.clear();
  v0 = views();
  await viaPortal("not-an-address"); await viaPortal("<script>");
  check("the right secret but not an address: the edge address", views() === v0 + 1);
  const ca = reqS("./services/clientAddress");
  check("clientAddress: the forwarded visitor only with the secret; else the edge address (last X-Forwarded-For entry)",
    ca.visitorAddress({ headers: { "x-forwarded-for": `1.1.1.1, ${EDGE}`, "x-tdc-proxy": SECRET, "x-tdc-visitor-ip": "2001:db8::7" } }) === "2001:db8::7"
    && ca.visitorAddress({ headers: { "x-forwarded-for": `1.1.1.1, ${EDGE}`, "x-tdc-visitor-ip": "198.18.0.5" } }) === EDGE);
  process.env.PORTAL_PROXY_SECRET = "short";
  check("a secret shorter than 16 characters counts as not configured", ca.fromPortal({ headers: { "x-tdc-proxy": "short" } }) === false);
  process.env.PORTAL_PROXY_SECRET = SECRET;

  console.log("-- rate limit per visitor behind the portal");
  process.env.RATE_LIMIT_RESUME_PAGE_MAX = "3";
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await viaPortal("198.18.1.1")).status);
  const other = (await viaPortal("198.18.1.2")).status;
  check("visitor A: 3 a minute, the 4th → 429; visitor B (same edge address) still gets the page", JSON.stringify(statuses) === "[200,200,200,429]" && other === 200, `${statuses} / ${other}`);
  const spoofed = [];
  for (let i = 0; i < 2; i++) spoofed.push((await viaPortal(`198.18.2.${i}`, { secret: "a-wrong-secret-of-good-length" })).status);
  check("made-up visitor addresses without the secret share the edge address's limit (no bypass)", spoofed.every((s) => s === 429), JSON.stringify(spoofed));
  delete process.env.RATE_LIMIT_RESUME_PAGE_MAX;
  delete process.env.PORTAL_PROXY_SECRET;
  h.finish(server);
})().catch((e) => { console.error(e); process.exit(1); });
