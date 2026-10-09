// Unit tests for the pure logic in src/ (no browser needed).
//   npm test        (or: node --test test/*.test.mjs)
// The sources are plain scripts meant to be concatenated, so they are evaluated in a small
// sandbox with just enough browser globals stubbed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadSources(names, overrides) {
  const timers = [];
  const ctx = {
    console, URL,
    AudioContext: class {},
    window: {},
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: (...a) => ctx.__fetch(...a),
    Blob, TextEncoder, AbortController, location: { origin: 'https://echo360.example', hash: '' },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    setTimeout, clearTimeout,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    __timers: timers,
  };
  Object.assign(ctx, overrides || {});
  // As in a page: window is the global object (page scripts set window.Echo, read Echo).
  if (ctx.window === 'global') ctx.window = ctx;
  vm.createContext(ctx);
  const files = readdirSync(join(root, 'src')).filter((f) => f.startsWith('02-tuning') || f.startsWith('03-common') || names.some((n) => f === n + '.js' || f.startsWith(n + '-'))).sort();
  const code = files.map((f) => readFileSync(join(root, 'src', f), 'utf8')).join('\n')
    + '\n;globalThis.__exports = {};'
    + ['clamp', 'fmtTime', 'parseIsoDuration', 'Disposer', 'PlayedRanges', 'Reporter', 'FollowerSync', 'CueIndex', 'parseVtt', 'echo360ClassroomAdapter', 'AudioChain', 'seg', 'Echo360Api', 'thumbnailFor', 'pickAudioRendition', 'parseMediaPlaylist', 'Envelope', 'findSilences', 'silencesFromCues', 'speechSpans', 'silenceIndexAt', 'mp4Boxes', 'parseFragment', 'videoVariants', 'Stream', 'pickScreen', 'slightChange', 'thumbChange', 'learnThreshold', 'sampleChanges', 'groupSegments', 'sampleIndexAt', 'HlsVideoReader', 'buildScenes', 'chapterIndexAt', 'SessionKeeper', 'mediaSession', 'TagStore', 'watchedShare', 'makeZip', 'crc32', 'lectureMarkdown', 'mdTag', 'followSamples', 'followLecture', 'textScores', 'slideWords', 'ocrLanguage', 'TESS_LANGS', 'slideTextWorkerSource', 'FORCE_OFF', 'captionExcerpt',
      'sanitizePrefs', 'sanitizePos', 'prefDefaults', 'guard', 'guardCore', 'featureGuard', 'unexpected', 'featureErrors', 'eventLog', 'SilenceAnalyzer', 'skipStretches', 'contentEndAt', 'frameUniform', 'uniformStretches', 'maskUrls', 'diagnosticsText', 'cacheTouched', 'cacheLastUse', 'cacheValid', 'restoreBackup', 'makeBackup', 'idbCache', 'LitePlayer', 'NotesPane', 'DiscussionPane', 'SlideTextReader', 'SlideTextWorker', 'SlideDeckController', 'playerTemplate', 'NS']
      .map((n) => `if (typeof ${n} !== 'undefined') globalThis.__exports.${n} = ${n};`).join('\n');
  vm.runInContext(code, ctx);
  return { ...ctx.__exports, timers, window: ctx.window, setFetch: (fn) => { ctx.__fetch = fn; } };
}

// Minimal HTMLMediaElement stand-in: tracks listeners, play/pause and currentTime writes.
class FakeVideo {
  constructor() {
    this.listeners = {};
    this.paused = true;
    this.seeking = false;
    this.readyState = 4;
    this.currentTime = 0;
    this.playbackRate = 1;
    this.muted = false;
    this.seeks = 0;
    this.plays = 0;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  emit(type) { for (const fn of this.listeners[type] || []) fn({ type }); }
  play() { this.plays++; this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  seekTo(t) { this.currentTime = t; this.seeks++; }
}

function setupSync() {
  const m = loadSources(['00-util', '38-sync']);
  const clock = new FakeVideo();
  const follower = new FakeVideo();
  // Count seeks on the follower by intercepting currentTime writes.
  let ct = 0;
  Object.defineProperty(follower, 'currentTime', { get: () => ct, set: (v) => { ct = v; follower.seeks++; }, configurable: true });
  const sync = new m.FollowerSync(clock, follower);
  const tick = () => { for (const tm of m.timers) if (tm.fn && tm.ms === 1000) tm.fn(); };
  return { m, clock, follower, sync, tick, setFollowerTime: (v) => { ct = v; } };
}

test('fmtTime and parseIsoDuration', () => {
  const m = loadSources(['00-util']);
  assert.equal(m.fmtTime(0), '0:00');
  assert.equal(m.fmtTime(65), '1:05');
  assert.equal(m.fmtTime(3725), '1:02:05');
  assert.equal(m.fmtTime(65, true), '0:01:05');
  assert.equal(m.parseIsoDuration('PT6895.072S'), 6895.072);
  assert.equal(m.parseIsoDuration('PT1H2M3S'), 3723);
  assert.ok(Number.isNaN(m.parseIsoDuration('bogus')));
});

test('Disposer releases in reverse order, once, including children', () => {
  const m = loadSources(['00-util']);
  const order = [];
  const d = new m.Disposer();
  d.add(() => order.push('a'));
  const c = d.child();
  c.add(() => order.push('child'));
  d.add(() => order.push('b'));
  d.dispose();
  d.dispose();
  assert.deepEqual(order, ['b', 'child', 'a']);
  let late = false;
  d.add(() => { late = true; });
  assert.ok(late, 'resources added after dispose are released immediately');
});

test('PlayedRanges merges overlapping and adjacent ranges', () => {
  const m = loadSources(['20-reporter', '00-util']);
  const p = new m.PlayedRanges();
  p.add(10, 20);
  p.add(30, 40);
  p.add(15, 32);
  p.add(50, 50);
  assert.deepEqual(JSON.parse(JSON.stringify(p.ranges)), [[10, 40]]);
  const tr = { length: 1, start: () => 45, end: () => 60 };
  assert.deepEqual(JSON.parse(JSON.stringify(p.merged(tr))), [[10, 40], [45, 60]]);
  assert.equal(p.ranges.length, 1, 'merged() does not mutate');
});

test('FollowerSync mirrors play, pause, waiting, seek and rate', () => {
  const { clock, follower, setFollowerTime } = setupSync();
  assert.equal(follower.muted, true);
  clock.currentTime = 100;
  setFollowerTime(0);
  clock.paused = false;
  clock.emit('play');
  assert.equal(follower.currentTime, 100, 'aligned on play');
  assert.equal(follower.paused, false);
  clock.emit('waiting');
  assert.equal(follower.paused, true, 'follower waits while the clock buffers');
  clock.emit('playing');
  assert.equal(follower.paused, false);
  clock.currentTime = 500;
  clock.emit('seeking');
  assert.equal(follower.currentTime, 500, 'aligned on seek');
  clock.playbackRate = 1.75;
  clock.emit('ratechange');
  assert.equal(follower.playbackRate, 1.75);
  clock.paused = true;
  clock.emit('pause');
  assert.equal(follower.paused, true);
});

test('FollowerSync nudges small drift and seeks large drift', () => {
  const { clock, follower, tick, setFollowerTime } = setupSync();
  clock.paused = false;
  clock.emit('play');
  clock.playbackRate = 1.5;
  follower.playbackRate = 1.5;

  // Within tolerance: nothing changes.
  clock.currentTime = 200;
  setFollowerTime(200.05);
  const seeksBefore = follower.seeks;
  tick();
  assert.equal(follower.playbackRate, 1.5);
  assert.equal(follower.seeks, seeksBefore);

  // Follower 0.4 s ahead: slowed down, not seeked.
  setFollowerTime(200.4);
  tick();
  assert.ok(follower.playbackRate < 1.5 && follower.playbackRate >= 1.5 * 0.9, 'slowed within 10%');
  assert.equal(follower.seeks, seeksBefore);

  // Follower 0.4 s behind: sped up.
  setFollowerTime(199.6);
  tick();
  assert.ok(follower.playbackRate > 1.5 && follower.playbackRate <= 1.5 * 1.1, 'sped up within 10%');

  // Back in tolerance: rate restored.
  setFollowerTime(200.0);
  tick();
  assert.equal(follower.playbackRate, 1.5);

  // 3 s behind: seek to the clock (slightly ahead), rate reset.
  setFollowerTime(197);
  tick();
  assert.equal(follower.seeks, seeksBefore + 1);
  assert.ok(Math.abs(follower.currentTime - 200.15) < 1e-9);
  assert.equal(follower.playbackRate, 1.5);
});

test('FollowerSync check timer runs only while playing and stops on dispose', () => {
  const { m, clock, sync } = setupSync();
  const active = () => m.timers.filter((tm) => tm.fn && tm.ms === 1000).length;
  assert.equal(active(), 0, 'no timer while paused');
  clock.paused = false;
  clock.emit('play');
  assert.equal(active(), 1);
  clock.emit('play');
  assert.equal(active(), 1, 'never more than one timer');
  clock.paused = true;
  clock.emit('pause');
  assert.equal(active(), 0);
  clock.paused = false;
  clock.emit('play');
  sync.dispose();
  assert.equal(active(), 0, 'dispose stops the timer');
  assert.equal((clock.listeners.play || []).length, 0, 'dispose removes listeners');
});

test('FollowerSync does not align before the clock has loaded', () => {
  const { clock, follower, setFollowerTime } = setupSync();
  clock.readyState = 0;
  clock.currentTime = 0;
  setFollowerTime(1234);
  follower.emit('loadedmetadata');
  assert.equal(follower.currentTime, 1234, 'follower keeps its start position');
});

test('CueIndex finds the started and active cue, sequentially and after seeks', () => {
  const m = loadSources(['00-util', '53-captions']);
  const cues = [{ start: 1, end: 2 }, { start: 3, end: 5 }, { start: 5, end: 6 }, { start: 10, end: 12 }];
  const ix = new m.CueIndex(cues);
  assert.equal(ix.started(0.5), -1);
  assert.equal(ix.active(0.5), -1);
  assert.equal(ix.active(1.5), 0);
  assert.equal(ix.active(2.5), -1, 'gap between cues');
  assert.equal(ix.started(2.5), 0, 'started() keeps the previous cue in a gap');
  assert.equal(ix.active(3), 1);
  assert.equal(ix.active(5), 2, 'boundary belongs to the next cue');
  assert.equal(ix.active(11), 3, 'jump forward');
  assert.equal(ix.active(1.2), 0, 'seek back');
  assert.equal(ix.started(99), 3);
  const empty = new m.CueIndex([]);
  assert.equal(empty.active(3), -1);
});

test('parseVtt reads timings, drops NOTE blocks and voice tags', () => {
  const m = loadSources(['00-util', '10-adapter']);
  const vtt = 'WEBVTT\n\n00:00:02.230 --> 00:00:02.900\n<v Speaker 0>Hello, hello.\n\nNOTE CONF {"raw":[99,98]}\n\n'
    + '01:02:03.5 --> 01:02:04.000\nTwo &amp; three\nlines <b>here</b>\n';
  const cues = JSON.parse(JSON.stringify(m.parseVtt(vtt)));
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 2.23, end: 2.9, text: 'Hello, hello.', speaker: 'Speaker 0' });
  assert.equal(cues[1].start, 3723.5);
  assert.equal(cues[1].text, 'Two & three lines here');
});

