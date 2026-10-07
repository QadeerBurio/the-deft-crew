// utils/cache.js
// ONE shared cache for every route file.
//
// Before: offer.routes.js and promoCode.routes.js each created their own
// in-memory Map, so clearing "offers:claimed:<user>" in one file never
// cleared it in the other. Students saw old discounts until the TTL ran out.
//
// Redis is used only when REDIS_URL is set. Otherwise an in-memory store.

let cache;

if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    client.on('error', (e) => console.warn('[cache] redis error:', e.message));

    cache = {
      async get(key) {
        try { return await client.get(key); } catch { return null; }
      },
      async set(key, data, ttl = 120) {
        try { await client.set(key, data, 'EX', ttl); } catch {}
      },
      async del(key) {
        try { await client.del(key); } catch {}
      },
      async delPrefix(prefix) {
        try {
          const keys = await client.keys(`${prefix}*`);
          if (keys.length) await client.del(...keys);
        } catch {}
      },
    };
    console.log('🗄️  [cache] using Redis');
  } catch (e) {
    console.warn('[cache] ioredis not installed, using memory cache');
  }
}

if (!cache) {
  const store = new Map();
  cache = {
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      if (Date.now() > item.expiry) {
        store.delete(key);
        return null;
      }
      return item.data;
    },
    async set(key, data, ttl = 120) {
      store.set(key, { data, expiry: Date.now() + ttl * 1000 });
    },
    async del(key) {
      store.delete(key);
    },
    async delPrefix(prefix) {
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
  };
}

// Clears everything that shows offers / claims for a brand and/or a student.
async function clearOfferCaches({ brandId, userId } = {}) {
  const jobs = [cache.del('offers:summary'), cache.delPrefix('brands:')];
  if (brandId) jobs.push(cache.del(`offers:brand:${brandId}`));
  if (userId) {
    jobs.push(cache.del(`offers:claimed:${userId}`));
    jobs.push(cache.del(`promo:student:${userId}`));
  }
  await Promise.all(jobs).catch(() => {});
}

module.exports = cache;
module.exports.cache = cache;
module.exports.clearOfferCaches = clearOfferCaches;
