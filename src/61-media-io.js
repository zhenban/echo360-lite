// ===================================================================================
// Shared helpers for background media work: HLS playlist parsing, ranged fetches, an
// IndexedDB cache, and a gate that keeps background downloads from competing with playback.
// ===================================================================================

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

// Master playlist -> { media: [attributes of each #EXT-X-MEDIA], variants: [{ attrs, uri }]
// (each #EXT-X-STREAM-INF with the URI line after it, as written) }.
function parseMaster(text) {
  const out = { media: [], variants: [] };
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) out.media.push(parseAttrs(line.slice(13)));
    else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const uri = (lines.slice(i + 1).find((l) => l && !l.startsWith('#')) || '').trim();
      out.variants.push({ attrs: parseAttrs(line.slice(18)), uri });
    }
  }
  return out;
}

// Media playlist -> { init: { url, offset, length } | null, segments: [{ start, dur, url, offset, length }] }.
// length is null for segments that are whole files.
function parseMediaPlaylist(text, base) {
  const out = { init: null, segments: [] };
  let dur = 0;
  let range = null;
  let t = 0;
  const nextOffset = new Map();
  const parseRange = (spec, url) => {
    const [len, off] = spec.split('@');
    const offset = off !== undefined ? +off : (nextOffset.get(url) || 0);
    nextOffset.set(url, offset + +len);
    return { offset, length: +len };
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      const url = new URL(a.URI, base).href;
      out.init = Object.assign({ url }, a.BYTERANGE ? parseRange(a.BYTERANGE, url) : { offset: 0, length: null });
    } else if (line.startsWith('#EXTINF:')) {
      dur = parseFloat(line.slice(8));
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      range = line.slice(17);
    } else if (!line.startsWith('#')) {
      const url = new URL(line, base).href;
      const r = range ? parseRange(range, url) : { offset: 0, length: null };
      out.segments.push({ start: t, dur, url, offset: r.offset, length: r.length });
      t += dur;
      range = null;
    }
  }
  return out;
}

// A refused request (the video access has expired) renews the session once and retries
// (see 36-session.js), so background work continues where it was.
function fetchOk(url, init, renewed) {
  return fetch(url, Object.assign({ credentials: 'include' }, init)).then((r) => {
    if ((r.status === 401 || r.status === 403) && !renewed && mediaSession.renew) {
      return mediaSession.renew().then(() => fetchOk(url, init, true));
    }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url.split('?')[0]);
    return r;
  });
}

function fetchRange(url, offset, length, signal) {
  const headers = length === null ? {} : { Range: 'bytes=' + offset + '-' + (offset + length - 1) };
  return fetchOk(url, { headers, signal }).then((r) => r.arrayBuffer());
}

// IndexedDB, one object store. Reads and ordinary writes never throw (a cache that cannot
// be used just means work is done again) but failures are logged; writes whose loss the
// user would notice (slide files, a restore) use putStrict, which throws. A failed open is
// tried again on the next call; when another tab needs a newer database version, this
// connection closes so it is not in the way.
const idbCache = {
  db: null,
  open() {
    if (this.db) return this.db;
    const p = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
      const req = indexedDB.open('echo360lite', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('cache')) req.result.createObjectStore('cache'); };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); if (this.db === p) this.db = null; };
        db.onclose = () => { if (this.db === p) this.db = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => log.warn('storage: opening is blocked by another tab');
    });
    this.db = p;
    p.catch((e) => { if (this.db === p) this.db = null; log.warn('storage unavailable:', e); });
    return p;
  },
  tx(mode, fn) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('cache', mode);
      const req = fn(tx.objectStore('cache'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  },
  soft(what, key, p) {
    return p.catch((e) => { log.warn('storage ' + what + ' failed (' + String(key).split(':')[0] + '):', e); return undefined; });
  },
  get(key) { return this.soft('read', key, this.tx('readonly', (s) => s.get(key))); },
  put(key, value) { return storageLock.frozen ? Promise.resolve() : this.soft('write', key, this.tx('readwrite', (s) => s.put(value, key))); },
  putStrict(key, value) { return this.tx('readwrite', (s) => s.put(value, key)); },
  // Several entries in one transaction: all are written or none (throws on failure).
  putMany(entries) {
    if (!entries.length) return Promise.resolve();
    return this.tx('readwrite', (s) => { let req = null; for (const [k, v] of entries) req = s.put(v, k); return req; });
  },
  del(key) { return this.soft('delete', key, this.tx('readwrite', (s) => s.delete(key))); },
  keys() { return this.soft('list', '', this.tx('readonly', (s) => s.getAllKeys())).then((k) => k || []); },
  // Read, change and write one entry in a single transaction (no other tab or task can
  // write in between). fn(old) returns the new value, or undefined to delete the entry.
  // Resolves to the new value.
  update(key, fn) {
    if (storageLock.frozen) return Promise.resolve(undefined);
    return this.open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('cache', 'readwrite');
      const os = tx.objectStore('cache');
      let next;
      const req = os.get(key);
      req.onsuccess = () => {
        try { next = fn(req.result); } catch (e) { tx.abort(); reject(e); return; }
        if (next === undefined) os.delete(key); else os.put(next, key);
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  },
};

// Background downloads must never compete with playback: turn() resolves only when the
// video is paused or has at least minBuffer seconds buffered ahead, after a pause of
// playingMs (pausedMs while paused). Everything rejects once the signal aborts.
class BackgroundGate {
  constructor(video, signal) {
    this.video = video;
    this.signal = signal;
  }

  wait(ms) {
    const signal = this.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      const onAbort = () => { clearTimeout(id); reject(new Error('aborted')); };
      const id = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async turn(playingMs, pausedMs, minBuffer) {
    const v = this.video;
    const need = minBuffer || BG_MIN_BUFFER_SEC;
    for (;;) {
      await this.wait(v.paused ? pausedMs : playingMs);
      if (v.seeking || v.readyState < 2) continue;
      if (v.paused || bufferedAhead(v) >= need) return;
    }
  }
}

function bufferedAhead(v) {
  const t = v.currentTime;
  const b = v.buffered;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) > t) return b.end(i) - t;
  return 0;
}

function idle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 1000 });
    else setTimeout(resolve, 0);
  });
}
