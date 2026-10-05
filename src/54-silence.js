// ===================================================================================
// Silence analysis, and the audio-track reader it is built on.
//
// Data sources, best first:
//   1. Transcript timing: gaps between cues. Free, because the cues are loaded anyway.
//   2. The separate audio rendition (about 46 kbps, 40 MB for two hours): fetched in 60 s
//      byte ranges only while playback has enough buffer, decoded to 16 kHz mono by the
//      browser's decoder (which runs off the main thread), and reduced to a loudness
//      envelope of one value per 0.1 s. The envelope is cached in IndexedDB, so a later
//      visit shows it at once and an unfinished analysis continues where it stopped.
//
// The pieces are meant to be reused by later features that read the same audio and cut it
// at the same pauses (for example local transcription):
//   HlsAudioTrack     open(), duration, chunkCount, chunkSpan(i), readChunk(i) -> { start, end, rate, pcm }
//   Envelope          step, length, db(i), dbAt(t), known(i), fill(start, pcm, rate), coverage()
//   findSilences(env, opts)            -> { silences: [{ start, end }], noiseDb, speechDb, thresholdDb }
//   silencesFromCues(cues, dur, opts)  -> [{ start, end }]
//   speechSpans(silences, dur, env, maxSec) -> speech between silences, each piece at most
//                                         maxSec long and cut at its quietest moment
//   SilenceAnalyzer   source, silences, track, env, progress; onChange
// ===================================================================================

const AUDIO_RATE = 16000;          // speech models expect this; plenty for loudness
const CHUNK_SEGMENTS = 6;          // 6 x 10 s HLS segments per request and decode
const ENV_STEP = 0.1;              // envelope resolution in seconds
const SILENCE_PAD = 0.5;           // seconds kept at each edge so skipping never clips speech
const SILENCE_BRIDGE = 1.5;        // a louder blip shorter than this inside a pause stays silent
const SILENCE_MIN_CHOICES = [15, 30, 60, 120];
const SILENCE_SENSITIVITY = { low: 0.2, normal: 0.3, high: 0.4 };

// ---- HLS playlists ----

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

// URI of the audio rendition used by the lowest-bandwidth variant of a master playlist.
function pickAudioRendition(master) {
  const groups = new Map();
  let best = null;
  const lines = String(master).split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI && !groups.has(a['GROUP-ID'])) groups.set(a['GROUP-ID'], a.URI);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice(18));
      const bw = +a.BANDWIDTH || Infinity;
      if (a.AUDIO && groups.has(a.AUDIO) && (!best || bw < best.bw)) best = { bw, uri: groups.get(a.AUDIO) };
    }
  }
  return best ? best.uri : (groups.size ? groups.values().next().value : null);
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

// Reads the separate audio rendition of an HLS stream as PCM, one chunk at a time.
class HlsAudioTrack {
  constructor(masterUrl) {
    this.masterUrl = masterUrl;
    this.segments = [];
    this.init = null;
    this.initBytes = null;
    this.duration = 0;
  }

  async open(signal) {
    const master = await (await fetchOk(this.masterUrl, { signal })).text();
    const uri = pickAudioRendition(master);
    if (!uri) throw new Error('no separate audio rendition');
    this.playlistUrl = new URL(uri, this.masterUrl).href;
    const pl = parseMediaPlaylist(await (await fetchOk(this.playlistUrl, { signal })).text(), this.playlistUrl);
    if (!pl.segments.length) throw new Error('empty audio playlist');
    this.init = pl.init;
    this.segments = pl.segments;
    const last = pl.segments[pl.segments.length - 1];
    this.duration = last.start + last.dur;
    return this;
  }

  get chunkCount() { return Math.ceil(this.segments.length / CHUNK_SEGMENTS); }

  chunkSpan(i) {
    const segs = this.segments.slice(i * CHUNK_SEGMENTS, (i + 1) * CHUNK_SEGMENTS);
    const last = segs[segs.length - 1];
    return { start: segs[0].start, end: last.start + last.dur };
  }

  chunkAt(t) {
    return clamp(Math.floor(t / (this.duration / this.segments.length) / CHUNK_SEGMENTS), 0, this.chunkCount - 1);
  }

