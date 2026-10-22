// In-memory stand-in for the MongoDB collection layer, for tests only. No database, no network.
// It replaces the methods on Mongoose's native collection, so everything above it stays real
// Mongoose: casting, validation, save hooks, select: false projections, populate and toJSON.
// Supports the filters, projections and updates these routes use; anything else throws loudly.

const STORE = new Map(); // collection name -> array of raw documents

const isOid = (v) => v != null && typeof v === "object" && v._bsontype === "ObjectId";
const isPlain = (v) => v != null && typeof v === "object" && !Array.isArray(v) && !isOid(v) && !(v instanceof Date) && !(v instanceof RegExp) && !Buffer.isBuffer(v);

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isOid(v)) return v; // immutable
  if (v instanceof Date) return new Date(v.getTime());
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (isPlain(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = clone(v[k]); return o; }
  return v;
}
const norm = (v) => (isOid(v) ? String(v) : v instanceof Date ? v.getTime() : v);
const eq = (a, b) => {
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((x) => eq(x, b));
  if (isPlain(a) && isPlain(b)) return JSON.stringify(a) === JSON.stringify(b);
  return norm(a) === norm(b) || (a == null && b == null);
};

// values at a dotted path; arrays fan out ("pushTokens.token" -> every token)
function valuesAt(doc, path) {
  let cur = [doc];
  for (const part of path.split(".")) {
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      if (Array.isArray(c) && !/^\d+$/.test(part)) { for (const el of c) if (el != null && el[part] !== undefined) next.push(el[part]); continue; }
      if (c[part] !== undefined) next.push(c[part]);
    }
    cur = next;
  }
  return cur;
}

function matchCond(vals, cond) {
  if (cond instanceof RegExp) return vals.some((v) => typeof v === "string" && cond.test(v));
  if (!isPlain(cond) || !Object.keys(cond).some((k) => k.startsWith("$"))) {
    if (cond === null) return vals.length === 0 || vals.some((v) => v == null);
    return vals.some((v) => eq(v, cond));
  }
  return Object.entries(cond).every(([op, arg]) => {
    switch (op) {
      case "$eq": return vals.some((v) => eq(v, arg));
      case "$ne": return !vals.some((v) => eq(v, arg));
      case "$in": return vals.some((v) => arg.some((a) => (a instanceof RegExp ? typeof v === "string" && a.test(v) : eq(v, a))));
      case "$nin": return !vals.some((v) => arg.some((a) => eq(v, a)));
      case "$exists": return arg ? vals.length > 0 : vals.length === 0;
      case "$gt": return vals.some((v) => norm(v) > norm(arg));
      case "$gte": return vals.some((v) => norm(v) >= norm(arg));
      case "$lt": return vals.some((v) => norm(v) < norm(arg));
      case "$lte": return vals.some((v) => norm(v) <= norm(arg));
      case "$regex": { const re = arg instanceof RegExp ? arg : new RegExp(arg, cond.$options || ""); return vals.some((v) => typeof v === "string" && re.test(v)); }
      case "$options": return true;
      case "$size": return vals.some((v) => Array.isArray(v) && v.length === arg);
      case "$elemMatch": return vals.some((v) => Array.isArray(v) && v.some((el) => matches(el, arg)));
      case "$not": return !matchCond(vals, arg);
      default: throw new Error(`fake-mongo: unsupported operator ${op}`);
    }
  });
}

function matches(doc, filter) {
  if (!filter) return true;
  return Object.entries(filter).every(([k, cond]) => {
    if (k === "$or") return cond.some((f) => matches(doc, f));
    if (k === "$and") return cond.every((f) => matches(doc, f));
    if (k === "$nor") return !cond.some((f) => matches(doc, f));
    if (k === "$expr" || k === "$where" || k === "$text") throw new Error(`fake-mongo: unsupported ${k}`);
    let vals = valuesAt(doc, k);
    // an array field matched as a whole also matches its elements
    vals = vals.flatMap((v) => (Array.isArray(v) && !(isPlain(cond) && ("$size" in cond || "$elemMatch" in cond)) ? [v, ...v] : [v]));
    return matchCond(vals, cond);
  });
}

