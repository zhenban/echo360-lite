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
    + ['clamp', 'fmtTime', 'parseIsoDuration', 'Disposer', 'PlayedRanges', 'FollowerSync', 'CueIndex', 'parseVtt', 'AudioChain', 'seg', 'thumbnailFor', 'pickAudioRendition', 'parseMediaPlaylist', 'Envelope', 'findSilences', 'silencesFromCues', 'speechSpans', 'silenceIndexAt']
      .map((n) => `if (typeof ${n} !== 'undefined') globalThis.__exports.${n} = ${n};`).join('\n');
  vm.runInContext(code, ctx);
  return { ...ctx.__exports, timers, window: ctx.window };
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
  return loadSources(['00-util', '54-silence']);
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
