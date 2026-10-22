# hidden user secrets: tests

No database, no network, no `.env`. The real route files and the real User model run against an
in-memory collection layer (`fake-mongo.js`); e-mail, Expo and outgoing HTTP are stubbed. Run from a
folder that has no `.env` (dotenv is stubbed as well).

    node tests/hide-user-secrets/run.js <serverDir> [out.json]     # 33 checks + leak scan of every response
    node tests/hide-user-secrets/startup-check.js <serverDir>      # refuses to start without JWT_SECRET

Run `run.js` against the previous server folder too and compare: the functional checks must match,
the access checks (403 / 410) and the leak count are what this change fixes.