function project(doc, projection, filter) {
  if (!projection || !Object.keys(projection).length) return clone(doc);
  const keys = Object.keys(projection);
  const inclusive = keys.some((k) => k !== "_id" && (projection[k] === 1 || projection[k] === true || (typeof projection[k] === "object" && projection[k] !== null)));
  if (!inclusive) {
    const out = clone(doc);
    for (const k of keys) if (!projection[k]) { const parts = k.split("."); let o = out; for (let i = 0; i < parts.length - 1 && o; i++) o = o[parts[i]]; if (o) delete o[parts[parts.length - 1]]; }
    return out;
  }
  const out = {};
  if (projection._id !== 0 && projection._id !== false) out._id = doc._id;
  for (const k of keys) {
    if (k === "_id" || !projection[k]) continue;
    if (k.endsWith(".$")) { // positional: first element matching the filter on that array
      const field = k.slice(0, -2);
      const arr = doc[field] || [];
      const sub = Object.fromEntries(Object.entries(filter || {}).filter(([fk]) => fk.startsWith(field + ".")).map(([fk, v]) => [fk.slice(field.length + 1), v]));
      const hit = arr.find((el) => matches(el, sub));
      if (hit) out[field] = [clone(hit)];
      continue;
    }
    const top = k.split(".")[0];
    if (doc[top] !== undefined) out[top] = clone(doc[top]); // sub-path projections keep the whole top field
  }
  return out;
}

function setPath(doc, path, value, filter) {
  const parts = path.split(".");
  let o = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    let p = parts[i];
    if (p === "$") { // positional update: index of the element matched by the filter
      const field = parts.slice(0, i).join(".");
      const sub = Object.fromEntries(Object.entries(filter || {}).filter(([fk]) => fk.startsWith(field + ".")).map(([fk, v]) => [fk.slice(field.length + 1), v]));
      p = String(o.findIndex((el) => matches(el, sub)));
      if (p === "-1") return;
    }
    if (o[p] == null) o[p] = /^\d+$/.test(parts[i + 1] || "") ? [] : {};
    o = o[p];
  }
  o[parts[parts.length - 1]] = value;
}
const getPath = (doc, path) => path.split(".").reduce((o, p) => (o == null ? undefined : o[p]), doc);

function applyUpdate(doc, update, filter, isInsert) {
  const ops = Object.keys(update).some((k) => k.startsWith("$")) ? update : { $set: update };
  for (const [op, fields] of Object.entries(ops)) {
    for (const [path, val] of Object.entries(fields || {})) {
      switch (op) {
        case "$set": setPath(doc, path, clone(val), filter); break;
        case "$setOnInsert": if (isInsert) setPath(doc, path, clone(val), filter); break;
        case "$unset": { const parts = path.split("."); const parent = parts.length > 1 ? getPath(doc, parts.slice(0, -1).join(".")) : doc; if (parent) delete parent[parts[parts.length - 1]]; break; }
        case "$inc": setPath(doc, path, (getPath(doc, path) || 0) + val, filter); break;
        case "$push": case "$addToSet": {
          let arr = getPath(doc, path); if (!Array.isArray(arr)) { arr = []; setPath(doc, path, arr, filter); }
          const each = isPlain(val) && "$each" in val ? val.$each : [val];
          for (const item of each) if (op === "$push" || !arr.some((a) => eq(a, item))) arr.push(clone(item));
          if (isPlain(val) && val.$sort) { const [[sk, sd]] = Object.entries(val.$sort); arr.sort((a, b) => (norm(a[sk]) > norm(b[sk]) ? sd : -sd)); }
          if (isPlain(val) && typeof val.$slice === "number") arr.splice(val.$slice >= 0 ? val.$slice : 0, val.$slice >= 0 ? arr.length : arr.length + val.$slice);
          break;
        }
        case "$pull": {
          const arr = getPath(doc, path); if (!Array.isArray(arr)) break;
          const keep = arr.filter((el) => !(isPlain(val) && isPlain(el) ? matches(el, val) : matchCond([el], val)));
          arr.splice(0, arr.length, ...keep); break;
        }
        default: throw new Error(`fake-mongo: unsupported update operator ${op}`);
      }
    }
  }
}

function sortDocs(docs, sort) {
  if (!sort) return docs;
  const entries = sort instanceof Map ? [...sort.entries()] : Array.isArray(sort) ? sort : Object.entries(sort);
  return docs.sort((a, b) => { for (const [k, d] of entries) { const x = norm(getPath(a, k)), y = norm(getPath(b, k)); if (x === y) continue; return (x > y ? 1 : -1) * (d === -1 || d === "desc" ? -1 : 1); } return 0; });
}

function makeCursor(docsPromise) {
  const c = { toArray: async () => docsPromise, async *[Symbol.asyncIterator]() { for (const d of await docsPromise) yield d; }, close: async () => {} };
  for (const m of ["sort", "limit", "skip", "project", "batchSize", "maxTimeMS", "collation", "hint", "comment"]) c[m] = () => c;
  return c;
}

