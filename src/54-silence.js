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

// ---- the audio track ----

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
// Stretches that can be skipped, from silences and from stretches where the screen shows
// one colour (`uniform`, from the slide analysis):
//   kind 'silence'  silent, picture as usual
//   kind 'blank'    silent and the screen empty (at least half of the silence)
//   kind 'black'    the screen empty while nothing is known about the audio (no transcript,
//                   audio not analysed): marked and skippable by hand, never automatically.
// An empty screen with someone speaking is not skippable. Sorted by start.
function skipStretches(silences, uniform, audioKnown, minSec) {
  const overlap = (a, b) => {
    let n = 0;
    for (const u of uniform) n += Math.max(0, Math.min(b, u.end) - Math.max(a, u.start));
    return n;
  };
  const out = silences.map((x) => ({ start: x.start, end: x.end, kind: overlap(x.start, x.end) >= 0.5 * (x.end - x.start) ? 'blank' : 'silence' }));
  if (!audioKnown) {
    for (const u of uniform) if (u.end - u.start >= minSec) out.push({ start: u.start, end: u.end, kind: 'black' });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Where the lecture's content ends: the start of an empty stretch (blank or black) that
// runs to the end of the recording (within `slack` seconds, one sample), else the duration.
function contentEndAt(stretches, duration, slack) {
  const last = stretches[stretches.length - 1];
  if (last && (last.kind === 'blank' || last.kind === 'black') && last.end >= duration - (slack == null ? 15 : slack)) return last.start;
  return duration;
}

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

// ---- the controller used by the player ----

class SilenceAnalyzer {
  // opts: { lesson, video, masterUrl, disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.masterUrl = opts.masterUrl;
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('silence detection (display)', e); } };
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
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
      log.warn('silence analysis stopped:', e && e.message ? e.message : e);
      this.fail('error');
    });
  }

  // The analysis stopped. Silences already found from the audio are kept (and stay
  // cached); only when nothing was found is the feature unavailable.
  fail(reason) {
    this.reason = reason;
    if (this.env && this.env.coverage() > 0) { this.recompute(); return; }
    this.source = 'unavailable';
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
    await this.gate.wait(cached ? 0 : 8000); // let playback start first
    const track = await new HlsAudioTrack(this.masterUrl).open(signal);
    this.track = track;
    const data = cacheValid('silence-env', cached) && cached.step === ENV_STEP ? cached.data : null;
    if (data) cacheTouch(key);
    this.env = new Envelope(track.duration, data);
    this.progress = this.env.coverage();
    this.recompute();

    // Upcoming audio first, then the rest from the beginning.
    const n = track.chunkCount;
    const from = track.chunkAt(this.video.currentTime || 0);
    const order = [];
    for (let k = 0; k < n; k++) order.push((from + k) % n);
    let sinceSave = 0;
    let fails = 0;
    for (const i of order) {
      const span = track.chunkSpan(i);
      if (this.env.coverageOf(span.start, span.end) > 0.9) continue;
      await this.gate.turn(2000, 400);
      // A chunk that cannot be read or decoded is left out (that stretch stays unknown,
      // never "silent"); only several in a row end the analysis, keeping what was found.
      let chunk;
      try {
        chunk = await track.readChunk(i, signal);
        fails = 0;
      } catch (e) {
        if (signal.aborted) return;
        if (++fails >= ANALYSIS_MAX_FAILS) { this.save(key); this.recompute(); throw e; }
        log.warn('silence detection: chunk ' + i + ' skipped:', e);
        continue;
      }
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
    if (this.lesson.mediaId) idbCache.put(key, { v: cacheVersion('silence-env'), used: Date.now(), step: ENV_STEP, data: this.env.data, at: Date.now() });
  }

}