// Fake Web Audio graph that records connections, to check AudioChain's wiring.
function fakeAudio() {
  const edges = new Set();
  class Node {
    constructor(name) { this.name = name; }
    connect(to) { edges.add(this.name + '>' + to.name); return to; }
    disconnect() { for (const e of [...edges]) if (e.startsWith(this.name + '>')) edges.delete(e); }
  }
  const param = () => ({ value: 0, setTargetAtTime() {}, cancelScheduledValues() {} });
  let k = 0;
  const mk = (kind) => Object.assign(new Node(kind + (k++)), { kind, gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  class Ctx {
    constructor() { this.destination = new Node('dest'); this.state = 'running'; this.currentTime = 0; }
    createMediaElementSource() { return new Node('src'); }
    createGain() { return mk('gain'); }
    createBiquadFilter() { return mk('biquad'); }
    createDynamicsCompressor() { return mk('comp'); }
    createAnalyser() { const a = mk('analyser'); a.fftSize = 2048; return a; }
    close() { return Promise.resolve(); }
  }
  return { Ctx, edges };
}

// Follows connections from the source and returns the node kinds on the path to dest.
function pathFromSource(edges) {
  const out = (n) => [...edges].filter((e) => e.startsWith(n + '>')).map((e) => e.split('>')[1]);
  const names = [];
  let cur = 'src';
  for (let guard = 0; guard < 20 && cur !== 'dest'; guard++) {
    const next = out(cur).filter((x) => !x.startsWith('analyser'));
    assert.equal(next.length, 1, 'single audible path from ' + cur + ': ' + next);
    cur = next[0];
    names.push(cur.replace(/\d+$/, ''));
  }
  return names;
}

test('AudioChain wires only the enabled stages (all off = direct)', () => {
  const m = loadSources(['00-util', '60-audio']);
  const { Ctx, edges } = fakeAudio();
  m.window.AudioContext = Ctx;
  const chain = new m.AudioChain({ paused: true });
  chain.reason = null;
  assert.equal(chain.build(), true);
  assert.deepEqual(pathFromSource(edges), ['dest'], 'all off: source straight to output');
  chain.set({ mono: true });
  assert.deepEqual(pathFromSource(edges), ['gain', 'dest']);
  chain.set({ mono: false, voice: true });
  assert.deepEqual(pathFromSource(edges), ['biquad', 'biquad', 'dest']);
  chain.set({ voice: true, level: true });
  assert.deepEqual(pathFromSource(edges), ['biquad', 'biquad', 'comp', 'gain', 'comp', 'gain', 'dest']);
  chain.set({ mono: true, voice: false, level: true });
  assert.deepEqual(pathFromSource(edges), ['gain', 'comp', 'gain', 'comp', 'gain', 'dest']);
  chain.set({ mono: false, voice: false, level: false });
  assert.deepEqual(pathFromSource(edges), ['dest'], 'back to direct');
  assert.equal(chain.timer, 0, 'no levelling timer while paused or off');
});

test('AudioChain refuses to build when unsupported', () => {
  const m = loadSources(['00-util', '60-audio']);
  const chain = new m.AudioChain({ paused: true });
  chain.reason = 'nativeHls';
  assert.equal(chain.build(), false);
  assert.equal(chain.built, false);
});

test('API paths and thumbnailUri match what the original player sends', () => {
  const m = loadSources(['00-util', '10-adapter', '11-echo360-api']);
  const L = 'G_00000000-1111-2222-3333-444444444444_55555555-6666-7777-8888-999999999999_2026-01-01T09:00:00.000_2026-01-01T11:00:00.000';
  assert.equal(m.seg(L), L, 'lesson ids are used verbatim (":" and "." kept)');
  assert.equal(m.seg('a b/c'), 'a%20b%2Fc');
  const times = []; for (let x = 5; x <= 6845; x += 60) times.push(x);
  const thumbs = [{ baseUri: 'https://thumbnails.echo360.net.au/X/Y/1/thumbnails1', extension: 'jpg', timesInSeconds: times }];
  // Captured from the original player: timestampMillis 4645087 -> .../4625.jpg
  assert.equal(m.thumbnailFor(thumbs, 4645087), 'https://thumbnails.echo360.net.au/X/Y/1/thumbnails1/4625.jpg');
  assert.equal(m.thumbnailFor(thumbs, 4625000), 'https://thumbnails.echo360.net.au/X/Y/1/thumbnails1/4565.jpg', 'strictly before');
  assert.equal(m.thumbnailFor(thumbs, 1000), 'https://thumbnails.echo360.net.au/X/Y/1/thumbnails1/5.jpg', 'before the first: first');
  assert.equal(m.thumbnailFor([], 1000), '');
});

// ---- silence analysis ----

function silenceMod() {
  return loadSources(['00-util', '61-media-io', '62-silence']);
}

test('audio rendition of the lowest-bandwidth variant; media playlist byte ranges', () => {
  const { pickAudioRendition, parseMediaPlaylist } = silenceMod();
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="q0",NAME="Default",URI="s0q0.m3u8"\n'
    + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="q1",NAME="Default",URI="s0q1.m3u8"\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=2118548,RESOLUTION=1280x720,CODECS="avc1.640029,mp4a.40.2",AUDIO="q1"\ns1q1.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=613230,RESOLUTION=640x360,AUDIO="q0"\ns1q0.m3u8\n';
  assert.equal(pickAudioRendition(master), 's0q0.m3u8');
  const pl = parseMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="a.mp4",BYTERANGE="764@0"\n#EXTINF:10.0078,\n#EXT-X-BYTERANGE:100@764\na.mp4\n'
    + '#EXTINF:9.98,\n#EXT-X-BYTERANGE:50\na.mp4\n#EXT-X-ENDLIST\n', 'https://x.test/p/s0q0.m3u8?sig=1');
  assert.deepEqual({ ...pl.init }, { url: 'https://x.test/p/a.mp4', offset: 0, length: 764 });
  assert.equal(pl.segments.length, 2);
  assert.equal(pl.segments[1].offset, 864); // continues after the previous range
  assert.equal(pl.segments[1].length, 50);
  assert.ok(Math.abs(pl.segments[1].start - 10.0078) < 1e-9);
});

// Synthetic lecture: speech-like noise at `speechDb`, pauses at `quietDb`.
function synthEnvelope(m, dur, quiet, speechDb, quietDb) {
  const env = new m.Envelope(dur);
  const rate = 16000;
  for (let t0 = 0; t0 < dur; t0 += 60) {
    const n = Math.min(60, dur - t0) * rate;
    const pcm = new Float32Array(n);
    let seed = (t0 + 1) * 7919;
    for (let k = 0; k < n; k++) {
      const t = t0 + k / rate;
      const isQuiet = quiet.some(([a, b]) => t >= a && t < b);
      const amp = Math.pow(10, (isQuiet ? quietDb : speechDb) / 20) * Math.SQRT2;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      // 1 kHz tone plus noise: inside the speech band.
      pcm[k] = amp * (0.7 * Math.sin(2 * Math.PI * 1000 * t) + 0.3 * (seed / 0x7fffffff - 0.5));
    }
    env.fill(t0, pcm, rate);
  }
  return env;
}

test('silences follow the recording level (quiet recordings are not all silent)', () => {
  const m = silenceMod();
  const quiet = [[300, 420], [600, 610], [900, 960]];
  for (const speechDb of [-20, -45]) {
    const env = synthEnvelope(m, 1200, quiet, speechDb, speechDb - 30);
    assert.equal(env.coverage(), 1);
    const r = m.findSilences(env, { minSec: 30 });
    assert.equal(r.silences.length, 2, 'level ' + speechDb);
    assert.ok(Math.abs(r.silences[0].start - 300.5) < 0.3 && Math.abs(r.silences[0].end - 419.5) < 0.3, JSON.stringify(r.silences));
    assert.ok(Math.abs(r.silences[1].start - 900.5) < 0.3 && Math.abs(r.silences[1].end - 959.5) < 0.3);
    assert.equal(m.findSilences(env, { minSec: 5 }).silences.length, 3);
  }
  // A short cough in a pause does not split it.
  const env = synthEnvelope(m, 600, [[100, 150], [151, 200]], -20, -50);
  const r = m.findSilences(env, { minSec: 30 });
  assert.equal(r.silences.length, 1);
  assert.ok(r.silences[0].end - r.silences[0].start > 98);
  // Quiet talk in a break (words with short gaps) is not absorbed into the silence.
  const talk = [[100, 150]];
  for (let t = 150; t < 160; t += 1) talk.push([t + 0.5, t + 1]);
  talk.push([160, 220]);
  const env2 = synthEnvelope(m, 600, talk, -20, -60);
  const chatty = m.findSilences(env2, { minSec: 30 }).silences;
  assert.equal(chatty.length, 2, JSON.stringify(chatty));
  // Unanalysed audio is never marked.
  const partial = new m.Envelope(1200);
  assert.equal(m.findSilences(partial, {}).silences.length, 0);
});

test('silences from transcript gaps; speech spans cut at pauses; lookup', () => {
  const m = silenceMod();
  const cues = [{ start: 4, end: 10 }, { start: 9, end: 50 }, { start: 155, end: 160 }, { start: 170, end: 400 }];
  const s = m.silencesFromCues(cues, 500, { minSec: 30 });
  assert.equal(JSON.stringify(s.map((x) => [x.start, x.end])), '[[50.5,154.5],[400.5,500]]');
  assert.equal(m.silenceIndexAt(s, 100), 0);
  assert.equal(m.silenceIndexAt(s, 154.5), -1);
  assert.equal(m.silenceIndexAt(s, 450), 1);
  assert.equal(m.silenceIndexAt(s, 10), -1);
  // Speech pieces of at most 30 s, cut at the quiet moments of the envelope.
  const env = synthEnvelope(m, 120, [[22, 22.5], [47, 47.6], [70, 71]], -20, -60);
  const spans = m.speechSpans([{ start: 100, end: 120 }], 120, env, 30);
  assert.ok(spans.every((x) => x.end - x.start <= 30 + 1e-9));
  assert.equal(spans[spans.length - 1].end, 100);
  const cuts = spans.slice(0, -1).map((x) => x.end);
  assert.ok(cuts[0] >= 22 && cuts[0] < 22.5, String(cuts));
  assert.ok(cuts[1] >= 47 && cuts[1] < 47.6, String(cuts));
  assert.ok(cuts[2] >= 70 && cuts[2] < 71, String(cuts));
});

// Bug (0.13.1): in the single-view layout, switching to the camera and back quickly started
// the recording over: the second reload asked the <video> element where it was while the
// first was still loading, and the element says 0 (and paused) until it gets there.
test('a stream knows where it is going while it loads; a reload in that window keeps position and play state', () => {
  class FakeHls {
    constructor(cfg) { this.cfg = cfg; this.levels = []; this.handlers = {}; }
    static isSupported() { return true; }
    on(e, fn) { (this.handlers[e] ||= []).push(fn); }
    once(e, fn) { this.on(e, fn); }
    loadSource(u) { this.uri = u; }
    attachMedia() {}
    destroy() { this.destroyed = true; }
  }
  FakeHls.Events = { ERROR: 'e', MANIFEST_PARSED: 'm', LEVEL_SWITCHED: 'l', MEDIA_DETACHING: 'd', MEDIA_ATTACHED: 'a' };
  FakeHls.ErrorTypes = { NETWORK_ERROR: 'n', MEDIA_ERROR: 'x' };
  const m = loadSources(['00-util', '35-stream'], { Hls: FakeHls });
  const v = new FakeVideo();
  v.currentTime = 3000;
  v.paused = false;
  const st = new m.Stream(v, () => {});
  // Playing at 3000, the view switches: the new load is meant to start there and play.
  st.load('camera.m3u8', st.position(), null, st.playing());
  v.currentTime = 0;     // what the element says until the new source arrives
  v.paused = true;
  v.readyState = 0;
  assert.equal(st.position(), 3000);
  assert.equal(st.playing(), true);
  // Switched back before it arrived: still 3000 and playing (before the fix: 0 and paused).
  st.load('screen.m3u8', st.position(), null, st.playing());
  assert.equal(st.hls.cfg.startPosition, 3000);
  assert.equal(st.position(), 3000);
  assert.equal(st.playing(), true);
  // A seek or pause while loading becomes the new intent.
  st.intend(3100, false);
  assert.equal(st.position(), 3100);
  assert.equal(st.playing(), false);
  // Arrived: from now on the element is asked again.
  v.readyState = 4;
  v.currentTime = 3100.2;
  v.emit('canplay');
  assert.equal(st.starting, null);
  v.currentTime = 3105;
  assert.equal(st.position(), 3105);
  // Not there yet (data at another place) is not arrival.
  st.load('camera.m3u8', 3105, null, true);
  v.currentTime = 0;
  v.emit('canplay');
  assert.equal(st.position(), 3105);
});

// ---- T1.1: reading the lesson page (sanitised real bootstrap data, test/fixtures) ----

function adapterMod(host) {
  return loadSources(['00-util', '10-adapter'], {
    window: 'global',
    location: { hostname: host || 'echo360.net.au', pathname: '/lesson/x/classroom', origin: 'https://' + (host || 'echo360.net.au'), protocol: 'https:', hash: '' },
  });
}
const bootFixture = () => readFileSync(join(root, 'test', 'fixtures', 'boot-echo360-classroom.json'), 'utf8');

test('T1.1 parse: a real (sanitised) lesson page gives views, duration, resume point, renewal and reporting data', () => {
  const m = adapterMod();
  const raw = bootFixture();
  const cfg = JSON.parse(raw);
  // The page passes a JSON string; an object works the same.
  for (const arg of [JSON.stringify(cfg), cfg]) {
    const l = m.echo360ClassroomAdapter.parse(arg);
    assert.equal(l.sources.length, 2);
    assert.equal(JSON.stringify(l.sources.map((x) => x.index)), '[1,2]');
    assert.ok(l.sources.every((x) => x.av && x.v && x.poster));
    assert.ok(Math.abs(l.duration - 6895.072) < 1e-6);
    assert.equal(l.resumeAt, 1234);
    assert.equal(l.sessionRenewMs, 3600000);
    assert.equal(l.mediaId, cfg.video.mediaId);
    assert.equal(l.lessonId, cfg.lesson.id);
    assert.equal(l.sectionId, cfg.context.sectionId);
    assert.equal(l.backUrl, '/section/' + cfg.sectionInfo.section.id + '/home');
    assert.ok(l.transcriptUrl.includes(cfg.lesson.id) && l.transcriptUrl.includes(cfg.video.mediaId));
    assert.equal(l.captionsUrl, cfg.captions);
    assert.equal(l.thumbnails.length, 2);
    assert.equal(l.isAnonymousUser, false);
    assert.equal(l.analytics.gatewayUrl, 'https://api.echo360.net.au');
    assert.equal(l.analytics.sessionId, cfg.sessionId);
    assert.equal(l.analytics.context.lesson_id, cfg.context.lessonId);
    assert.deepEqual(JSON.parse(JSON.stringify(l.extras)), { polls: false, slides: false, audioDescription: false });
  }
});

test('T1.1 parse: live, copyright acknowledgement, no HLS stream go to the original player; one view works', () => {
  const m = adapterMod();
  const A = m.echo360ClassroomAdapter;
  const base = () => JSON.parse(bootFixture());
  const live = base();
  live.video.playableMedias[1].isLive = true;
  assert.throws(() => A.parse(live), /live/);
  const cr = base();
  cr.copyrightData = { enforceCopyrightAcknowledgement: true, copyrightAcknowledged: false };
  assert.throws(() => A.parse(cr), /copyright/);
  cr.copyrightData.copyrightAcknowledged = true;
  assert.equal(A.parse(cr).sources.length, 2);
  const noHls = base();
  for (const x of noHls.video.playableMedias) x.isHls = false;
  assert.throws(() => A.parse(noHls), /no audio\+video/);
  const videoOnly = base();
  videoOnly.video.playableMedias = videoOnly.video.playableMedias.filter((x) => x.trackType.join('+') !== 'Audio+Video');
  assert.throws(() => A.parse(videoOnly), /no audio\+video/);
  assert.throws(() => A.parse({}), /playableMedias/);
  const one = base();
  one.video.playableMedias = one.video.playableMedias.filter((x) => x.sourceIndex !== 2);
  const l = A.parse(one);
  assert.equal(l.sources.length, 1);
  assert.equal(l.sources[0].index, 1);
  // Not signed in: no reporting user, anonymous.
  const anon = base();
  delete anon.user;
  assert.equal(A.parse(anon).isAnonymousUser, true);
});

test('T1.1 withStartTime: the resume point handed back to the original player round-trips', () => {
  const m = adapterMod();
  const A = m.echo360ClassroomAdapter;
  const raw = JSON.stringify(JSON.parse(bootFixture()));
  const moved = A.withStartTime(raw, 4771.4);
  assert.equal(typeof moved, 'string');
  assert.equal(A.parse(moved).resumeAt, 4771.4);
  assert.equal(A.parse(A.withStartTime(JSON.parse(raw), -5)).resumeAt, 0);
  // Nothing else changes.
  const a = JSON.parse(raw);
  const b = JSON.parse(moved);
  delete a.startTimeMillis;
  delete b.startTimeMillis;
  assert.deepEqual(a, b);
});

test('T1.1 intercept: the page\'s player call is caught whichever way the page sets it up', () => {
  const run = (setup) => {
    const m = adapterMod();
    const g = m.window;
    const calls = [];
    const origRan = [];
    setup(g, () => m.echo360ClassroomAdapter.intercept((arg, callOriginal) => { calls.push(arg); return callOriginal; }), (a) => origRan.push(a));
    // The page's inline bootstrap: Echo["echoPlayerV2FullApp"]("<json>").
    const handOver = g.Echo.echoPlayerV2FullApp('{"x":1}');
    assert.deepEqual(calls, ['{"x":1}']);
    assert.deepEqual(origRan, []);
    handOver('{"x":2}');
    assert.deepEqual(origRan, ['{"x":2}']);
  };
  // 1. The page assigns window.Echo after the trap is set, then the function on it.
  run((g, install, orig) => { install(); g.Echo = {}; g.Echo.echoPlayerV2FullApp = orig; });
  // 2. window.Echo (with the function) existed before the trap.
  run((g, install, orig) => { g.Echo = { echoPlayerV2FullApp: orig }; install(); });
  // 3. The function is defined with defineProperty on an Echo object assigned later.
  run((g, install, orig) => { install(); const e = {}; g.Echo = e; Object.defineProperty(e, 'echoPlayerV2FullApp', { value: orig, writable: true, configurable: true }); });
});

// ---- T1.3: watch reporting (it may count for attendance: mistakes are costly) ----

function reporterRig(statusFor) {
  const sent = [];
  const store = new Map();
  const listeners = {};
  const m = loadSources(['00-util', '20-reporter'], {
    window: { addEventListener: (t, fn) => { listeners[t] = fn; }, removeEventListener: (t) => { delete listeners[t]; } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    document: { referrer: 'https://echo360.example/section/s/home' },
    location: { href: 'https://echo360.example/lesson/l/classroom', origin: 'https://echo360.example', hash: '' },
  });
  m.setFetch((url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    sent.push({ url, method: (init && init.method) || 'GET', body, auth: init && init.headers && init.headers.Authorization });
    const status = statusFor ? statusFor(url, sent) : 204;
    return Promise.resolve({ status, ok: status < 400, headers: { get: (h) => (h === 'token' && url.includes('refresh') ? 'fresh-token' : null) } });
  });
  const v = new FakeVideo();
  v.volume = 0.8;
  v.played = { length: 1, start: () => 10, end: () => 70.5 };
  const d = new m.Disposer();
  const info = { appUrl: 'https://echo360.example', gatewayUrl: 'https://api.echo360.example', sessionId: 'sess', mediaId: 'media', context: { lesson_id: 'l' }, link: {}, user: { id: 'u', role: 'Student' } };
  const played = new m.PlayedRanges();
  played.add(0, 5);
  const r = new m.Reporter(info, v, played, d);
  return { m, r, v, d, sent, store, listeners, posts: () => sent.filter((x) => x.method === 'POST' && !x.url.includes('refresh')) };
}

test('T1.3 reporting: begin once, beacons with what was really played, end once on leaving', async () => {
  const g = reporterRig();
  const { r, v } = g;
  v.currentTime = 70.5;
  v.playbackRate = 1.5;
  r.onPlay();
  r.onPlay();                 // a second play is no second session
  r.onPause();
  r.end();
  r.end();                    // pagehide twice, or end then detach: one END
  g.d.dispose();
  await new Promise((res) => setTimeout(res, 0));
  const kinds = g.posts().map((x) => (x.url.endsWith('/session') ? x.body.lifecycle : 'beacon'));
  assert.deepEqual(kinds, ['SESSION_BEGIN', 'beacon', 'SESSION_END']);
  const b = g.posts()[0].body;
  assert.equal(b.session_id, 'sess');
  assert.equal(b.media_id, 'media');
  assert.equal(b.media_state.position, 70500);
  assert.equal(b.media_state.playback_rate, 150);
  assert.equal(b.media_state.volume, 80);
  // Earlier played ranges (another view) merged with the element's own.
  assert.equal(JSON.stringify(b.media_state.played), '[{"start":0,"end":5000},{"start":10000,"end":70500}]');
  assert.equal(b.browser.url, 'https://echo360.example/lesson/l/classroom');
  // Nothing at all before playback started: no session for a page only opened.
  const g2 = reporterRig();
  g2.r.end();
  g2.d.dispose();
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(g2.posts().length, 0);
});

test('T1.3 reporting: a refused report refreshes the token and is sent once more, not again and again', async () => {
  let refusals = 0;
  const g = reporterRig((url) => (url.endsWith('/beacon') && refusals++ < 5 ? 401 : 204));
  g.store.set('authn-jwt', 'old-token');
  g.r.onPlay();
  g.r.heartbeat();
  await new Promise((res) => setTimeout(res, 10));
  const beacons = g.sent.filter((x) => x.url.endsWith('/beacon'));
  assert.equal(beacons.length, 2, 'the original and one retry');
  assert.equal(beacons[0].auth, 'Bearer old-token');
  assert.equal(beacons[1].auth, 'Bearer fresh-token');
  assert.equal(g.sent.filter((x) => x.url.includes('refresh')).length, 1);
  assert.equal(g.store.get('authn-jwt'), 'fresh-token');
  g.d.dispose();
});

test('T1.3 reporting: after handing over to the original player, nothing more is sent', async () => {
  const g = reporterRig();
  g.r.onPlay();
  g.d.dispose();              // handing over: this player stops, the original reports itself
  const n = g.posts().length;
  g.r.heartbeat();
  g.r.onPlay();
  g.r.end();
  if (g.listeners.pagehide) g.listeners.pagehide();
  for (const t of g.m.timers || []) if (t.fn) t.fn();
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(g.posts().length, n);
  assert.equal(g.listeners.pagehide, undefined, 'the unload listener is removed');
});

// ---- T1.4: nothing is written to Echo360 without the user doing it ----

function apiRig(dryRun) {
  const sent = [];
  const local = new Map(dryRun ? [['lite-player-for-echo360:dryRun', JSON.stringify(dryRun)]] : []);
  const m = loadSources(['00-util', '10-adapter', '11-echo360-api'], {
    localStorage: { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, v) },
  });
  m.setFetch((url, init) => {
    sent.push({ url, method: init.method });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'ok', data: [{ id: 'n1', createdAt: 'x' }] }) });
  });
  const lesson = { lessonId: 'L1', mediaId: 'M1', sectionId: 'S1', thumbnails: [] };
  return { m, api: new m.Echo360Api(lesson), sent, dry: () => m.window.__litePlayerForEcho360DryRun || [] };
}

