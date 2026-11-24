// services/confessionPolls.js
// P4b (flag confessionPolls): an anonymous poll in a confession: 2-4 options, each 1-60 characters, no repeats.
// Votes: one per student, can be changed; the counts are public, who voted for what is never sent ("your answer is not
// attached to your handle"). The options go through the same pre-post check as the confession's text.
//   cleanPoll(input)                 → { poll: { options, counts } } | { error: { code, message } }
//   view(poll, voters, meId)         → { options: [{ text, votes }], total, myVote }   (myVote: index or null)
//   applyVote(poll, voters, meId, i) → { poll, voters, changed }
const MAX = 4;
const MIN = 2;
const LEN = 60;

function cleanPoll(input) {
  const raw = Array.isArray(input?.options) ? input.options : null;
  if (!raw) return { error: { code: "BAD_POLL", message: "a poll needs 2 to 4 options." } };
  const options = raw.map((o) => String(o == null ? "" : o).replace(/\s+/g, " ").trim()).filter(Boolean);
  if (options.length < MIN || options.length > MAX) return { error: { code: "BAD_POLL", message: "a poll needs 2 to 4 options." } };
  if (options.some((o) => o.length > LEN)) return { error: { code: "BAD_POLL", message: `keep each option under ${LEN} characters.` } };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: { code: "BAD_POLL", message: "each option has to be different." } };
  return { poll: { options, counts: options.map(() => 0) } };
}

function view(poll, voters, meId) {
  if (!poll || !Array.isArray(poll.options) || poll.options.length < MIN) return undefined;
  const counts = poll.options.map((_, i) => Math.max(0, Number(poll.counts?.[i]) || 0));
  const mine = meId ? (voters || []).find((v) => String(v.user) === String(meId)) : null;
  return {
    options: poll.options.map((text, i) => ({ text, votes: counts[i] })),
    total: counts.reduce((a, b) => a + b, 0),
    myVote: mine && Number.isInteger(mine.option) ? mine.option : null,
  };
}

function applyVote(poll, voters, meId, option) {
  const counts = poll.options.map((_, i) => Math.max(0, Number(poll.counts?.[i]) || 0));
  const list = (voters || []).map((v) => ({ user: v.user, option: v.option }));
  const at = list.findIndex((v) => String(v.user) === String(meId));
  if (at >= 0 && list[at].option === option) return { poll: { options: poll.options, counts }, voters: list, changed: false };
  if (at >= 0) { counts[list[at].option] = Math.max(0, (counts[list[at].option] || 0) - 1); list[at].option = option; } else list.push({ user: meId, option });
  counts[option] += 1;
  return { poll: { options: poll.options, counts }, voters: list, changed: true };
}

module.exports = { cleanPoll, view, applyVote, MAX, MIN, LEN };