  // Decoded audio of chunk i: { start, end, rate, pcm } with pcm a mono Float32Array.
  async readChunk(i, signal, rate) {
    const sampleRate = rate || AUDIO_RATE;
    const segs = this.segments.slice(i * CHUNK_SEGMENTS, (i + 1) * CHUNK_SEGMENTS);
    if (!segs.length) throw new Error('no chunk ' + i);
    if (this.init && !this.initBytes) this.initBytes = await fetchRange(this.init.url, this.init.offset, this.init.length, signal);
    // Adjacent byte ranges of the same file are fetched with one request.
    const reqs = [];
    for (const s of segs) {
      const prev = reqs[reqs.length - 1];
      if (prev && s.length !== null && prev.length !== null && prev.url === s.url && prev.offset + prev.length === s.offset) prev.length += s.length;
      else reqs.push({ url: s.url, offset: s.offset, length: s.length });
    }
    const parts = [];
    if (this.initBytes) parts.push(this.initBytes);
    for (const r of reqs) parts.push(await fetchRange(r.url, r.offset, r.length, signal));
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) { bytes.set(new Uint8Array(p), o); o += p.byteLength; }
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ab = await new Offline(1, sampleRate, sampleRate).decodeAudioData(bytes.buffer);
    let pcm = ab.getChannelData(0);
    if (ab.numberOfChannels > 1) {
      pcm = Float32Array.from(pcm);
      for (let c = 1; c < ab.numberOfChannels; c++) {
        const ch = ab.getChannelData(c);
        for (let k = 0; k < pcm.length; k++) pcm[k] += ch[k];
      }
      for (let k = 0; k < pcm.length; k++) pcm[k] /= ab.numberOfChannels;
    }
    const last = segs[segs.length - 1];
    return { start: segs[0].start, end: last.start + last.dur, rate: ab.sampleRate, pcm };
  }
}

// ---- loudness envelope ----

// Speech-band level (roughly 150 Hz to 4 kHz, so air-conditioning rumble counts as quiet)
// per ENV_STEP seconds, stored as one byte: 0 = not analysed yet, 1..255 = -100..0 dBFS.
class Envelope {
  constructor(duration, data) {
    this.step = ENV_STEP;
    this.length = Math.max(1, Math.ceil(duration / ENV_STEP));
    this.data = data && data.length === this.length ? data : new Uint8Array(this.length);
  }

  known(i) { return this.data[i] !== 0; }

  db(i) {
    const v = this.data[i];
    return v ? -100 + (v - 1) / 2.54 : NaN;
  }

  dbAt(t) { return this.db(clamp(Math.floor(t / this.step), 0, this.length - 1)); }

  fill(start, pcm, rate) {
    const per = Math.round(rate * this.step);
    // One-pole high-pass and low-pass filters; the state restarts with every chunk.
    const hpA = Math.exp(-2 * Math.PI * 150 / rate);
    const lpA = Math.exp(-2 * Math.PI * 4000 / rate);
    let hpPrevIn = 0;
    let hpPrevOut = 0;
    let lp = 0;
    const first = Math.round(start / this.step);
    for (let f = 0; (f + 1) * per <= pcm.length; f++) {
      const i = first + f;
      let sum = 0;
      for (let k = f * per, end = k + per; k < end; k++) {
        const x = pcm[k];
        const hp = hpA * (hpPrevOut + x - hpPrevIn);
        hpPrevIn = x;
        hpPrevOut = hp;
        lp = lp * lpA + hp * (1 - lpA);
        sum += lp * lp;
      }
      if (i < 0 || i >= this.length) continue;
      const db = 10 * Math.log10(sum / per + 1e-12);
      this.data[i] = 1 + Math.round((clamp(db, -100, 0) + 100) * 2.54);
    }
  }

  coverage() {
    let n = 0;
    for (let i = 0; i < this.length; i++) if (this.data[i]) n++;
    return n / this.length;
  }

  // Share of frames analysed in [start, end).
  coverageOf(start, end) {
    const a = clamp(Math.floor(start / this.step), 0, this.length);
    const b = clamp(Math.ceil(end / this.step), a, this.length);
    let n = 0;
    for (let i = a; i < b; i++) if (this.data[i]) n++;
    return b > a ? n / (b - a) : 1;
  }
}

// ---- finding silence ----

function percentile(sorted, p) {
  return sorted[clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1)];
}