// Every write the API offers, with plausible arguments, and whether it is public.
const WRITES = [
  ['addNote', (ev) => [ev, { text: 'x', time: 5 }], false],
  ['updateNote', (ev) => [ev, { id: 'n1' }, 'y'], false],
  ['deleteNote', (ev) => [ev, { id: 'n1' }], false],
  ['addFlag', (ev) => [ev, 40], true],
  ['removeFlag', (ev) => [ev, { id: 'flag-1', time: 30 }], true],
  ['postComment', (ev) => [ev, { body: 'q', anonymous: false, time: 10 }], true],
  ['reply', (ev) => [ev, 'Q1', { body: 'r', anonymous: true }], true],
  ['like', (ev) => [ev, { id: 'C1', questionId: null }, true], true],
  ['deleteComment', (ev) => [ev, { id: 'C1', questionId: null }], true],
  ['save', (ev) => [ev, { id: 'C1' }, true], true],
];

test('T1.4 writes: refused without a trusted user event, for every write', async () => {
  const g = apiRig(false);
  const own = Object.getOwnPropertyNames(g.m.Echo360Api.prototype).filter((n) => /^(add|update|delete|remove|post|reply|like|save)/.test(n));
  assert.deepEqual(own.sort(), WRITES.map((w) => w[0]).sort(), 'every write method is covered here');
  for (const [name, args] of WRITES) {
    for (const ev of [undefined, null, {}, { isTrusted: false }, { isTrusted: 'true' }]) {
      await assert.rejects(async () => g.api[name](...args(ev)), /write refused/, name);
    }
  }
  assert.equal(g.sent.length, 0, 'nothing reached the network');
});

