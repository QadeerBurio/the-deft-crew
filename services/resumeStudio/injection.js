// services/resumeStudio/injection.js
// Prompt-injection scan for untrusted text (a pasted or posted job description, uploaded resume text).
// Lines that try to instruct the model are removed before the text goes anywhere near it, and reported
// as warnings. The model is also told the text is data (contract.js), and the validator blocks anything
// unsupported whatever the model does: this scan is one layer, not the only one.

const PATTERNS = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|the|these|system)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|constraints?|messages?)\b/i,
  /\b(you are now|act as|pretend to be|roleplay as|from now on you)\b/i,
  /\b(system prompt|developer message|hidden instructions?|jailbreak|DAN mode)\b/i,
  /\b(reveal|print|show|repeat)\b[^.\n]{0,30}\b(prompt|instructions|system message)\b/i,
  /\b(add|insert|include|claim|state|say)\b[^.\n]{0,60}\b(to|in|on)\b[^.\n]{0,20}\b(the )?(resume|cv|candidate'?s? (profile|resume|cv))\b/i,
  /\b(the candidate (has|holds|is)|assume the candidate)\b/i,
  /<\|?(im_start|im_end|system|assistant)\|?>|\[\/?(INST|SYS)\]|<<\s*SYS\s*>>/i,
  /\b(respond|reply|answer|output)\s+(only\s+)?(with|in)\b[^.\n]{0,40}\b(json|yes|no|the following)\b/i,
];

const MAX_JOB_CHARS = 12000;
// control characters, zero-width characters, bidi overrides and the BOM (used to hide instructions)
const HIDDEN_CHARS = new RegExp("[" + [[0x0, 0x8], [0xb, 0xc], [0xe, 0x1f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]].map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("") + "]", "gu");

function scan(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").replace(HIDDEN_CHARS, "").split("\n");
  const kept = [];
  const flagged = [];
  for (const line of lines) {
    if (PATTERNS.some((p) => p.test(line))) flagged.push(line.trim().slice(0, 160));
    else kept.push(line);
  }
  return { text: kept.join("\n").trim(), flagged, suspicious: flagged.length > 0 };
}

module.exports = { scan, PATTERNS, MAX_JOB_CHARS };
