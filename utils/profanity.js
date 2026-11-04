// utils/profanity.js
// A small profanity check for short free text (rating comments). English and Roman Urdu insults and slurs,
// matched as whole words after undoing common disguises (l33t letters, repeated letters, dots or spaces inside
// a word). It refuses the text; it never rewrites it. Words that only look rude inside another word
// ("class", "Scunthorpe", "assessment") are not matched.
const WORDS = [
  // English
  "fuck", "fucking", "fucker", "fucked", "motherfucker", "shit", "shitty", "bullshit", "bitch", "bastard", "asshole", "ass", "dick", "dickhead",
  "cunt", "prick", "slut", "whore", "wanker", "twat", "douche", "douchebag", "retard", "retarded", "idiot", "moron", "stupid", "dumbass", "jackass",
  "piss", "pissed", "crap", "damn", "nigger", "nigga", "faggot", "fag", "tranny", "spastic",
  // Roman Urdu / Hindi
  "chutiya", "chutia", "chutiye", "bhenchod", "behenchod", "benchod", "bhanchod", "madarchod", "maderchod", "bkl", "gandu", "gaandu",
  "gand", "gaand", "harami", "haramzada", "haramzadi", "kamina", "kameena", "kamine", "kutta", "kutti", "kuttay", "kutte", "suar", "suwar",
  "lanat", "lun", "lund", "phuddi", "randi", "rundi", "bhosdi", "bhosdike", "bhosda", "tatti", "ullu", "khota", "khotay", "badtameez", "jahil",
];
const SET = new Set(WORDS);
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "!": "i" };

function words(text) {
  const t = String(text || "").toLowerCase().replace(/[0-9@$!]/g, (c) => LEET[c] || c);
  // "f.u.c.k" / "f u c k" (single letters joined by dots, dashes or spaces) become one word
  const joined = t.replace(/\b(?:[a-z][\s.\-_*]){2,}[a-z]\b/g, (m) => m.replace(/[\s.\-_*]/g, ""));
  return joined.split(/[^a-z]+/).filter(Boolean).map((w) => w.replace(/(.)\1{2,}/g, "$1$1"));
}
const squeeze = (w) => w.replace(/(.)\1+/g, "$1");

/** the first offending word, or null */
function findProfanity(text) {
  for (const w of words(text)) {
    if (SET.has(w) || SET.has(squeeze(w))) return w;
  }
  return null;
}

module.exports = { findProfanity, WORDS };