test('T1.4 writes: with a user event they are sent; dry run "public" holds back what others would see, "all" holds back everything', async () => {
  const ev = { isTrusted: true };
  const live = apiRig(false);
  for (const [name, args] of WRITES) await live.api[name](...args(ev)).catch(() => {});
  assert.equal(live.sent.length, WRITES.length);
  const pub = apiRig('public');
  for (const [name, args] of WRITES) await pub.api[name](...args(ev)).catch(() => {});
  assert.equal(pub.sent.length, WRITES.filter((w) => !w[2]).length, 'only private writes sent');
  assert.equal(pub.dry().length, WRITES.filter((w) => w[2]).length, 'public ones recorded instead');
  assert.ok(pub.dry().every((r) => r.visibility === 'public'));
  const all = apiRig('all');
  for (const [name, args] of WRITES) await all.api[name](...args(ev)).catch(() => {});
  assert.equal(all.sent.length, 0);
  assert.equal(all.dry().length, WRITES.length);
});

// ---- slide chapters ----

function slidesMod() {
  return loadSources(['00-util', '61-media-io', '62-silence', '64-slides']);
}

// ISO BMFF box builder for tests.
function box(type, ...parts) {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}
const u32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4)); return b; };

test('fragment parsing finds the keyframe bytes and sample times', () => {
  const m = slidesMod();
  // tfhd: default-base-is-moof + default sample flags (non-sync); trun: data offset,
  // first-sample flags (sync), per-sample duration, size and composition offset.
  const tfhd = box('tfhd', u32(0x020020, 1, 0x10000));
  const tfdt = box('tfdt', Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from([0, 0, 0, 0, 0, 9, 0x60, 0])]));
  const trunBody = (off) => Buffer.concat([u32(0x000b05, 3, off, 0x2000000), u32(512, 1000, 1024), u32(512, 20, 0), u32(512, 30, 512)]);
  const size = (b) => box('moof', box('mfhd', u32(0, 1)), box('traf', tfhd, tfdt, box('trun', b))).length;
  const moofLen = size(trunBody(0));
  const moof = box('moof', box('mfhd', u32(0, 1)), box('traf', tfhd, tfdt, box('trun', trunBody(moofLen + 8))));
  const file = Buffer.concat([moof, box('mdat', Buffer.alloc(1050))]);
  const ab = file.buffer.slice(file.byteOffset, file.byteOffset + file.length);
  const f = m.parseFragment(ab, 5000);
  assert.equal(f.samples.length, 3);
  assert.equal(f.samples[0].offset, moofLen + 8);
  assert.equal(f.samples[0].size, 1000);
  assert.equal(f.samples[0].key, true);
  assert.equal(f.samples[1].key, false);
  assert.equal(f.samples[0].time, 614400 + 1024);
  assert.equal(f.samples[2].time, 614400 + 1024 + 512);
  assert.equal(f.samples[2].offset, moofLen + 8 + 1020);
});

test('keyframe reading: a header larger than the first request, a tiny static segment, no guessed sizes', async () => {
  const decoded = [];
  const m = loadSources(['00-util', '61-media-io', '62-silence', '64-slides'], {
    EncodedVideoChunk: class { constructor(o) { Object.assign(this, o); } },
    VideoDecoder: class {
      constructor(o) { this.o = o; this.state = 'configured'; }
      configure() {}
      decode(c) { decoded.push(c.data.length); this.o.output({ timestamp: c.timestamp, close() {} }); }
      flush() { return Promise.resolve(); }
      close() { this.state = 'closed'; }
    },
  });
  // A segment whose header (moof, with many samples) is larger than 4 KB, and whose
  // keyframe is most of the segment (a still picture).
  const n = 700;
  const tfhd = box('tfhd', u32(0x020020, 1, 0x10000));
  const rows = (off) => Buffer.concat([u32(0x000305, n, off, 0x2000000), ...Array.from({ length: n }, (v, i) => u32(512, i ? 3 : 6000))]);
  const moofLen = box('moof', box('mfhd', u32(0, 1)), box('traf', tfhd, box('trun', rows(0)))).length;
  const moof = box('moof', box('mfhd', u32(0, 1)), box('traf', tfhd, box('trun', rows(moofLen + 8))));
  const file = Buffer.concat([moof, box('mdat', Buffer.alloc(6000 + 3 * (n - 1), 7))]);
  assert.ok(moofLen > 4096);
  const asked = [];
  m.setFetch(async (url, init) => {
    const [a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).slice(1).map(Number);
    asked.push([a, b]);
    const part = file.subarray(a, Math.min(b + 1, file.length));
    return { ok: true, status: 206, arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.length) };
  });
  const r = Object.create(m.HlsVideoReader.prototype);
  Object.assign(r, { segments: [{ url: 'https://x.test/s.mp4', offset: 0, length: file.length, start: 0, dur: 10 }], info: { codec: 'avc1.42c01e', description: new Uint8Array(1), timescale: 1000 }, bytes: 0, lastNeed: 0 });
  let got = 0;
  await r.keyframe(0, null, () => { got++; });
  assert.equal(got, 1);
  assert.deepEqual(decoded, [6000]);
  assert.equal(r.lastNeed, moofLen + 8 + 6000);
  // Never more than the header and the keyframe, and nothing twice.
  assert.ok(r.bytes <= r.lastNeed + 8 + 4096, 'read ' + r.bytes);
  for (let k = 1; k < asked.length; k++) assert.equal(asked[k][0], asked[k - 1][1] + 1);
  // The next keyframe of the stream: one request, sized from this one.
  asked.length = 0;
  await r.keyframe(0, null, () => {});
  assert.equal(asked.length, 1);
});