function install(mongoose, ObjectId) {
  // the prototype shared by every model's collection (mongoose's native driver wrapper)
  const P = Object.getPrototypeOf(mongoose.connection.collection("__fake_probe"));
  const coll = (self) => { const n = self.collectionName || self.name; if (!STORE.has(n)) STORE.set(n, []); return STORE.get(n); };
  const find = (self, filter, opts = {}) => {
    let docs = coll(self).filter((d) => matches(d, filter));
    docs = sortDocs(docs, opts.sort);
    if (opts.skip) docs = docs.slice(opts.skip);
    if (opts.limit) docs = docs.slice(0, opts.limit);
    return docs.map((d) => project(d, opts.projection, filter));
  };
  P.find = function (filter, opts) { return makeCursor(Promise.resolve(find(this, filter, opts))); };
  P.findOne = async function (filter, opts) { return find(this, filter, { ...opts, limit: 1 })[0] || null; };
  P.countDocuments = async function (filter) { return coll(this).filter((d) => matches(d, filter)).length; };
  P.estimatedDocumentCount = async function () { return coll(this).length; };
  P.distinct = async function (field, filter) { const s = new Map(); for (const d of coll(this).filter((x) => matches(x, filter))) for (const v of valuesAt(d, field).flat()) s.set(String(norm(v)), v); return [...s.values()]; };
  P.insertOne = async function (doc) { const d = clone(doc); if (d._id == null) d._id = new ObjectId(); coll(this).push(d); return { acknowledged: true, insertedId: d._id }; };
  P.insertMany = async function (docs) { const ids = {}; docs.forEach((doc, i) => { const d = clone(doc); if (d._id == null) d._id = new ObjectId(); coll(this).push(d); ids[i] = d._id; }); return { acknowledged: true, insertedCount: docs.length, insertedIds: ids }; };
  const upd = (self, filter, update, opts = {}, many) => {
    const hits = coll(self).filter((d) => matches(d, filter));
    const targets = many ? hits : hits.slice(0, 1);
    for (const d of targets) applyUpdate(d, update, filter, false);
    let upserted = null;
    if (!targets.length && opts.upsert) {
      const d = {}; for (const [k, v] of Object.entries(filter || {})) if (!k.startsWith("$") && !isPlain(v)) setPath(d, k, clone(v));
      applyUpdate(d, update, filter, true); if (d._id == null) d._id = new ObjectId(); coll(self).push(d); upserted = d;
    }
    return { targets, upserted, matched: hits.length };
  };
  P.updateOne = async function (f, u, o) { const r = upd(this, f, u, o, false); return { acknowledged: true, matchedCount: r.matched ? 1 : 0, modifiedCount: r.targets.length, upsertedCount: r.upserted ? 1 : 0, upsertedId: r.upserted?._id ?? null }; };
  P.updateMany = async function (f, u, o) { const r = upd(this, f, u, o, true); return { acknowledged: true, matchedCount: r.matched, modifiedCount: r.targets.length, upsertedCount: r.upserted ? 1 : 0 }; };
  P.findOneAndUpdate = async function (f, u, o = {}) {
    const before = coll(this).find((d) => matches(d, f)); const snapshot = before ? clone(before) : null;
    const r = upd(this, f, u, o, false);
    const after = r.targets[0] || r.upserted;
    let val = o.returnDocument === "after" || o.new ? after : snapshot;
    val = val ? project(val, o.projection, f) : null;
    return o.includeResultMetadata ? { value: val, ok: 1, lastErrorObject: { updatedExisting: !!before } } : val;
  };
  P.findOneAndDelete = async function (f, o = {}) { const arr = coll(this); const i = arr.findIndex((d) => matches(d, f)); const val = i >= 0 ? arr.splice(i, 1)[0] : null; return o.includeResultMetadata ? { value: val, ok: 1 } : val; };
  P.findOneAndReplace = async function () { throw new Error("fake-mongo: findOneAndReplace unsupported"); };
  P.deleteOne = async function (f) { const arr = coll(this); const i = arr.findIndex((d) => matches(d, f)); if (i >= 0) arr.splice(i, 1); return { acknowledged: true, deletedCount: i >= 0 ? 1 : 0 }; };
  P.deleteMany = async function (f) { const arr = coll(this); const keep = arr.filter((d) => !matches(d, f)); const n = arr.length - keep.length; arr.splice(0, arr.length, ...keep); return { acknowledged: true, deletedCount: n }; };
  P.aggregate = function () { return makeCursor(Promise.resolve([])); };
  P.bulkWrite = async function () { return { acknowledged: true }; };
  P.createIndex = async function () { return "fake"; };
  P.createIndexes = async function () { return []; };
  P.listIndexes = function () { return makeCursor(Promise.resolve([])); };
  P.indexes = async function () { return []; };
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
}

module.exports = { install, STORE, seed: (name, docs) => { if (!STORE.has(name)) STORE.set(name, []); STORE.get(name).push(...docs.map(clone)); } };
