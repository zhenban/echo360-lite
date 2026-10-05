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

function fetchOk(url, init) {
  return fetch(url, Object.assign({ credentials: 'include' }, init)).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url.split('?')[0]);
    return r;
  });
}

function fetchRange(url, offset, length, signal) {
  const headers = length === null ? {} : { Range: 'bytes=' + offset + '-' + (offset + length - 1) };
  return fetchOk(url, { headers, signal }).then((r) => r.arrayBuffer());
}

const idbCache = {
  db: null,
  open() {
    if (this.db) return this.db;
    this.db = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
      const req = indexedDB.open('echo360lite', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('cache')) req.result.createObjectStore('cache'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    this.db.catch(() => {});
    return this.db;
  },
  tx(mode, fn) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('cache', mode);
      const req = fn(tx.objectStore('cache'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  },
  get(key) { return this.tx('readonly', (s) => s.get(key)).catch(() => undefined); },
  put(key, value) { return this.tx('readwrite', (s) => s.put(value, key)).catch(() => undefined); },
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
    const need = minBuffer || 20;
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
