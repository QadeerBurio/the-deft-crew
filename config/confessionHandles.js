// config/confessionHandles.js
// P4-2 anonymous handles: adjective-noun-number (e.g. "chill-samosa-343"), English + Roman Urdu. Owner rule (P4a #6):
// nothing religious, sectarian, ethnic, political, sexual or insulting, in English or Roman Urdu. Left out on purpose:
// skin-tone and colour words that can read as race (kala, gora, black, white, brown), animals that are insults in Urdu
// (ullu / owl, gadha / donkey, bandar / monkey, kutta / dog, suar / pig), the cow (religious), "garam" / "hot",
// brand names, class words ("wala"), anything that judges a person (pagal, sust, nalaik, moti…), size words next to a handle (chhota, bara: owner), and words with a slang
// second meaning (spicy, mast, rangeen).
// Every generated handle is also checked with the confession word filter (utils/profanity + the admin's banned words)
// before it's given (services/confessionHandles.js).
// APPROVED: the owner's sign-off on these lists. Until it is true, no handle is made or shown: students post "anon."
// as today, even with confessionsV2 on.
const APPROVED = false;

const ADJECTIVES = [
  // English
  "chill", "sleepy", "curious", "brave", "quiet", "sunny", "lucky", "cosmic", "fuzzy", "witty", "clever", "mellow", "bold",
  "swift", "gentle", "happy", "calm", "bright", "golden", "silver", "misty", "breezy", "cozy", "nerdy", "snappy", "zesty",
  "jolly", "plucky", "cheerful", "dreamy", "sparkly", "crispy", "tiny", "mighty", "stellar", "electric", "minty", "rapid",
  // Roman Urdu
  "ziddi", "khush", "nayab", "thanda", "pyara", "neela", "peela", "hara", "sunehra", "hoshiyar",
  "bahadur", "sharmila", "chulbula", "nirala", "albela", "masoom", "tez", "dheema", "anokha", "zabardast", "kamaal",
  "jugaari", "befikr", "chamakta",
];

const NOUNS = [
  // English: campus, food, things, animals that are not insults
  "notebook", "project", "deadline", "lab", "canteen", "hostel", "library", "backpack", "laptop", "marker", "stapler",
  "calculator", "pixel", "comet", "rocket", "cactus", "panda", "tiger", "fox", "penguin", "koala", "otter", "sparrow",
  "robin", "falcon", "lantern", "compass", "teacup", "cookie", "donut", "pancake", "pretzel", "mango", "kite", "planet",
  "meteor", "sunflower", "pebble",
  // Roman Urdu
  "chai", "samosa", "pakora", "jalebi", "golgappa", "paratha", "kulfi", "rickshaw", "patang", "sitara", "badal", "titli",
  "tota", "koel", "mor", "bulbul", "chirya", "kitab", "qalam", "basta", "chashma", "chabi", "lassi", "nimko", "chaat",
  "chandni",
];

// numbers 100-999, except those with a meaning in Pakistan or that read as a rude word: 786 and 313 (religious), 666
// (religious), 420 ("cheat"), 455 (reads "ass"), and every number containing 69
const NUMBER_LEFT_OUT = (n) => [786, 313, 666, 420, 455].includes(n) || String(n).includes("69");

module.exports = { APPROVED, ADJECTIVES, NOUNS, NUMBER_LEFT_OUT };