// Quiet stretches of an envelope. The threshold adapts to the recording: a point between
// its noise floor (10th percentile) and its speech level (90th percentile), so a recording
// that is quiet overall is not marked silent as a whole.
function findSilences(env, opts) {
  const o = Object.assign({ minSec: 30, sensitivity: 'normal', pad: SILENCE_PAD, bridge: SILENCE_BRIDGE }, opts);
  const vals = [];
  for (let i = 0; i < env.length; i++) if (env.known(i)) vals.push(env.db(i));
  const result = { silences: [], noiseDb: NaN, speechDb: NaN, thresholdDb: NaN };
  if (vals.length < 60 / env.step) return result; // less than a minute analysed
  vals.sort((a, b) => a - b);
  const noise = percentile(vals, 0.1);
  const speech = percentile(vals, 0.9);
  const k = SILENCE_SENSITIVITY[o.sensitivity] || SILENCE_SENSITIVITY.normal;
  let thr = noise + (speech - noise) * k;
  // No dynamics at all: either everything is silent (a muted microphone) or nothing is.
  if (speech - noise < 6) thr = speech < -55 ? 1 : -101;
  Object.assign(result, { noiseDb: noise, speechDb: speech, thresholdDb: thr });

  // Quiet runs in frames; unanalysed frames end a run.
  const runs = [];
  let a = -1;
  for (let i = 0; i <= env.length; i++) {
    const quiet = i < env.length && env.known(i) && env.db(i) < thr;
    if (quiet && a < 0) a = i;
    else if (!quiet && a >= 0) { runs.push([a, i]); a = -1; }
  }
  // Bridge a short louder blip (a cough, a door) between two long quiet runs. Quiet talk
  // also has short gaps between words, but there the quiet runs on either side are short,
  // so it stays speech.
  const bridge = Math.round(o.bridge / env.step);
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    let ok = prev && r[0] - prev[1] <= bridge && prev[1] - prev[0] >= 2 * bridge && r[1] - r[0] >= 2 * bridge;
    if (ok) for (let i = prev[1]; i < r[0]; i++) if (!env.known(i)) { ok = false; break; }
    if (ok) prev[1] = r[1]; else merged.push(r.slice());
  }
  for (const [s, e] of merged) {
    const start = s * env.step + o.pad;
    const end = Math.min(e * env.step, env.length * env.step) - o.pad;
    if (end - start >= o.minSec) result.silences.push({ start, end });
  }
  return result;
}

// Gaps of at least minSec between transcript cues (and before the first / after the last).
function silencesFromCues(cues, duration, opts) {
  const o = Object.assign({ minSec: 30, pad: SILENCE_PAD }, opts);
  const out = [];
  let lastEnd = 0;
  const gap = (a, b) => {
    const start = a + (a > 0 ? o.pad : 0);
    const end = b - o.pad;
    if (end - start >= o.minSec) out.push({ start, end });
  };
  for (const c of cues) {
    if (c.start > lastEnd) gap(lastEnd, c.start);
    lastEnd = Math.max(lastEnd, c.end);
  }
  if (isFinite(duration) && duration > lastEnd) gap(lastEnd, duration + o.pad);
  return out;
}

// Speech between the silences, split into pieces no longer than maxSec. A long piece is
// cut at the quietest analysed moment in the last half of each window.
function speechSpans(silences, duration, env, maxSec) {
  const spans = [];
  let t = 0;
  const push = (a, b) => {
    while (b - a > maxSec) {
      let cut = a + maxSec;
      if (env) {
        let best = Infinity;
        const from = Math.ceil((a + maxSec / 2) / env.step);
        const to = Math.min(Math.floor((a + maxSec) / env.step), env.length - 1);
        for (let i = from; i <= to; i++) {
          if (env.known(i) && env.db(i) < best) { best = env.db(i); cut = i * env.step; }
        }
      }
      spans.push({ start: a, end: cut });
      a = cut;
    }
    if (b > a) spans.push({ start: a, end: b });
  };
  for (const s of silences) {
    if (s.start > t) push(t, s.start);
    t = Math.max(t, s.end);
  }
  if (duration > t) push(t, duration);
  return spans;
}

