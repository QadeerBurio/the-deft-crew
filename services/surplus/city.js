// services/surplus/city.js
// A city as people type it: "Karachi", " karachi ", "Karachi, Pakistan" and "Karāchi" are the same city. Branch
// cities and profile locations are free text, so they're compared this way (the student's list, new-box pushes).
const cityName = (s) => String(s || "").split(",")[0].normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A MongoDB filter matching that city written any of those ways (text, never a pattern) */
const cityFilter = (name) => ({ $regex: `^\\s*${escapeRe(name).replace(/ /g, "\\s+")}\\s*(,.*)?$`, $options: "i" });

module.exports = { cityName, cityFilter };
