const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const geo = require('../services/geo/geocoder');

test('geocoding recovers transient failures and checks all candidate cities', async () => {
  const original = axios.get;
  const oldKey = process.env.GEOCODER_API_KEY;
  const oldProvider = process.env.GEOCODER;
  process.env.GEOCODER_API_KEY = 'test';
  process.env.GEOCODER = 'google';
  const result = (city) => ({ types: ['street_address'], geometry: { location: { lat: 24.8, lng: 67 } }, address_components: [{ types: ['locality'], long_name: city }, { types: ['country'], short_name: 'PK' }] });
  try {
    let calls = 0;
    axios.get = async () => {
      if (++calls === 1) throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
      return { data: { status: 'OK', results: [result('Lahore'), result('Karachi')] } };
    };
    assert.equal((await geo.geocodeDetailed('Street, Karachi', { expectedCity: 'Karachi' })).status, 'ok');
    assert.equal(calls, 2);
    calls = 0;
    axios.get = async () => { calls++; return { data: { status: 'REQUEST_DENIED' } }; };
    assert.equal((await geo.geocodeDetailed('Street')).status, 'error');
    assert.equal(calls, 1);
    assert.match(geo.judgeResult({ ...result('Karachi'), types: ['locality', 'political'] }, 'Karachi').reason, /too vague/);
    let filter;
    await geo.saveGeo({ updateOne: async (q) => { filter = q; return { modifiedCount: 0 }; } }, 'id', { lat: 24.8, lng: 67 });
    assert.deepEqual(filter.geoSource, { $ne: 'manual' });
  } finally {
    axios.get = original;
    if (oldKey === undefined) delete process.env.GEOCODER_API_KEY; else process.env.GEOCODER_API_KEY = oldKey;
    if (oldProvider === undefined) delete process.env.GEOCODER; else process.env.GEOCODER = oldProvider;
  }
});
