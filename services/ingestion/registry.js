// services/ingestion/registry.js
// ============================================================
// Connector Registry for Job Ingestion adapters
// ============================================================

// const RemotiveAdapter = require('./adapters/remotiveAdapter');
const JSearchAdapter = require('./adapters/jsearchAdapter');
const LeverAdapter = require('./adapters/leverAdapter');
const GreenhouseAdapter = require('./adapters/greenhouseAdapter');
const WorkableAdapter = require('./adapters/workableAdapter');
const AdzunaAdapter = require('./adapters/adzunaAdapter');
// const ArbeitnowAdapter = require('./adapters/arbeitnowAdapter');

const adapters = [
  // new RemotiveAdapter(),
  new JSearchAdapter(),
  new LeverAdapter(),
  new GreenhouseAdapter(),
  new WorkableAdapter(),
  new AdzunaAdapter(),
  // new ArbeitnowAdapter()
];

module.exports = { adapters };
