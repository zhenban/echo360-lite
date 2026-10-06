// Unit tests for the pure logic in src/ (no browser needed).
//   node --test test/
// The sources are plain scripts meant to be concatenated, so they are evaluated in a small
// sandbox with just enough browser globals stubbed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadSources(names) {
  const timers = [];
  const ctx = {
    console, URL,
    AudioContext: class {},
    window: {},
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: (...a) => ctx.__fetch(...a),
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    setTimeout, clearTimeout,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    __timers: timers,
  };
  vm.createContext(ctx);
  const files = readdirSync(join(root, 'src')).filter((f) => names.some((n) => f.includes(n))).sort();
  const code = files.map((f) => readFileSync(join(root, 'src', f), 'utf8')).join('\n')
    + '\n;globalThis.__exports = {};'
    + ['clamp', 'fmtTime', 'parseIsoDuration', 'Disposer', 'PlayedRanges', 'FollowerSync', 'CueIndex', 'parseVtt', 'AudioChain', 'seg', 'thumbnailFor', 'pickAudioRendition', 'parseMediaPlaylist', 'Envelope', 'findSilences', 'silencesFromCues', 'speechSpans', 'silenceIndexAt', 'mp4Boxes', 'parseFragment', 'videoVariants', 'frameDistance', 'sameView', 'buildScenes', 'chapterIndexAt', 'SessionKeeper', 'mediaSession', 'TagStore', 'watchedShare', 'followSamples', 'followLecture', 'textScores', 'FORCE_OFF', 'captionExcerpt']
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
  const m = loadSources(['00-util', '45-captions']);
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
  const m = loadSources(['00-util', '52-audio']);
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
  const m = loadSources(['00-util', '52-audio']);
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
  return loadSources(['00-util', '53-media-io', '54-silence']);
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

// ---- slide chapters ----

function slidesMod() {
  return loadSources(['00-util', '53-media-io', '56-slides']);
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

test('video variants sorted by height', () => {
  const m = slidesMod();
  const v = m.videoVariants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2118548,RESOLUTION=1280x720\ns1q1.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=613230,RESOLUTION=640x360\ns1q0.m3u8\n', 'https://x.test/a/s1_v.m3u8?k=1');
  assert.equal(v.length, 2);
  assert.equal(v[0].height, 360);
  assert.equal(v[0].uri, 'https://x.test/a/s1q0.m3u8');
});

// Synthetic 32 x 18 RGB pictures: a flat background with `rows` of "text" at given lines.
function pic(bg, lines, ink) {
  const a = new Uint8Array(32 * 18 * 3).fill(bg);
  for (const y of lines) for (let x = 2; x < 30; x++) a.fill(bg > 128 ? 20 : 230, (y * 32 + x) * 3, (y * 32 + x) * 3 + 3);
  for (const [x, y] of ink || []) a.fill(bg > 128 ? 60 : 200, (y * 32 + x) * 3, (y * 32 + x) * 3 + 3);
  return a;
}

test('frame comparison: ink and pointers are the same slide, new slides are not', () => {
  const m = slidesMod();
  const slideA = pic(230, [2, 5, 8, 11]);
  const inked = pic(230, [2, 5, 8, 11], [[4, 3], [5, 3], [6, 4], [7, 4], [8, 4], [9, 5], [10, 6], [11, 6], [12, 7], [13, 7], [14, 7]]);
  const slideB = pic(230, [3, 6, 7, 10, 13, 15]);
  const editor = pic(25, [1, 3, 4, 6, 9, 12]);
  assert.equal(m.sameView(slideA, slideA), true);
  assert.equal(m.sameView(slideA, inked), true);
  assert.equal(m.sameView(slideA, slideB), false);
  assert.equal(m.sameView(slideA, editor), false);
  assert.ok(m.frameDistance(slideA, editor).changed > 0.5);
});

test('scenes: revisits continue a chapter, short runs merge, lookup', () => {
  const m = slidesMod();
  const A = pic(230, [2, 5, 8, 11]);
  const B = pic(230, [3, 6, 7, 10, 13, 15]);
  const C = pic(230, [1, 4, 12, 14, 16]);
  const E = pic(25, [1, 3, 4, 6, 9, 12]);
  const seq = 'AAAAEEAAEEAAABBBBBBX CCCC'.replace(/ /g, '').split('');
  // X: a single frame caught mid-transition.
  const X = pic(128, [9]);
  const map = { A, B, C, E, X };
  const samples = seq.map((ch, k) => ({ t: k * 10, sig: map[ch] }));
  const scenes = m.buildScenes(samples, seq.length * 10);
  // A (short editor detours fold back into it) | B | X + C
  assert.equal(JSON.stringify(scenes.map((s) => s.start)), '[0,130,190]');
  assert.equal(scenes[0].end, 130);
  assert.equal(seq[scenes[0].rep], 'A');
  assert.equal(scenes[2].end, seq.length * 10);
  assert.equal(seq[scenes[1].rep], 'B');
  assert.equal(seq[scenes[2].rep], 'C');
  assert.equal(m.chapterIndexAt(scenes, 0), 0);
  assert.equal(m.chapterIndexAt(scenes, 135), 1);
  assert.equal(m.chapterIndexAt(scenes, 1e6), 2);
});

// ---- slide following ----

function deckMod() {
  return loadSources(['00-util', '53-media-io', '56-slides', '58-slide-text', '59-slide-deck']);
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
  const m = loadSources(['00-util', '01-i18n', '53-media-io', '47-tags']);
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
  const m = loadSources(['00-util', '20-reporter', '53-media-io', '43-watched']);
  assert.equal(m.watchedShare({ d: 100, r: [[0, 10], [50, 70]] }), 0.3);
  assert.equal(m.watchedShare({ d: 100, r: [[90, 130]] }), 0.1);
  assert.equal(m.watchedShare(null), 0);
});

test('caption excerpt: last span in whole sentences', () => {
  const m = loadSources(['00-util', '45-captions']);
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
