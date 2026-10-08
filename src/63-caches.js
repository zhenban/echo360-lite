// ===================================================================================
// Analysis caches in IndexedDB: slide chapters, silence envelopes, text read on screen.
//
// - Each kind has a version tied to its algorithm. A stored result with another version
//   was made by different code and is computed again (bump the number when changing how
//   results are made, not only their format).
// - Each record carries `used`, the last time it was used (its own field: records already
//   use names such as `at` for their data). A minute after a player starts,
//   records of these kinds that were not used for CACHE_KEEP_DAYS, or are from another
//   version, are deleted in the background.
// - Settings menu: how much space they take, and clearing them all.
// User data (tags, slide files, watched records) is not an analysis cache and is never
// pruned here.
// ===================================================================================

const CACHE_KINDS = {
  slides: 4,          // chapters (2: screen view chosen per recording, tolerant scanning; 3: uniform stretches; 4: 160 x 90, learnt threshold)
  'silence-env': 1,   // audio level envelope
  ocr: 1,             // text read on screen
};
const CACHE_KEEP_DAYS = 60;

function cacheKind(key) {
  const k = String(key).split(':')[0];
  return Object.prototype.hasOwnProperty.call(CACHE_KINDS, k) ? k : null;
}

function cacheVersion(kind) {
  return CACHE_KINDS[kind];
}

// Whether a stored record of `kind` can be used.
function cacheValid(kind, rec) {
  return !!rec && typeof rec === 'object' && rec.v === CACHE_KINDS[kind];
}

// The record with its last use set to now (nothing else changes).
function cacheTouched(rec, now) {
  return rec && typeof rec === 'object' ? Object.assign(rec, { used: now }) : rec;
}

// When a record was last used or, for records from before `used`, saved (ms, or 0).
function cacheLastUse(rec) {
  if (!rec || typeof rec !== 'object') return 0;
  for (const k of ['used', 'savedAt', 'at']) if (typeof rec[k] === 'number' && isFinite(rec[k])) return rec[k];
  return 0;
}

// Marks a record as used now (keeps it from being pruned).
function cacheTouch(key) {
  idbCache.update(key, (rec) => cacheTouched(rec, Date.now())).catch(() => {});
}

// Rough size of a stored value in bytes (Blobs by their size, the rest as JSON).
function approxSize(v) {
  if (v instanceof Blob) return v.size;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (Array.isArray(v)) return v.reduce((s, x) => s + approxSize(x), 0) + 2;
  if (v && typeof v === 'object') {
    let s = 2;
    for (const [k, x] of Object.entries(v)) s += k.length + 3 + approxSize(x);
    return s;
  }
  return String(v).length + 1;
}

const analysisCaches = {
  async keys() {
    return (await idbCache.keys()).filter((k) => cacheKind(k));
  },

  // { count, bytes } of all analysis caches.
  async usage() {
    let bytes = 0;
    const keys = await this.keys();
    for (const k of keys) bytes += approxSize(await idbCache.get(k));
    return { count: keys.length, bytes };
  },

  async clear() {
    const keys = await this.keys();
    for (const k of keys) await idbCache.del(k);
    return keys.length;
  },

  // Deletes records unused for CACHE_KEEP_DAYS or from another algorithm version.
  async prune() {
    const old = Date.now() - CACHE_KEEP_DAYS * 864e5;
    let n = 0;
    for (const k of await this.keys()) {
      const rec = await idbCache.get(k);
      if (!cacheValid(cacheKind(k), rec) || !(cacheLastUse(rec) > old)) { await idbCache.del(k); n++; }
    }
    if (n) log.info('removed ' + n + ' old analysis results');
    return n;
  },
};