test('video variants sorted by height', () => {
  const m = slidesMod();
  const v = m.videoVariants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2118548,RESOLUTION=1280x720\ns1q1.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=613230,RESOLUTION=640x360\ns1q0.m3u8\n', 'https://x.test/a/s1_v.m3u8?k=1');
  assert.equal(v.length, 2);
  assert.equal(v[0].height, 360);
  assert.equal(v[0].uri, 'https://x.test/a/s1q0.m3u8');
});

// Synthetic 160 x 90 brightness pictures: a flat background with lines of "text" (rows of
// 2-pixel letters with gaps) at given rows, a little encoding noise, and optional ink.
function pic(bg, lines, opts) {
  const o = opts || {};
  const a = new Uint8Array(160 * 90).fill(bg);
  const fg = bg > 128 ? 20 : 230;
  for (const y of lines) for (let x = 8; x < 150; x++) if ((x >> 1) % 4 !== 3) { a[y * 160 + x] = fg; a[(y + 1) * 160 + x] = fg; }
  for (const [x, y] of o.ink || []) a[y * 160 + x] = bg > 128 ? 60 : 200;
  let seed = o.seed || 1;
  for (let i = 0; i < a.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; a[i] = Math.max(0, Math.min(255, a[i] + (seed % 7) - 3)); }
  return a;
}
const inkStroke = (x0, y0, n) => Array.from({ length: n }, (v, k) => [x0 + k, y0 + (k >> 2)]);

test('frame comparison: noise is no change, ink is small, a new slide is large; the split is learnt', () => {
  const m = slidesMod();
  const A = pic(230, [10, 25, 40, 55], { seed: 1 });
  const A2 = pic(230, [10, 25, 40, 55], { seed: 2 });
  const inked = pic(230, [10, 25, 40, 55], { seed: 3, ink: inkStroke(30, 15, 40) });
  const B = pic(230, [15, 30, 33, 50, 65, 75], { seed: 4 });
  const editor = pic(25, [5, 15, 20, 30, 45, 60], { seed: 5 });
  assert.equal(m.thumbChange(A, A2), 0);
  const ink = m.thumbChange(A, inked);
  assert.ok(ink >= 12 && ink < 100, 'ink ' + ink);
  assert.ok(m.thumbChange(A, B) > 1000);
  assert.ok(m.thumbChange(A, editor) > 5000);
  assert.equal(m.thumbChange(A, editor, 50), 50, 'stops counting at the limit');
  // A lecture's changes: many without a visible change, some ink, some new slides.
  const thr = m.learnThreshold([0, 0, 1, 3, 0, 40, 35, 60, 2, 0, 1500, 3000, 0, 45, 2200, 9000, 0, 0]);
  assert.ok(thr > 60 && thr < 1500, 'threshold ' + thr);
  // Nothing to split: every visible change is a new picture.
  assert.equal(m.learnThreshold([0, 0, 2]), 12);
  assert.equal(m.learnThreshold([0, 900, 0]), 12);
});

test('scenes: returns continue a chapter, short looks elsewhere join, single samples merge, lookup', () => {
  const m = slidesMod();
  let seed = 10;
  const lines = { A: [10, 25, 40, 55], B: [15, 30, 33, 50, 65, 75], C: [5, 20, 60, 70, 80], E: [5, 15, 20, 30, 45, 60] };
  const mk = (ch) => {
    seed++;
    if (ch === 'a') return pic(230, lines.A, { seed, ink: inkStroke(30, 15, 40) });
    if (ch === 'X') return pic(128, [45], { seed });  // a single frame caught mid-transition
    return pic(ch === 'E' ? 25 : 230, lines[ch], { seed });
  };
  // A, ink on A, looks at an editor (E) and back, then B, a transition frame, C.
  const seq = 'AAAaEEaaEEaaaBBBBBBXCCCC'.split('');
  const samples = seq.map((ch, k) => ({ t: k * 10, luma: mk(ch) }));
  const scenes = m.buildScenes(samples, seq.length * 10);
  assert.equal(JSON.stringify(scenes.map((s) => s.start)), '[0,130,190]');
  assert.equal(scenes[0].end, 130);
  assert.equal(seq[scenes[0].rep].toUpperCase(), 'A');
  assert.equal(scenes[2].end, seq.length * 10);
  assert.equal(seq[scenes[1].rep], 'B');
  assert.equal(seq[scenes[2].rep], 'C');
  assert.equal(scenes[2].first, 19);
  assert.equal(m.chapterIndexAt(scenes, 0), 0);
  assert.equal(m.chapterIndexAt(scenes, 135), 1);
  assert.equal(m.chapterIndexAt(scenes, 1e6), 2);
  // A long stay elsewhere is a chapter of its own, even when it comes back.
  const seq2 = 'AAABBBBBBBBAAA'.split('');
  const s2 = m.buildScenes(seq2.map((ch, k) => ({ t: k * 10, luma: mk(ch) })), seq2.length * 10);
  assert.equal(JSON.stringify(s2.map((s) => s.start)), '[0,30,110]');
});

test('H1: sampling and chunks follow segment durations, not a fixed 10 s', () => {
  const m = slidesMod();
  const segs = (dur, total) => Array.from({ length: Math.ceil(total / dur) }, (v, i) => ({ start: i * dur, dur }));
  const r = Object.create(m.HlsVideoReader.prototype);
  r.segments = segs(10, 60);
  assert.equal(JSON.stringify(r.sampleSegments(10)), '[0,1,2,3,4,5]');
  r.segments = segs(2, 30);
  assert.equal(JSON.stringify(r.sampleSegments(10)), '[0,5,10]');
  r.segments = segs(12, 48);
  assert.equal(JSON.stringify(r.sampleSegments(10)), '[0,1,2,3]');
  assert.equal(JSON.stringify(m.groupSegments(segs(10, 130), 60)), '[{"a":0,"b":6},{"a":6,"b":12},{"a":12,"b":13}]');
  assert.equal(m.groupSegments(segs(2, 120), 60)[0].b, 30);
  assert.equal(m.groupSegments(segs(90, 180), 60).length, 2);
  assert.equal(m.sampleIndexAt([0, 10, 20], 15), 1);
  assert.equal(m.sampleIndexAt([0, 10, 20], -1), -1);
});

// Bug (0.13.1): on a lecture whose slides are dense and handwritten on gradients, while the
// camera films a still room, neither view was "clearly flatter", so slide chapters were
// switched off. The screen is now told by how it changes over time (still, then a step;
// a camera always changes a little), from measured recordings (test/fixtures).
test('which view is the screen: still between changes beats a camera, on every measured recording, in either order', () => {
  const m = slidesMod();
  const fx = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'screen-views.json'), 'utf8'));
  for (const r of fx.recordings) {
    // Six pairs, as findScreen takes them: every other measured pair.
    const screen = { source: { index: 1 }, vals: r.screen.filter((x, i) => i % 2 === 0) };
    const camera = { source: { index: 2 }, vals: r.camera.filter((x, i) => i % 2 === 0) };
    for (const order of [[screen, camera], [camera, screen]]) {
      const res = m.pickScreen(order, true, 2);
      assert.equal(res.best.source.index, 1, r.name);
      assert.equal(res.sure, true, r.name);
    }
  }
  // Not every view measured, or no clear difference: still an answer, marked unsure.
  const a = { source: { index: 1 }, vals: [5, 6, 7] };
  const b = { source: { index: 2 }, vals: [5, 7, 8] };  // median higher, but beats a in only 2/3 of pairs
  assert.equal(m.pickScreen([a], true, 2).sure, false);
  const tie = m.pickScreen([b, a], true, 2);
  assert.equal(tie.best.source.index, 1);
  assert.equal(tie.sure, false);
  // The measure itself: re-encoding noise is not a change, sensor noise is.
  const still = new Uint8Array(100).fill(100);
  const again = still.map((x, i) => x + (i % 3) - 1);
  const noisy = still.map((x, i) => x + ((i * 7) % 11) - 5);
  assert.equal(m.slightChange(still, again), 0);
  assert.ok(m.slightChange(still, noisy) > 0.4);
  // A real edge moving (more than PIXEL_DIFF) is not "slight".
  assert.equal(m.slightChange(still, still.map(() => 250)), 0);
});

// ---- slide following ----

function deckMod() {
  return loadSources(['00-util', '61-media-io', '64-slides', '67-slide-text', '66-slide-ocr', '68-slide-deck']);
}

test('following: not-a-slide and unread parts keep the page, a quick look back does not turn it', () => {
  const m = deckMod();
  const times = [0, 10, 20, 30, 40, 50, 60, 70, 80];
  // -1 not a slide, -2 not read; page 0 for 10 s between stretches of page 3 is a look back.
  const pages = [-1, 2, 2, -1, 3, 0, 3, -2, 4];
  assert.equal(JSON.stringify(Array.from(m.followSamples(times, pages, 15, 90))), '[2,2,2,2,3,3,3,3,4]');
  // Moving on through pages quickly does turn them.
  assert.equal(JSON.stringify(Array.from(m.followSamples(times.slice(0, 4), [1, 2, 3, 4], 15, 40))), '[1,2,3,4]');
  // Nothing known: nothing shown.
  assert.equal(JSON.stringify(Array.from(m.followSamples([0, 10], [-1, -2], 15, 20))), '[-1,-1]');
});

// A small made-up lecture: six pages with their own words (page 3 has no text), a viewer
// whose words are on every picture, OCR noise, a code editor and a camera picture.
function fakeLecture() {
  const topics = ['exceptions checked unchecked throw catch finally', 'generics type parameter bounded wildcard erasure',
    'collections list arraylist linkedlist iterator', '', 'hashmap hashing buckets collisions resize', 'comparator comparable sorting ordering stable'];
  const pageTexts = topics.map((w, i) => (w ? 'COMP2511 Week ' + (i + 1) + ' ' + w + ' ' + w.split(' ').reverse().join(' ') : ''));
  const viewer = 'Preview File Edit View Go Tools Window Help lecture.pdf zoom ';
  const shown = (p, noise) => viewer + pageTexts[p] + ' ' + noise;
  const texts = [
    shown(0, 'qx zzv'), shown(0, 'pointer'), shown(1, 'kkq'), shown(2, 'vvx'),
    viewer + 'Week', // the text-less page 3: only the viewer
    shown(4, 'abq'), 'Code File Edit Selection View Terminal public static void main String args System out println',
    shown(4, 'xx'), '', shown(5, 'ok'),
  ];
  const at = [0, 0, 1, 2, 2, 3, 4, 5, 5, 6, 6, 6, 7, 8, 8, 9];
  return { pageTexts, fileOf: pageTexts.map(() => 0), texts, at };
}