// Index of the silence containing t, or -1. Silences are sorted and disjoint.
function silenceIndexAt(silences, t) {
  let lo = 0;
  let hi = silences.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (silences[mid].end <= t) lo = mid + 1;
    else if (silences[mid].start > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}

// ---- cache ----

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

// ---- the controller used by the player ----

class SilenceAnalyzer {
  // opts: { lesson, video, masterUrl, disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.masterUrl = opts.masterUrl;
    this.onChange = opts.onChange || (() => {});
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.source = 'pending';     // pending | transcript | audio | unavailable
    this.reason = '';
    this.progress = 0;
    this.silences = [];
    this.cues = null;
    this.track = null;
    this.env = null;
    this.options = { minSec: 30, sensitivity: 'normal' };
    this.stats = null;
  }

  setOptions(o) {
    Object.assign(this.options, o);
    this.recompute();
  }

  // Called once the transcript is known ([] when there is none).
  start(cues) {
    if (cues && cues.length && !store.get('silenceFromAudio', false)) {
      this.cues = cues;
      this.source = 'transcript';
      this.progress = 1;
      this.recompute();
      return;
    }
    if (!this.masterUrl) { this.fail('noAudio'); return; }
    this.source = 'audio';
    this.runAudio().catch((e) => {
      if (this.ac.signal.aborted) return;
      console.warn(TAG, 'silence analysis stopped:', e && e.message ? e.message : e);
      this.fail('error');
    });
  }

  fail(reason) {
    this.source = 'unavailable';
    this.reason = reason;
    this.silences = [];
    this.onChange();
  }

  recompute() {
    const dur = this.duration();
    if (this.source === 'transcript') {
      this.silences = silencesFromCues(this.cues, dur, { minSec: this.options.minSec });
    } else if (this.source === 'audio' && this.env) {
      const r = findSilences(this.env, this.options);
      this.silences = r.silences;
      this.stats = { noiseDb: r.noiseDb, speechDb: r.speechDb, thresholdDb: r.thresholdDb };
    } else return;
    this.onChange();
  }

  duration() {
    const v = this.video.duration;
    return isFinite(v) && v > 0 ? v : this.lesson.duration;
  }

  async runAudio() {
    const signal = this.ac.signal;
    if (navigator.connection && navigator.connection.saveData) { this.fail('saveData'); return; }
    const key = 'silence-env:' + this.lesson.mediaId;
    const cached = this.lesson.mediaId ? await idbCache.get(key) : undefined;
    await this.wait(cached ? 0 : 8000); // let playback start first
    const track = await new HlsAudioTrack(this.masterUrl).open(signal);
    this.track = track;
    const data = cached && cached.v === 1 && cached.step === ENV_STEP ? cached.data : null;
    this.env = new Envelope(track.duration, data);
    this.progress = this.env.coverage();
    this.recompute();

    // Upcoming audio first, then the rest from the beginning.
    const n = track.chunkCount;
    const from = track.chunkAt(this.video.currentTime || 0);
    const order = [];
    for (let k = 0; k < n; k++) order.push((from + k) % n);
    let sinceSave = 0;
    for (const i of order) {
      const span = track.chunkSpan(i);
      if (this.env.coverageOf(span.start, span.end) > 0.9) continue;
      await this.waitForTurn();
      const chunk = await track.readChunk(i, signal);
      await idle();
      if (signal.aborted) return;
      this.env.fill(chunk.start, chunk.pcm, chunk.rate);
      this.progress = this.env.coverage();
      if (++sinceSave >= 5) {
        sinceSave = 0;
        this.save(key);
        this.recompute();
      }
    }
    this.progress = 1;
    this.save(key);
    this.recompute();
  }

  save(key) {
    if (this.lesson.mediaId) idbCache.put(key, { v: 1, step: ENV_STEP, data: this.env.data, at: Date.now() });
  }

  wait(ms) {
    const signal = this.ac.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      const onAbort = () => { clearTimeout(id); reject(new Error('aborted')); };
      const id = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Background downloads must never compete with playback: go on only when the video is
  // paused or has at least 20 s buffered ahead, and pace the requests.
  async waitForTurn() {
    const v = this.video;
    for (;;) {
      await this.wait(v.paused ? 400 : 2000);
      if (v.seeking || v.readyState < 2) continue;
      if (v.paused || bufferedAhead(v) >= 20) return;
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
