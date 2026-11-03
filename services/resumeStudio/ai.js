// services/resumeStudio/ai.js
// The model call for Resume Studio: OpenAI JSON mode, one retry on a malformed reply. With no key the
// studio still works: no AI suggestions, the match explanation is computed without a model, and the
// student sees "insufficient information" rather than made-up scores. Tests replace the caller.
const OpenAI = require("openai");

let client;
let override = null; // tests: async (messages) => replyText

function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45000, maxRetries: 1 });
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
  return res.choices?.[0]?.message?.content || "";
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
      last = { ok: false, error: e?.status === 429 ? "model_rate_limited" : "model_error" };
      continue;
    }
    last = parse(text);
    if (last.ok) return { ...last, attempts: attempt };
  }
  return { ...last, attempts: 2 };
}

function setCaller(fn) { override = fn; }

module.exports = { available, completeJson, setCaller };