test('H3: words in any script, only in the scripts being read; the reading language from the slides', () => {
  const m = deckMod();
  // Latin: accents and ligatures unified, a script change splits a formula, short pieces dropped.
  assert.deepEqual(Array.from(m.slideWords('The ﬁlter élève naïve x86 jωL AI of')), ['filter', 'eleve', 'naive', 'x86']);
  // Maths italic letters of a PDF are plain letters.
  assert.deepEqual(Array.from(m.slideWords('𝑉𝑜𝑢𝑡')), ['vout']);
  // Other scripts only when read: Greek words of a formula are not, when reading English.
  assert.deepEqual(Array.from(m.slideWords('ωωω0 resistor')), ['resistor']);
  assert.deepEqual(Array.from(m.slideWords('закон Ohm', ['Cyrillic', 'Latin'])), ['закон', 'ohm']);
  // Chinese: pairs of neighbouring characters, plus the English terms.
  assert.deepEqual(Array.from(m.slideWords('电路分析 Circuit', ['Han', 'Latin'])), ['电路', '路分', '分析', 'circuit']);
  assert.deepEqual(Array.from(m.slideWords('电路分析')), []);
  // The language: by the script of most words.
  assert.equal(m.ocrLanguage(['Kirchhoff voltage law and Ohm law', 'ω = 2πf, ΔV']), 'eng');
  assert.equal(m.ocrLanguage(['电路分析 这是电压的问题 Kirchhoff voltage law']), 'chi_sim');
  assert.equal(m.ocrLanguage(['電路分析 這是電壓的問題']), 'chi_tra');
  assert.equal(m.ocrLanguage(['これは回路の問題です']), 'jpn');
  assert.equal(m.ocrLanguage(['전기 회로 분석 법칙']), 'kor');
  assert.equal(m.ocrLanguage([]), 'eng');
  // A Chinese lecture is matched on Chinese words: the right page wins.
  const pages = ['电路分析 基尔霍夫定律', '欧姆定律 电阻和电流', '电容器 充电和放电'];
  const r = m.followLecture({ pageTexts: pages, fileOf: [0, 0, 0], texts: [pages[0] + ' File Edit', pages[1] + ' File', pages[2]], at: [0, 0, 1, 1, 2, 2], scripts: m.TESS_LANGS.chi_sim.scripts });
  assert.equal(JSON.stringify(Array.from(r.pages)), '[0,0,1,1,2,2]');
});

test('T1.6: the Worker source runs on its own and decides as the page does', () => {
  const m = deckMod();
  const input = Object.assign(fakeLecture(), { scripts: ['Latin'] });
  const here = m.followLecture(input);
  // A bare context: only what a Worker has; any helper the source forgot is a ReferenceError.
  const posted = [];
  const ctx = { self: { postMessage: (x) => posted.push(x) }, Date, Math, Int32Array, Float32Array, Float64Array, Uint8Array, Map, Set, Array, Object, String, Number, RegExp, JSON, Infinity, NaN, isFinite };
  vm.createContext(ctx);
  vm.runInContext(m.slideTextWorkerSource(), ctx);
  ctx.self.onmessage({ data: { id: 1, input } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].ok, true, posted[0].error);
  assert.equal(JSON.stringify(Array.from(posted[0].result.pages)), JSON.stringify(Array.from(here.pages)));
});

// T2: two hand-labelled lectures replayed through followLecture (texts as hashed word bags,
// see dev/make-text-fixture.mjs). Scored as dev/text-eval.mjs does, on slide time: the page
// shown (after followSamples) is the labelled one or next to it, and the page decided is
// exactly the labelled one. Floors a little under today's results (ELEC 98.6% / 92.4%,
// COMP 99.3% / 91.4%), so that a change that makes following worse fails here.
function replayLecture(name) {
  const m = deckMod();
  const fx = JSON.parse(readFileSync(join(root, 'test', 'fixtures', name), 'utf8'));
  const labels = JSON.parse(readFileSync(join(root, 'test', 'fixtures', fx.labels), 'utf8'));
  const res = m.followLecture({ pageTexts: fx.pages, fileOf: fx.fileOf, texts: fx.texts, at: fx.at });
  const shown = m.followSamples(fx.times, res.pages, 15, fx.duration);
  const truthAt = (t) => { let g = null; for (const c of labels.chapters) if (c.start <= t + 0.5) g = c; else break; return g; };
  const idx = (file, num) => fx.fileOf.findIndex((f, i) => f === file && fx.pageNum[i] === num);
  const st = { slide: 0, w1: 0, exact: 0, xfile: 0 };
  fx.times.forEach((t, i) => {
    const g = truthAt(t);
    if (!g || !(g.view === 'normal' || g.view === 'zoom')) return;
    const step = (i + 1 < fx.times.length ? fx.times[i + 1] : fx.duration) - t;
    const want = idx(g.file, g.page);
    st.slide += step;
    if (res.pages[i] === want) st.exact += step;
    const k = shown[i];
    if (k >= 0 && fx.fileOf[k] !== g.file) st.xfile += step;
    if (k >= 0 && fx.fileOf[k] === g.file && Math.abs(k - want) <= 1) st.w1 += step;
  });
  return { within1: st.w1 / st.slide, exact: st.exact / st.slide, crossFile: st.xfile / st.slide };
}

test('T2: following on labelled lectures stays accurate (ELEC2134, 3 h, two distractor files)', () => {
  const r = replayLecture('text-2026-09-15-elec2134.json');
  assert.ok(r.within1 >= 0.97, 'within one page ' + r.within1);
  assert.ok(r.exact >= 0.9, 'exact page ' + r.exact);
  assert.equal(r.crossFile, 0);
});

test('T2: following on labelled lectures stays accurate (COMP2511, 2 h, two files, much code and video)', () => {
  const r = replayLecture('text-2026-09-28.json');
  assert.ok(r.within1 >= 0.97, 'within one page ' + r.within1);
  assert.ok(r.exact >= 0.9, 'exact page ' + r.exact);
  assert.equal(r.crossFile, 0);
});

test('text following: pages from the words on screen, order fills in a page without text', () => {
  const m = deckMod();
  const input = fakeLecture();
  const r = m.followLecture(input);
  // samples:            0  0  1  2  2  3  4  5  5  6  6  6  7  8  8  9   (picture shown)
  assert.equal(JSON.stringify(Array.from(r.pages)), '[0,0,0,1,1,2,3,4,4,-1,-1,-1,4,-1,-1,5]');
  // Unread samples stay unread.
  const part = Object.assign({}, input, { at: input.at.map((x, i) => (i < 3 ? x : -1)) });
  assert.equal(JSON.stringify(Array.from(m.followLecture(part).pages).slice(0, 5)), '[0,0,0,-2,-2]');
});

test('text following: the user\'s corrections win', () => {
  const m = deckMod();
  const input = fakeLecture();
  const force = input.at.map(() => -1);
  force[3] = 2;              // "this part is page 3" (index 2)
  force[4] = 2;
  force[15] = m.FORCE_OFF;  // "this part is not a slide"
  const r = m.followLecture(Object.assign({}, input, { force }));
  assert.equal(r.pages[3], 2);
  assert.equal(r.pages[4], 2);
  assert.equal(r.pages[15], -1);
});

test('session keeper: renews once for concurrent callers, gives up on a login redirect, retries twice', async () => {
  const m = loadSources(['00-util', '36-session']);
  const make = (responses) => {
    let n = 0;
    const d = new m.Disposer();
    m.setFetch(() => { n++; const r = responses[Math.min(n - 1, responses.length - 1)]; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); });
    const states = [];
    const k = new m.SessionKeeper({ url: '/lesson/x', renewMs: 3600000, disposer: d, retryMs: [1, 1], onState: (s) => states.push(s) });
    return { k, d, states, count: () => n };
  };
  const ok = { ok: true, status: 200, type: 'basic', body: null };
  const login = { ok: false, status: 0, type: 'opaqueredirect', body: null };
  const err = { ok: false, status: 502, type: 'basic', body: null };
  let s = make([ok]);
  await Promise.all([s.k.renew(true), s.k.renew(true)]);
  assert.equal(s.count(), 1);
  assert.equal(s.states.join(','), 'renewing,ok');
  assert.equal(s.k.renewals, 1);
  s.d.dispose();
  s = make([login]);
  await assert.rejects(s.k.renew(true));
  assert.equal(s.k.failed.login, true);
  await assert.rejects(s.k.renew(true));   // no new attempt once given up
  assert.equal(s.count(), 1);
  s.d.dispose();
  s = make([err, new Error('offline'), ok]);
  await s.k.renew(true);
  assert.equal(s.count(), 3);
  assert.equal(s.k.failed, null);
  s.d.dispose();
  s = make([err, err, err, ok]);
  await assert.rejects(s.k.renew(true));
  assert.equal(s.count(), 3);               // the first try and two retries
  assert.equal(s.k.failed.login, false);
  s.d.dispose();
});

test('tags: defaults once per course, create / rename / toggle / delete keeps the item map clean', async () => {
  const m = loadSources(['00-util', '01-i18n', '61-media-io', '56-tags']);
  const st = new m.TagStore({ sectionId: 'sec', mediaId: 'med' });
  await st.load();
  assert.equal(st.tags.map((x) => x.id).join(','), 'exam,assignment,confused');
  const t1 = st.create('  Week 3  ');
  assert.equal(t1.name, 'Week 3');
  assert.equal(st.create('week 3'), t1);          // same name, any case: the same tag
  st.toggle('n1', 'exam');
  st.toggle('n1', t1.id);
  assert.equal(st.of('n1').map((x) => x.name).join(','), 'Exam,Week 3');
  st.rename(t1.id, 'Week 3 formulas');
  st.remove('exam');
  assert.equal(st.of('n1').map((x) => x.name).join(','), 'Week 3 formulas');
  st.toggle('n1', t1.id);
  assert.equal(Object.keys(st.map).length, 0);     // an item without tags is dropped
});

