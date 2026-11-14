// services/resumeStudio/ai.js
// The model call for Resume Studio: OpenAI JSON mode, one retry on a malformed reply. With no key the
// studio still works: no AI suggestions, the match explanation is computed without a model, and the
// student sees "insufficient information" rather than made-up scores. Tests replace the caller.
const OpenAI = require("openai");

let client;
const ATTEMPT_MS = 45000;
let override = null; // tests: async (messages) => replyText

function getClient() {
  // 45 s per attempt, no SDK retries: completeJson makes at most 2 attempts, so a tailoring waits 90 s at most
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: ATTEMPT_MS, maxRetries: 0 });
  return client;
}

const available = () => !!override || !!process.env.OPENAI_API_KEY;

async function complete(messages) {
  if (override) return override(messages);
  const res = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" },
  });
  const choice = res.choices?.[0];
  // the answer was cut off (too long): never parse half a resume
  if (choice?.finish_reason === "length") throw Object.assign(new Error("the model's answer was cut off"), { code: "truncated" });
  return choice?.message?.content || "";
}

/**
 * @param messages chat messages
 * @param parse (text) => { ok, value } | { ok: false, error }
 * @returns { ok, value?, error?, attempts }
 */
async function completeJson(messages, parse) {
  let last = { ok: false, error: "no_model" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text;
    try {
      text = await complete(messages);
    } catch (e) {
      const timedOut = e?.name === "APIConnectionTimeoutError" || e?.code === "ETIMEDOUT" || /timed? ?out/i.test(e?.message || "");
      last = { ok: false, error: e?.status === 429 ? "model_rate_limited" : timedOut ? "model_timeout" : e?.code === "truncated" ? "model_truncated" : "model_error" };
      continue;
    }
    last = parse(text);
    if (last.ok) return { ...last, attempts: attempt };
  }
  return { ...last, attempts: 2 };
}

function setCaller(fn) { override = fn; }

module.exports = { available, completeJson, setCaller, ATTEMPT_MS };
