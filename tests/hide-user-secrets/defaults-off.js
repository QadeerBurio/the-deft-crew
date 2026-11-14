// tests/hide-user-secrets/defaults-off.js (a helper, not a suite)
// Since feat/features-on-by-default every feature is ON by default for the roles config/featureFlags.js ROLE_DEFAULTS
// lists. Suites that check pilot behaviour (an account outside the Railway list or without an admin row is off) go back
// to the pilot-only meaning first: no default row = not set, the Railway rules and admin rows decide (as before).
//   require(path.join(SERVER, "tests", "hide-user-secrets", "defaults-off"))(reqS("./config/featureFlags"));
module.exports = function defaultsOff(flags) {
  flags.setBuiltInDefaults(false);
  flags.setDefaults([]);
};