test('watched share: overlapping-free ranges, clipped to the duration', () => {
  const m = loadSources(['00-util', '20-reporter', '61-media-io', '52-watched']);
  assert.equal(m.watchedShare({ d: 100, r: [[0, 10], [50, 70]] }), 0.3);
  assert.equal(m.watchedShare({ d: 100, r: [[90, 130]] }), 0.1);
  assert.equal(m.watchedShare(null), 0);
});

test('export: zip that standard tools open, Markdown with times, links and tags', async () => {
  const m = loadSources(['00-util', '01-i18n', '10-adapter', '11-echo360-api', '85-export']);
  assert.equal(m.crc32(new TextEncoder().encode('hello')), 0x3610a686);
  const zip = m.makeZip([{ name: 'a/ü.md', data: new TextEncoder().encode('# x\n') }, { name: 'a/p1.png', data: new Uint8Array([1, 2, 3]) }]);
  const bytes = Buffer.from(await zip.arrayBuffer());
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('python3', ['-c', 'import sys,zipfile,io; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(z.testzip(), [(i.filename, i.file_size) for i in z.infolist()], z.read("a/\u00fc.md"))'], { input: bytes }).toString();
  assert.match(out, /^None \[\('a\/ü\.md', 4\), \('a\/p1\.png', 3\)\] b'# x\\n'/);
  assert.equal(m.mdTag('Week 1 formula'), '#Week-1-formula');
  const md = m.lectureMarkdown({
    title: 'Lecture', date: '2026-09-15', url: 'https://e/lesson/L/classroom',
    items: [{ id: 'n1', type: 'note', time: 3725.4, text: 'line one\nline two' }, { id: 'b1', type: 'bookmark', time: 60 }],
    tagsOf: (id) => (id === 'n1' ? [{ name: 'Exam' }] : []), picture: (x) => (x.id === 'n1' ? 'Lecture/Slides p3.png' : null),
  });
  assert.match(md, /^# Lecture\n\nRecorded 2026-09-15 · \[Open in Echo360\]\(https:\/\/e\/lesson\/L\/classroom\)/);
  assert.match(md, /- \*\*\[1:02:05\]\(https:\/\/e\/lesson\/L\/classroom#t=3725\)\*\* line one {2}\n {2}line two #Exam\n {2}\n {2}!\[\]\(Lecture\/Slides%20p3\.png\)/);
  assert.match(md, /- \*\*\[0:01:00\]\(https:\/\/e\/lesson\/L\/classroom#t=60\)\*\* 🔖 Bookmark\n/);
});

// ---- M8.9 A: regression tests for the urgent fixes ----

test('E1: a player that fails half-way through construction releases what it made', () => {
  const m = loadSources(['00-util', '01-i18n', '39-prefs', '40-player']);
  const released = [];
  m.LitePlayer.prototype.init = function () {
    this.d.add(() => released.push('host'));
    this.d.add(() => released.push('timer'));
    throw new Error('boom');
  };
  assert.throws(() => new m.LitePlayer({}, {}), /boom/);
  assert.equal(released.sort().join(','), 'host,timer');
});

test('E2: settings are validated field by field; damaged values fall back to defaults', () => {
  const m = loadSources(['00-util', '01-i18n', '39-prefs', '40-player', '53-captions', '54-sidebar', '62-silence']);
  const d = m.prefDefaults();
  assert.equal(JSON.stringify(m.sanitizePrefs(null)), JSON.stringify(d));
  assert.equal(JSON.stringify(m.sanitizePrefs('garbage')), JSON.stringify(d));
  const p = m.sanitizePrefs({ rate: 'x', volume: NaN, ratio: 5, layout: 'weird', capSize: 'xl', muted: 'yes', audio: { level: true, voice: 1 },
    silence: { min: 60, sens: 'loud' }, quality: { screen: 720, camera: -3 }, copySpan: 120, evil: 1, primary: 1.5 });
  assert.equal(p.rate, 1);
  assert.equal(p.volume, 1);
  assert.equal(p.ratio, 0.5);
  assert.equal(p.layout, 'side');
  assert.equal(p.capSize, 'xl');
  assert.equal(p.muted, false);
  assert.equal(JSON.stringify(p.audio), '{"level":true,"voice":false,"mono":false}');
  assert.equal(JSON.stringify(p.silence), '{"auto":false,"min":60,"sens":"normal"}');
  assert.equal(JSON.stringify(p.quality), '{"screen":720,"camera":"auto"}');
  assert.equal(p.copySpan, 120);
  assert.equal(p.primary, null);
  assert.equal('evil' in p, false);
  assert.equal(m.sanitizePos({ t: 12.5, at: 1 }).t, 12.5);
  assert.equal(m.sanitizePos({ t: 'x' }), null);
});

test('E2: a backup restore takes only known keys, validated, and skips damaged entries', async () => {
  const local = new Map();
  const db = new Map();
  const m = loadSources(['00-util', '01-i18n', '39-prefs', '40-player', '53-captions', '54-sidebar', '61-media-io', '62-silence', '11-echo360-api', '10-adapter', '85-export'], {
    localStorage: { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, v), key: () => null, length: 0 },
  });
  // In-memory IndexedDB stand-in.
  const ctxIdb = { get: async (k) => db.get(k), put: async (k, v) => { db.set(k, v); }, putMany: async (es) => { for (const [k, v] of es) db.set(k, v); }, del: async (k) => { db.delete(k); }, keys: async () => [...db.keys()] };
  const n = await m.restoreBackup({
    app: 'lite-player-for-echo360', v: 1,
    local: { prefs: JSON.stringify({ rate: 'x', layout: 'pip' }), 'pos:abc': JSON.stringify({ t: 30 }), debug: 'true', 'evil:key': '1', 'pos:bad': '{"t":"no"}' },
    db: { 'tags:s': { tags: [{ id: 'a', name: 'A', color: '#fff' }] }, 'tags:bad': { tags: 'nope' }, 'watched:l': { d: 100, r: [[0, 10]] }, 'other:x': 1 },
  }, ctxIdb);
  assert.equal(n, 4);
  assert.equal(JSON.parse(local.get('lite-player-for-echo360:prefs')).rate, 1);
  assert.equal(JSON.parse(local.get('lite-player-for-echo360:prefs')).layout, 'pip');
  assert.equal(local.has('lite-player-for-echo360:debug'), false);
  assert.equal(local.has('lite-player-for-echo360:evil:key'), false);
  assert.equal(local.has('lite-player-for-echo360:pos:bad'), false);
  assert.equal(db.has('tags:bad'), false);
  assert.equal(db.has('other:x'), false);
  assert.equal(db.has('watched:l'), true);
});

test('T1.5 backup: everything made by a backup comes back from it, through a file', async () => {
  const local = new Map([
    ['lite-player-for-echo360:prefs', JSON.stringify({ rate: 1.5, layout: 'pip' })],
    ['lite-player-for-echo360:pos:abc', JSON.stringify({ t: 30, at: 1 })],
    ['lite-player-for-echo360:debug', 'true'],
    ['someone-else', 'x'],
  ]);
  const ls = { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, v), key: (i) => [...local.keys()][i], get length() { return local.size; } };
  const m = loadSources(['00-util', '01-i18n', '39-prefs', '40-player', '53-captions', '54-sidebar', '61-media-io', '62-silence', '11-echo360-api', '10-adapter', '85-export'], { localStorage: ls });
  const db = new Map([
    ['tags:s', { tags: [{ id: 'a', name: 'Exam', color: '#fff' }] }],
    ['tagmap:m', { n1: ['a'] }],
    ['watched:l', { d: 100, r: [[0, 10], [20, 30]], e: 90 }],
    ['screenpick:m', { index: 2 }],
    ['deck:m', { files: [{ hash: 'h', name: 'w1.pdf' }], fixes: [] }],
    ['slides:m', { v: 4, chapters: [] }],   // an analysis cache: not user data, not backed up
  ]);
  Object.assign(m.idbCache, { get: async (k) => db.get(k), keys: async () => [...db.keys()] });
  const file = JSON.stringify(await m.makeBackup(false));
  const data = JSON.parse(file);
  assert.equal(Object.keys(data.db).includes('slides:m'), false);
  assert.equal('debug' in data.local, false);
  // Into an empty browser.
  const before = { local: new Map(local), db: new Map(db) };
  local.clear();
  const db2 = new Map();
  const target = { get: async (k) => db2.get(k), put: async (k, v) => { db2.set(k, v); }, putMany: async (es) => { for (const [k, v] of es) db2.set(k, v); }, del: async (k) => { db2.delete(k); }, keys: async () => [...db2.keys()] };
  await m.restoreBackup(data, target);
  for (const k of ['tags:s', 'tagmap:m', 'watched:l', 'screenpick:m', 'deck:m']) assert.equal(JSON.stringify(db2.get(k)), JSON.stringify(before.db.get(k)), k);
  assert.equal(db2.has('slides:m'), false);
  assert.equal(JSON.parse(local.get('lite-player-for-echo360:prefs')).rate, 1.5);
  assert.equal(JSON.parse(local.get('lite-player-for-echo360:prefs')).layout, 'pip');
  assert.equal(JSON.parse(local.get('lite-player-for-echo360:pos:abc')).t, 30);
  assert.equal(local.has('lite-player-for-echo360:debug'), false);
});

test('S1: every element the player looks up by a single class exists exactly once in its markup', () => {
  const m = loadSources(['00-util', '01-i18n', '30-ui-assets', '53-captions', '62-silence']);
  const html = m.playerTemplate();
  const count = new Map();
  for (const [, cls] of html.matchAll(/class="([^"]+)"/g)) for (const c of cls.split(/\s+/)) count.set(c, (count.get(c) || 0) + 1);
  const src = readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(root, 'src', f), 'utf8')).join('\n');
  const single = new Set([...src.matchAll(/\$\('\.([\w-]+)'\)/g)].map((x) => x[1]));
  assert.ok(single.size > 40);
  const bad = [...single].filter((c) => count.get(c) !== 1).map((c) => c + ':' + (count.get(c) || 0));
  assert.deepEqual(bad, []);
});

test('C1: a second write while one is on its way does nothing (discussion and notes)', async () => {
  const m = loadSources(['00-util', '01-i18n', '54-sidebar', '55-notes', '57-discussion']);
  let calls = 0;
  let release;
  const slow = () => { calls++; return new Promise((r) => { release = r; }); };
  const pane = { showError() {}, fail() {}, load: async () => {} };
  const a = m.DiscussionPane.prototype.write.call(pane, {}, slow);
  const b = await m.DiscussionPane.prototype.write.call(pane, {}, slow);
  assert.equal(b, false);
  release();
  assert.equal(await a, true);
  assert.equal(calls, 1);
  const notes = {};
  let n = 0;
  let rel2;
  const x = m.NotesPane.prototype.once.call(notes, () => { n++; return new Promise((r) => { rel2 = r; }); });
  await m.NotesPane.prototype.once.call(notes, () => { n++; });
  rel2();
  await x;
  assert.equal(n, 1);
});

test('C3: when adding the bookmark fails, "tag here" tags nothing', async () => {
  const m = loadSources(['00-util', '01-i18n', '54-sidebar', '55-notes']);
  const far = { id: 'old', type: 'bookmark', time: 100 };
  const pane = {
    items: [far], p: { video: { currentTime: 3000 }, sidebar: { open() {} } },
    addBookmark: async () => null, render() { throw new Error('should not render'); },
  };
  await m.NotesPane.prototype.tagHere.call(pane, {});
  assert.equal(pane.picking, undefined);
});

test('L1: a renewal on its way when the player is disposed does not schedule another', async () => {
  const timers = [];
  const m = loadSources(['00-util', '36-session'], {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
  });
  let answer;
  m.setFetch(() => new Promise((r) => { answer = r; }));
  const d = new m.Disposer();
  const k = new m.SessionKeeper({ url: '/lesson/x', renewMs: 3600000, disposer: d, retryMs: [1, 1] });
  const p = k.renew(true);
  d.dispose();
  answer({ ok: true, status: 200, type: 'basic', body: null });
  await assert.rejects(p);
  assert.equal(timers.filter((x) => x.live && x.ms >= 60000).length, 0);
  assert.equal(m.mediaSession.renew, null);
  await assert.rejects(k.renew(true));
});

test('L2: a stopped text reader never starts the recognition engine', async () => {
  const m = loadSources(['00-util', '61-media-io', '64-slides', '66-slide-ocr']);
  const ac = new AbortController();
  ac.abort();
  const reader = { ac, engine: null };
  await assert.rejects(m.SlideTextReader.prototype.recognize.call(reader, null), /aborted/);
  assert.equal(reader.engine, null);
});

test('worker wrapper: closed means closed (no new Worker afterwards)', async () => {
  const m = loadSources(['00-util', '67-slide-text']);
  const w = new m.SlideTextWorker(new m.Disposer());
  w.close();
  await assert.rejects(w.run({}), /closed/);
});

// ---- M8.9 B and D ----

test('B1: errors in features are reported, not fatal; core errors hand over; async rejections are caught', async () => {
  const m = loadSources(['00-util']);
  let fallback = 0;
  const notices = [];
  m.unexpected.handler = () => { fallback++; };
  m.featureErrors.notify = (name) => notices.push(name);
  m.guard(() => { throw new Error('sync'); })();
  m.guard(async () => { throw new Error('async'); })(); // as a listener would: the return value is ignored
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fallback, 0);
  assert.equal(notices.length, 1);                   // one notice per feature, not per error
  const d = new m.Disposer();
  const f = d.feature('zoom');
  let released = 0;
  f.add(() => { released++; });
  const target = { addEventListener(type, fn) { this.fn = fn; }, removeEventListener() {} };
  f.listen(target, 'wheel', () => { throw new Error('zoom broke'); });
  target.fn();
  assert.equal(released, 1);                          // the feature's resources were released
  assert.ok(notices.includes('zoom'));
  assert.equal(fallback, 0);
  m.guardCore(() => { throw new Error('stream'); })();
  assert.equal(fallback, 1);                          // core playback: hand over
  assert.equal(m.featureGuard('x', () => { throw new Error('setup'); }), undefined);
  assert.ok(m.eventLog.some((e) => /setup/.test(e.text)));
});

