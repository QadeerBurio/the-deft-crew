// services/resumeAi.js
// The builder's two small AI helpers (POST /api/resume/enhance-text, /api/resume/suggest-skills), owner decision P3 #7:
//   - the model is OPENAI_MODEL (default gpt-4o-mini), like every other AI call
//   - enhance never asks for numbers, tools, employers or results the student didn't give; a rewrite that still adds
//     a number that isn't in the student's text is not used (the original comes back, unchanged: true)
//   - suggest-skills never assumes a role: without a target role it works from the current skills only, and with
//     neither it suggests nothing (there's nothing to base it on)
const { numbersIn } = require("./resumeStudio/validator");

let client = null;
const ai = () => {
  if (client) return client;
  const OpenAI = require("openai");
  client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
};
const model = () => process.env.OPENAI_MODEL || "gpt-4o-mini";

const ENHANCE_SYSTEM = [
  "You rewrite one part of a student's resume so it reads well to a recruiter.",
  "Use clear action verbs and short, plain sentences. Keep the same meaning.",
  "Use ONLY facts that are in the student's text. Never add a number, percentage, amount, date, tool, technology,",
  "employer, title, award or result that is not already there. If the text has no numbers, the rewrite has no numbers.",
  "Return ONLY the rewritten text: no labels, no preamble, no markdown.",
].join(" ");

// the builder's "write my summary" (every app version) sends a request with its facts as the text and the context
// "professional summary for <role>": that one is written, not rewritten, from those facts only
const SUMMARY_SYSTEM = [
  "You write a 2-3 sentence resume summary for a student, from the request and the facts in it only.",
  "Never add a number, years of experience, tool, employer, title, award or result that is not in the request.",
  "If something is 'not specified', leave it out. No first person ('I', 'my'). Return ONLY the summary text.",
].join(" ");
const isSummary = (context) => /^professional summary for\b/i.test(String(context || "").trim());

/** → { enhanced, unchanged } */
async function enhance({ text, context } = {}) {
  const original = String(text || "").trim();
  const completion = await ai().chat.completions.create({
    model: model(),
    messages: [
      { role: "system", content: isSummary(context) ? SUMMARY_SYSTEM : ENHANCE_SYSTEM },
      { role: "user", content: `Context: ${String(context || "general resume content").slice(0, 200)}\n\nText to rewrite:\n${original.slice(0, 3000)}` },
    ],
    max_tokens: 500,
    temperature: 0.4,
  });
  const out = String(completion.choices?.[0]?.message?.content || "").trim();
  if (!out) return { enhanced: isSummary(context) ? "" : original, unchanged: true };
  const had = numbersIn(original); // a Set
  const added = [...numbersIn(out)].filter((n) => !had.has(n));
  if (added.length) {
    console.warn(`[resume-ai] enhance added numbers not in the text (${added.join(", ")}): not used`);
    // a summary request is an instruction, never something to put on the resume: nothing comes back instead
    return { enhanced: isSummary(context) ? "" : original, unchanged: true, reason: "new_numbers" };
  }
  return { enhanced: out, unchanged: out === original };
}

/** → string[] (8–12 skills, or [] when there's nothing to go on) */
async function suggestSkills({ currentSkills, targetRole } = {}) {
  const skills = (Array.isArray(currentSkills) ? currentSkills : []).map((s) => String(typeof s === "string" ? s : s?.name || "").trim()).filter(Boolean).slice(0, 40);
  const role = String(targetRole || "").trim().slice(0, 100);
  if (!skills.length && !role) return [];
  const completion = await ai().chat.completions.create({
    model: model(),
    messages: [
      { role: "system", content: role
        ? "You are a career advisor. Given a student's current skills and their target role, suggest 8-12 relevant skills they could add. Return ONLY a JSON array of skill name strings."
        : "You are a career advisor. Given a student's current skills, suggest 8-12 closely related skills they could add. Do not assume a job or field beyond what the skills show. Return ONLY a JSON array of skill name strings." },
      { role: "user", content: `${role ? `Target role: ${role}\n\n` : ""}Current skills: ${skills.join(", ") || "none listed"}\n\nSuggest skills to add:` },
    ],
    max_tokens: 300,
    temperature: 0.5,
  });
  const raw = String(completion.choices?.[0]?.message?.content || "").trim();
  try {
    const m = raw.match(/\[.*\]/s);
    const list = m ? JSON.parse(m[0]) : [];
    const have = new Set(skills.map((s) => s.toLowerCase()));
    return (Array.isArray(list) ? list : []).map((s) => String(s || "").trim()).filter((s) => s && s.length <= 60 && !have.has(s.toLowerCase())).slice(0, 12);
  } catch {
    return [];
  }
}

module.exports = { enhance, suggestSkills, ENHANCE_SYSTEM, SUMMARY_SYSTEM, isSummary, _setClient: (c) => { client = c; } };