test('B2: silence detection that stops keeps what it already found', () => {
  const m = loadSources(['00-util', '61-media-io', '62-silence']);
  let recomputed = 0;
  const a = { env: { coverage: () => 0.4 }, recompute() { recomputed++; }, onChange() {}, silences: [{ start: 1, end: 40 }], source: 'audio' };
  m.SilenceAnalyzer.prototype.fail.call(a, 'error');
  assert.equal(recomputed, 1);
  assert.equal(a.source, 'audio');
  const b = { env: null, onChange() {}, silences: [{ start: 1, end: 2 }], source: 'audio' };
  m.SilenceAnalyzer.prototype.fail.call(b, 'error');
  assert.equal(b.source, 'unavailable');
});

test('B6: an older discussion load that answers late does not overwrite a newer one', async () => {
  const m = loadSources(['00-util', '01-i18n', '54-sidebar', '57-discussion']);
  const answers = [];
  const pane = { api: { discussions: () => new Promise((r) => answers.push(r)) }, showError() {}, changed() {} };
  const first = m.DiscussionPane.prototype.load.call(pane);
  const second = m.DiscussionPane.prototype.load.call(pane);
  answers[1]({ threads: ['new'], hiddenCount: 0 });
  await second;
  answers[0]({ threads: ['old'], hiddenCount: 0 });
  await first;
  assert.deepEqual(pane.threads, ['new']);
});

test('B9: a restore that cannot write its entries writes nothing (no settings either)', async () => {
  const local = new Map();
  const m = loadSources(['00-util', '01-i18n', '39-prefs', '40-player', '53-captions', '54-sidebar', '61-media-io', '62-silence', '11-echo360-api', '10-adapter', '85-export'], {
    localStorage: { getItem: () => null, setItem: (k, v) => local.set(k, v), key: () => null, length: 0 },
  });
  const failing = { putMany: async () => { throw new Error('disk full'); } };
  await assert.rejects(m.restoreBackup({ app: 'lite-player-for-echo360', v: 1, local: { prefs: '{"rate":1.5}' }, db: { 'tags:s': { tags: [] } } }, failing), /disk full/);
  assert.equal(local.size, 0);
});

test('B8: diagnostics mask every address and long id', () => {
  const m = loadSources(['00-util', '86-diagnostics']);
  const s = m.maskUrls('HTTP 403 for https://content.echo360.net.au/0000.1eced04d/abc/s1q1.mp4 id 1eced04d-17e2-4cc3-affa-0643f089cf31 //x.y/z');
  assert.equal(/https?:|\/\/x/.test(s), false);
  assert.equal(s.includes('1eced04d-17e2'), false);
});

test('D1: uniform pictures, skippable stretches and where the content ends', () => {
  const m = loadSources(['00-util', '61-media-io', '62-silence', '64-slides']);
  const flat = pic(12, []);
  for (let y = 40; y < 44; y++) for (let x = 70; x < 74; x++) flat[y * 160 + x] = 200; // a cursor or a small logo
  const slide = pic(230, [10, 25, 40, 55, 70]);
  assert.equal(m.frameUniform(flat), true);
  assert.equal(m.frameUniform(slide), false);
  const samples = [0, 10, 20, 30, 40].map((t, i) => ({ t, uniform: i >= 3 }));
  assert.equal(JSON.stringify(m.uniformStretches(samples, 50)), '[{"start":30,"end":50}]');
  const sil = [{ start: 5, end: 9 }, { start: 31, end: 50 }];
  const list = m.skipStretches(sil, [{ start: 30, end: 50 }], true, 15);
  assert.equal(list.map((x) => x.kind).join(','), 'silence,blank');
  assert.equal(m.contentEndAt(list, 50), 31);
  // Someone speaking over the empty screen: nothing to skip there.
  assert.equal(m.skipStretches([], [{ start: 30, end: 50 }], true, 15).length, 0);
  // Audio unknown: marked as "black screen" (skipped only by hand).
  assert.equal(m.skipStretches([], [{ start: 30, end: 50 }], false, 15)[0].kind, 'black');
  assert.equal(m.contentEndAt([{ start: 1, end: 9, kind: 'silence' }], 50), 50);
});

test('D1: watched share leaves out an empty ending', () => {
  const m = loadSources(['00-util', '20-reporter', '61-media-io', '52-watched']);
  assert.equal(m.watchedShare({ d: 100, e: 80, r: [[0, 80]] }), 1);
  assert.equal(m.watchedShare({ d: 100, r: [[0, 80]] }), 0.8);
});

test('slide controller: the page-deciding Worker and the pdf.js worker are separate fields', () => {
  const m = loadSources(['00-util', '01-i18n', '61-media-io', '67-slide-text', '68-slide-deck']);
  const deck = new m.SlideDeckController({ lesson: {}, video: {}, slides: null, disposer: new m.Disposer() });
  assert.ok(deck.worker instanceof m.SlideTextWorker);
  assert.equal(typeof deck.worker.run, 'function');
  assert.equal(deck.pdfWorker, null);
});

test('caches: marking a record as used never touches its data (OCR records keep their own "at")', () => {
  const m = loadSources(['00-util', '61-media-io', '63-caches']);
  const rec = { v: 1, at: [3, -1, 4], texts: ['a'], savedAt: 1000 };
  const t = m.cacheTouched(rec, 5000);
  assert.deepEqual(Array.from(t.at), [3, -1, 4]);
  assert.equal(m.cacheLastUse(t), 5000);
  assert.equal(m.cacheLastUse({ v: 1, at: [1, 2], savedAt: 1234 }), 1234);   // from before "used"
  assert.equal(m.cacheLastUse({ v: 1, at: 777 }), 777);
  assert.equal(m.cacheValid('ocr', rec), true);
  assert.equal(m.cacheValid('slides', { v: 1 }), false);
});

test('caption excerpt: last span in whole sentences', () => {
  const m = loadSources(['00-util', '53-captions']);
  const cues = [
    { start: 0, end: 5, text: 'First sentence.' },
    { start: 5, end: 9, text: 'This one starts here' },
    { start: 9, end: 14, text: 'and ends here.' },
    { start: 14, end: 18, text: 'Now we talk about' },
    { start: 18, end: 22, text: 'Fourier series.' },
    { start: 40, end: 44, text: 'Later.' },
  ];
  // The last 6 s before t = 16 begin in the cue at 9-14, which continues the one at 5-9, so
  // the excerpt reaches back to 5; the sentence being spoken at 16 is completed (to 22).
  const x = m.captionExcerpt(cues, 16, 6);
  assert.equal(x.start, 5);
  assert.equal(x.end, 22);
  assert.equal(x.text, 'This one starts here and ends here. Now we talk about Fourier series.');
  assert.equal(m.captionExcerpt(cues, 3, 60).start, 0);
  assert.equal(m.captionExcerpt([], 3, 60), null);
});
