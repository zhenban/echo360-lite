// ===================================================================================
// Slide chapters: find where the screen view changes to a new slide.
//
// Sources, best first:
//   1. Chapter or slide data from Echo360 itself. None of the recordings checked so far had
//      any (cfg.chapters, slide decks and scenes were all empty), so this is not used yet.
//   2. Keyframes of the screen view. Every 10 s HLS segment starts with a keyframe; reading
//      just the start of each segment (about 20 KB at 360p, 15 MB for two hours) and
//      decoding it with WebCodecs gives the whole lecture at 10 s resolution. Each change is
//      then pinned to about 1 s by decoding the one segment it happened in. Downloads only
//      run while playback has enough buffer, and the result is cached in IndexedDB.
//   3. Echo360's preview thumbnails (one per minute), when WebCodecs is not available.
//      They are also shown at once while the keyframes are being read.
//
// Which view is the screen: slides, code and documents have large flat areas, camera
// pictures do not (sensor noise), so the view with the most flat area is used.
//
// Change detection compares tiny 32 x 18 versions of two frames. Small changes (mouse
// pointer, laser pointer, ink added to a slide, a small animation, scrolling code) touch
// only a small share of the pixels and are not a new slide. A run of quick changes (scrolling
// code, flicking through slides) becomes one chapter instead of many.
//
// Reusable pieces (slide text recognition will read sharper keyframes the same way):
//   HlsVideoReader   open(), segments, segmentAt(t), keyframe(i) -> VideoFrame,
//                    frames(i, stepSec, onFrame)
//   frameSignature(img), frameDistance(a, b), sameView(a, b)
//   buildScenes(samples, duration, opts) -> [{ start, end, rep }]
//   SlideAnalyzer    chapters: [{ start, end, precise, repTime, thumb }], screenIndex, reader
// ===================================================================================

const SIG_W = 32;
const SIG_H = 18;
const KEYFRAME_PROBE_BYTES = 24 * 1024;  // moof (~2.5 KB) + a 360p keyframe (~17 KB), usually
const SCENE_MIN_SEC = 20;                // shorter scenes in a row are one chapter
const SCENE_REVISIT_SEC = 180;           // going back to a view shown this recently is no new chapter
const SCENE_DETOUR_SEC = 60;             // a shorter excursion that comes back belongs to the chapter
const SCREEN_CLEARLY = 0.75;             // see findScreen
const ANALYSIS_MAX_FAILS = 5;            // segments in a row that cannot be read before an analysis gives up
const CHAPTER_THUMB_W = 192;

// ---- fragmented MP4 ----

function mp4Boxes(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr) break;
    out.push({ type, start: p, body: p + hdr, end: Math.min(p + size, end), size });
    p += size;
  }
  return out;
}

function mp4Find(dv, start, end, path) {
  let box = { body: start, end };
  for (const type of path) {
    box = mp4Boxes(dv, box.body, box.end).find((b) => b.type === type);
    if (!box) return null;
  }
  return box;
}

// Init segment of an H.264 track -> what VideoDecoder.configure() needs.
function parseVideoInit(buf) {
  const dv = new DataView(buf);
  const stsd = mp4Find(dv, 0, dv.byteLength, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  const mdhd = mp4Find(dv, 0, dv.byteLength, ['moov', 'trak', 'mdia', 'mdhd']);
  if (!stsd || !mdhd) throw new Error('unexpected init segment');
  const entry = mp4Boxes(dv, stsd.body + 8, stsd.end)[0];
  if (!entry || (entry.type !== 'avc1' && entry.type !== 'avc3')) throw new Error('not H.264: ' + (entry && entry.type));
  const avcC = mp4Boxes(dv, entry.body + 78, entry.end).find((b) => b.type === 'avcC');
  if (!avcC) throw new Error('no avcC');
  const hex = (o) => dv.getUint8(avcC.body + o).toString(16).padStart(2, '0');
  const v = dv.getUint8(mdhd.body);
  return {
    codec: entry.type + '.' + hex(1) + hex(2) + hex(3),
    description: new Uint8Array(buf.slice(avcC.body, avcC.end)),
    timescale: dv.getUint32(mdhd.body + (v ? 20 : 12)),
    width: dv.getUint16(entry.body + 24),
    height: dv.getUint16(entry.body + 26),
  };
}

// Samples of the first track fragment, in decode order: [{ offset, size, time, key }] with
// offsets relative to the start of `buf` and time in timescale units (presentation time).
// Samples whose bytes are not in `buf` are still listed (the caller checks the size).
function parseFragment(buf, segmentOffset) {
  const dv = new DataView(buf);
  const moof = mp4Boxes(dv, 0, dv.byteLength).find((b) => b.type === 'moof');
  if (!moof) throw new Error('no moof');
  const traf = mp4Find(dv, moof.body, moof.end, ['traf']);
  const kids = mp4Boxes(dv, traf.body, traf.end);
  const tfhd = kids.find((b) => b.type === 'tfhd');
  const tfdt = kids.find((b) => b.type === 'tfdt');
  const trun = kids.find((b) => b.type === 'trun');
  if (!tfhd || !trun) throw new Error('unexpected fragment');
  const hf = dv.getUint32(tfhd.body) & 0xffffff;
  let p = tfhd.body + 8;
  let base = moof.start;
  if (hf & 0x1) { base = Number(dv.getBigUint64(p)) - (segmentOffset || 0); p += 8; }
  if (hf & 0x2) p += 4;
  let defDur = 0;
  let defSize = 0;
  let defFlags = 0;
  if (hf & 0x8) { defDur = dv.getUint32(p); p += 4; }
  if (hf & 0x10) { defSize = dv.getUint32(p); p += 4; }
  if (hf & 0x20) { defFlags = dv.getUint32(p); p += 4; }
  let t = 0;
  if (tfdt) t = dv.getUint8(tfdt.body) ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);
  const rf = dv.getUint32(trun.body) & 0xffffff;
  const version = dv.getUint8(trun.body);
  const count = dv.getUint32(trun.body + 4);
  p = trun.body + 8;
  let offset = base;
  if (rf & 0x1) { offset = base + dv.getInt32(p); p += 4; }
  let firstFlags = null;
  if (rf & 0x4) { firstFlags = dv.getUint32(p); p += 4; }
  const samples = [];
  for (let i = 0; i < count; i++) {
    let dur = defDur;
    let size = defSize;
    let flags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
    let cto = 0;
    if (rf & 0x100) { dur = dv.getUint32(p); p += 4; }
    if (rf & 0x200) { size = dv.getUint32(p); p += 4; }
    if (rf & 0x400) { flags = dv.getUint32(p); p += 4; }
    if (rf & 0x800) { cto = version ? dv.getInt32(p) : dv.getUint32(p); p += 4; }
    // sample_is_non_sync_sample is bit 16 of the flags.
    samples.push({ offset, size, time: t + cto, key: !(flags & 0x10000) });
    offset += size;
    t += dur;
  }
  return { samples, end: offset };
}

// ---- reading frames from an HLS video stream ----

// Variant URIs of a master playlist with their heights, lowest first.
function videoVariants(master, base) {
  const out = [];
  const lines = String(master).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = parseAttrs(lines[i].slice(18));
    const uri = (lines.slice(i + 1).find((l) => l && !l.startsWith('#')) || '').trim();
    const h = a.RESOLUTION ? +a.RESOLUTION.split('x')[1] : 0;
    if (uri) out.push({ uri: new URL(uri, base).href, height: h, bandwidth: +a.BANDWIDTH || 0 });
  }
  return out.sort((x, y) => x.height - y.height || x.bandwidth - y.bandwidth);
}

class HlsVideoReader {
  // maxHeight: the tallest rendition to use (the smallest one if none is small enough).
  // minHeight (optional): use the smallest rendition at least this tall instead (the
  // tallest one if none is).
  constructor(masterUrl, maxHeight, minHeight) {
    this.masterUrl = masterUrl;
    this.maxHeight = maxHeight || 360;
    this.minHeight = minHeight || 0;
    this.segments = [];
    this.info = null;
    this.bytes = 0;          // downloaded so far
    this.lastNeed = 0;       // bytes the last keyframe needed
  }

  static supported() {
    return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
  }

  async open(signal) {
    const master = await (await fetchOk(this.masterUrl, { signal })).text();
    let url = this.masterUrl;
    if (/#EXT-X-STREAM-INF/.test(master)) {
      const vs = videoVariants(master, this.masterUrl);
      let pick;
      if (this.minHeight) {
        pick = vs.find((v) => v.height >= this.minHeight) || vs[vs.length - 1];
      } else {
        const fit = vs.filter((v) => v.height && v.height <= this.maxHeight);
        pick = fit.length ? fit[fit.length - 1] : vs[0];
      }
      if (!pick) throw new Error('no video variant');
      url = pick.uri;
    }
    const pl = parseMediaPlaylist(await (await fetchOk(url, { signal })).text(), url);
    if (!pl.init || !pl.segments.length || pl.segments.some((s) => s.length === null)) throw new Error('unsupported playlist layout');
    this.segments = pl.segments;
    const init = await fetchRange(pl.init.url, pl.init.offset, pl.init.length, signal);
    this.info = parseVideoInit(init);
    const cfg = { codec: this.info.codec, description: this.info.description };
    const ok = await VideoDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (!ok.supported) throw new Error('decoder not supported: ' + this.info.codec);
    const last = this.segments[this.segments.length - 1];
    this.duration = last.start + last.dur;
    return this;
  }

  segmentAt(t) {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // Decodes encoded samples; onFrame(frame) is called in presentation order and the frame
  // is closed right after it returns.
  async decode(chunks, onFrame) {
    let failed = null;
    const dec = new VideoDecoder({
      output: (frame) => { try { if (!failed) onFrame(frame); } catch (e) { failed = e; } finally { frame.close(); } },
      error: (e) => { failed = failed || e; },
    });
    try {
      dec.configure({ codec: this.info.codec, description: this.info.description, optimizeForLatency: true });
      for (const c of chunks) dec.decode(c);
      await dec.flush();
    } finally {
      if (dec.state !== 'closed') dec.close();
    }
    if (failed) throw failed;
  }

  // First frame of segment i, as a signature-ready callback: fn(frame) is called once.
  async keyframe(i, signal, fn) {
    const s = this.segments[i];
    // A keyframe grows with the picture (about 20 KB at 360p) and its content; asking for a
    // little more than the last one needed usually saves a second request.
    const base = Math.round(KEYFRAME_PROBE_BYTES * Math.max(1, ((this.info && this.info.height) || 360) / 360) ** 2);
    const probe = Math.max(base, Math.round((this.lastNeed || 0) * 1.2));
    let buf = await fetchRange(s.url, s.offset, Math.min(s.length, probe), signal);
    this.bytes += buf.byteLength;
    const frag = parseFragment(buf, s.offset);
    const k = frag.samples[0];
    if (!k || !k.key) throw new Error('segment does not start with a keyframe');
    this.lastNeed = k.offset + k.size;
    if (k.offset + k.size > buf.byteLength) {
      // Only the rest of it.
      const more = await fetchRange(s.url, s.offset + buf.byteLength, Math.min(s.length, k.offset + k.size) - buf.byteLength, signal);
      this.bytes += more.byteLength;
      const all = new Uint8Array(buf.byteLength + more.byteLength);
      all.set(new Uint8Array(buf), 0);
      all.set(new Uint8Array(more), buf.byteLength);
      buf = all.buffer;
    }
    const ts = this.info.timescale;
    const chunk = new EncodedVideoChunk({ type: 'key', timestamp: Math.round((k.time / ts) * 1e6), data: new Uint8Array(buf, k.offset, k.size) });
    let got = false;
    await this.decode([chunk], (f) => { if (!got) { got = true; fn(f, k.time / ts); } });
    if (!got) throw new Error('no frame decoded');
  }

  // Every frame of segment i at least stepSec apart: fn(frame, seconds).
  async frames(i, stepSec, signal, fn) {
    const s = this.segments[i];
    const buf = await fetchRange(s.url, s.offset, s.length, signal);
    const frag = parseFragment(buf, s.offset);
    const ts = this.info.timescale;
    const chunks = frag.samples
      .filter((x) => x.offset + x.size <= buf.byteLength)
      .map((x, j) => new EncodedVideoChunk({ type: j === 0 || x.key ? 'key' : 'delta', timestamp: Math.round((x.time / ts) * 1e6), data: new Uint8Array(buf, x.offset, x.size) }));
    let next = -Infinity;
    await this.decode(chunks, (f) => {
      const t = f.timestamp / 1e6;
      if (t + 1e-6 < next) return;
      next = t + stepSec;
      fn(f, t);
    });
  }
}

// ---- comparing frames ----

let sigCtx = null;
function sigContext() {
  if (!sigCtx) {
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(SIG_W, SIG_H) : Object.assign(document.createElement('canvas'), { width: SIG_W, height: SIG_H });
    sigCtx = c.getContext('2d', { willReadFrequently: true });
  }
  return sigCtx;
}

// 32 x 18 RGB thumbnail of any drawable (VideoFrame, ImageBitmap, <video>, <img>).
function frameSignature(img) {
  const g = sigContext();
  g.drawImage(img, 0, 0, SIG_W, SIG_H);
  return Uint8Array.from(g.getImageData(0, 0, SIG_W, SIG_H).data.filter((x, i) => i % 4 !== 3));
}

// corr: correlation of the two pictures; mad: mean absolute difference (0-255); changed:
// share of pixels whose brightness moved by more than 40.
function frameDistance(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  let mad = 0;
  let changed = 0;
  for (let i = 0; i < n; i += 3) {
    const la = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
    const lb = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
    if (Math.abs(la - lb) > 40) changed++;
  }
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; mad += Math.abs(a[i] - b[i]); }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  return { corr: saa && sbb ? sab / Math.sqrt(saa * sbb) : (saa === sbb ? 1 : 0), mad: mad / n, changed: changed / (n / 3) };
}

// Same slide? Measured on a real lecture (keyframes 10 s apart): ink added to a slide and
// scrolling or typing in a code editor change 6-15% of the pixels; a new slide changes at
// least 16%, switching between slides and an editor more than half.
function sameView(a, b) {
  const d = frameDistance(a, b);
  return d.changed < 0.16 || d.mad <= 8 || (d.corr >= 0.9 && d.mad <= 20);
}

// Stricter test for "back to the same picture" (see buildScenes).
function sameViewStrict(a, b) {
  const d = frameDistance(a, b);
  return d.changed < 0.06 || d.mad <= 6;
}

// A picture of (almost) one colour: a black screen, a "no signal" picture, a blank slide in
// one colour. Judged by evenness, not darkness, so any kind of empty picture counts: nearly
// every pixel of the small signature is within noise of the median brightness.
const UNIFORM_NOISE = 10;     // brightness levels (0-255) of compression noise at 32 x 18
const UNIFORM_SHARE = 0.985;  // pixels that must be that close (a small logo or a cursor may differ)
function frameUniform(sig) {
  const n = sig.length / 3;
  const l = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) l[i] = sig[j] * 0.299 + sig[j + 1] * 0.587 + sig[j + 2] * 0.114;
  const sorted = Float32Array.from(l).sort();
  const med = sorted[n >> 1];
  let close = 0;
  for (let i = 0; i < n; i++) if (Math.abs(l[i] - med) <= UNIFORM_NOISE) close++;
  return close >= UNIFORM_SHARE * n;
}

// Stretches of uniform samples: [{ start, end }] (a stretch ends where the next sample starts).
function uniformStretches(samples, duration) {
  const out = [];
  for (let k = 0; k < samples.length; k++) {
    if (!samples[k].uniform) continue;
    const end = k + 1 < samples.length ? samples[k + 1].t : duration;
    const last = out[out.length - 1];
    if (last && last.end >= samples[k].t - 0.01) last.end = end; else out.push({ start: samples[k].t, end });
  }
  return out;
}

// Share of pixels that equal their right and lower neighbours: high for slides and code,
// low for camera pictures.
function flatShare(img) {
  const W = 160;
  const H = 90;
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  let n = 0;
  let tot = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      const l = d[i] + d[i + 1] + d[i + 2];
      tot++;
      if (Math.abs(l - d[i + 4] - d[i + 5] - d[i + 6]) <= 3 && Math.abs(l - d[i + W * 4] - d[i + W * 4 + 1] - d[i + W * 4 + 2]) <= 3) n++;
    }
  }
  return n / tot;
}

// ---- scenes ----

// samples: [{ t, sig }] in time order. Returns scenes [{ start, end, rep }] where rep is the
// sample that best shows the chapter: the last sample (ink and builds are complete there)
// of the view it stays on longest. A scene starts at its first sample; refinement moves
// it earlier.
//
// Lecturers often switch back and forth between a slide and a code editor or a question
// board. Coming back to something shown in the last few minutes is not a new chapter, and
// a short excursion (under detourSec) that comes back to the previous chapter becomes part
// of it. The "back to the same picture" test is stricter than the same-slide test, because
// different slides with the same layout can pass the latter. Of the remaining scenes,
// several short ones in a row are one chapter, and a single short one (a transition caught
// mid-way) joins the next.
function buildScenes(samples, duration, opts) {
  const o = Object.assign({ minSec: SCENE_MIN_SEC, revisitSec: SCENE_REVISIT_SEC, detourSec: SCENE_DETOUR_SEC, same: sameView, revisit: sameViewStrict }, opts);
  if (!samples.length) return [];
  const tAt = (k) => (k < samples.length ? samples[k].t : duration);
  // Runs of the same view.
  const runs = [{ a: 0, b: 0 }];
  for (let k = 1; k < samples.length; k++) {
    if (o.same(samples[k - 1].sig, samples[k].sig)) runs[runs.length - 1].b = k;
    else runs.push({ a: k, b: k });
  }
  const raw = [{ a: 0, b: runs[0].b, runs: [runs[0]] }];
  for (let i = 1; i < runs.length; i++) {
    const r = runs[i];
    const t0 = samples[r.a].t;
    let seen = -1;
    for (let j = i - 1; j >= 0 && seen < 0 && samples[runs[j].b].t >= t0 - o.revisitSec; j--) {
      if (o.revisit(samples[runs[j].b].sig, samples[r.a].sig) || o.revisit(samples[runs[j].a].sig, samples[r.a].sig)) seen = j;
    }
    const cur = raw[raw.length - 1];
    if (seen < 0) { raw.push({ a: r.a, b: r.b, runs: [r] }); continue; }
    cur.b = r.b;
    cur.runs.push(r);
    // Back to the chapter before a short excursion: the excursion joins that chapter.
    if (raw.length >= 2 && runs[seen].b < cur.a && t0 - samples[cur.a].t < o.detourSec) {
      const prev = raw[raw.length - 2];
      prev.b = cur.b;
      prev.runs.push(...cur.runs);
      raw.pop();
    }
  }
  const len = (r) => tAt(r.b + 1) - samples[r.a].t;
  const merged = [];
  for (let i = 0; i < raw.length; i++) {
    const r = { a: raw[i].a, b: raw[i].b, runs: raw[i].runs.slice() };
    const absorb = (x) => { r.b = x.b; r.runs.push(...x.runs); };
    if (len(r) < o.minSec) {
      // Absorb following short scenes into one busy stretch.
      let j = i;
      while (j + 1 < raw.length && len(raw[j + 1]) < o.minSec) j++;
      if (j > i) { for (let q = i + 1; q <= j; q++) absorb(raw[q]); i = j; } else if (i + 1 < raw.length) { absorb(raw[i + 1]); i++; }
    }
    merged.push(r);
  }
  return merged.map((r, i) => {
    let best = r.runs[0];
    for (const x of r.runs) if (tAt(x.b + 1) - samples[x.a].t >= tAt(best.b + 1) - samples[best.a].t) best = x;
    return {
      start: i === 0 ? 0 : samples[r.a].t,
      end: i + 1 < merged.length ? samples[merged[i + 1].a].t : duration,
      rep: best.b,
    };
  });
}

function chapterIndexAt(chapters, t) {
  let lo = 0;
  let hi = chapters.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chapters[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return k;
}

// A small copy of a frame, made synchronously (a VideoFrame is only valid in its callback).
function smallBitmap(img, w) {
  const c = new OffscreenCanvas(w, Math.round((w * 9) / 16));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function bitmapToBlob(canvas) {
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

// ---- the controller used by the player ----

class SlideAnalyzer {
  // opts: { lesson, video, disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('slide chapters (display)', e); } };
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.state = 'pending';   // pending | thumbnails | keyframes | done | unavailable
    this.progress = 0;
    this.chapters = [];
    this.uniform = [];       // stretches where the screen shows (almost) one colour
    this.screenIndex = null;
    this.guessScreen = null;
    this.reader = null;
    this.urls = [];
    this.d.add(() => { for (const u of this.urls) URL.revokeObjectURL(u); this.urlOf = null; });
  }

  start() {
    this.run().catch((e) => {
      if (this.ac.signal.aborted) return;
      log.warn('slide detection stopped:', e && e.message ? e.message : e);
      if (!this.chapters.length) { this.state = 'unavailable'; this.onChange(); }
    });
  }

  duration() {
    const v = this.video.duration;
    return isFinite(v) && v > 0 ? v : this.lesson.duration;
  }

  thumbUrl(blob) {
    if (!this.urlOf) this.urlOf = new Map();
    let u = this.urlOf.get(blob);
    if (!u) {
      u = URL.createObjectURL(blob);
      this.urlOf.set(blob, u);
      this.urls.push(u);
    }
    return u;
  }

  // Lets go of pictures no chapter shows any more (chapters are rebuilt while scanning).
  pruneThumbs() {
    if (!this.urlOf) return;
    const used = new Set(this.chapters.map((c) => c.blob).filter(Boolean));
    for (const [blob, u] of this.urlOf) {
      if (used.has(blob)) continue;
      URL.revokeObjectURL(u);
      this.urlOf.delete(blob);
    }
    this.urls = [...this.urlOf.values()];
  }

  async run() {
    const signal = this.ac.signal;
    const key = 'slides:' + this.lesson.mediaId;
    const cached = this.lesson.mediaId ? await idbCache.get(key) : undefined;
    if (cacheValid('slides', cached) && Array.isArray(cached.chapters)) {
      cacheTouch(key);
      this.uniform = Array.isArray(cached.uniform) ? cached.uniform : [];
      this.screenIndex = cached.screen;
      this.chapters = cached.chapters.map((c) => Object.assign({}, c, { thumb: c.blob ? this.thumbUrl(c.blob) : c.thumb }));
      this.state = 'done';
      this.progress = 1;
      this.onChange();
      return;
    }
    // Which view is the screen is needed early (quality settings are per view); it only
    // takes a few small thumbnails.
    const screen = await this.findScreen(signal);
    if (!screen) { this.state = 'unavailable'; this.onChange(); return; }
    this.screenIndex = screen.source.index;
    this.onChange();
    await this.gate.wait(5000); // let playback start first
    if (screen.thumbs) this.fromThumbnails(screen.thumbs);
    if (!HlsVideoReader.supported() || (navigator.connection && navigator.connection.saveData)) {
      if (this.chapters.length) { this.state = 'done'; this.progress = 1; this.onChange(); }
      return;
    }
    await this.fromKeyframes(screen.source, signal);
    this.save(key);
  }

  // Which view is the screen: the one whose thumbnails have clearly more flat area than
  // every other view's (a slide or a document is flatter than a camera picture). "Clearly"
  // is measured within this recording, not against a fixed level: a busy screen (a browser
  // with toolbars, a code editor) can be less flat than a slide show and still be much
  // flatter than the camera. With a single view, that view.
  // Also sets this.guessScreen: the flattest view even when not clearly so (the slide
  // reader still needs one to read).
  async findScreen(signal) {
    const sets = this.lesson.thumbnails || [];
    let scored = [];
    for (const src of this.lesson.sources) {
      const set = sets.find((s) => s.sourceIndex === src.index);
      if (!set || !Array.isArray(set.timesInSeconds) || !set.timesInSeconds.length) continue;
      const ts = set.timesInSeconds;
      const vals = [];
      for (let k = 0; k < 6; k++) {
        const t = ts[Math.floor(((k + 0.5) * ts.length) / 6)];
        // One picture that cannot be read does not decide anything.
        let img = null;
        try { img = await this.loadThumb(set, t, signal); } catch (e) { if (signal.aborted) throw e; }
        if (!img) continue;
        vals.push(flatShare(img));
        img.close();
      }
      if (vals.length >= 3) scored.push({ source: src, set, vals });
    }
    // No usable thumbnails for some view: a few keyframes of each view instead (360p,
    // about 20 KB each).
    if (this.lesson.sources.length > 1 && scored.length < this.lesson.sources.length && HlsVideoReader.supported()) {
      scored = [];
      for (const src of this.lesson.sources) {
        const vals = [];
        try {
          const rd = await new HlsVideoReader(src.v || src.av, 360).open(signal);
          const n = rd.segments.length;
          for (let k = 0; k < 6; k++) {
            await rd.keyframe(Math.floor(((k + 0.5) * n) / 6), signal, (f) => vals.push(flatShare(f)));
          }
        } catch (e) { if (signal.aborted) throw e; }
        if (vals.length >= 3) scored.push({ source: src, set: null, vals });
      }
    }
    if (!scored.length) {
      // No usable thumbnails: a single view is assumed to be worth scanning.
      if (this.lesson.sources.length === 1) { this.guessScreen = this.lesson.sources[0].index; return { source: this.lesson.sources[0], thumbs: null }; }
      return null;
    }
    const median = (v) => { const a = v.slice().sort((x, y) => x - y); return (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2; };
    scored.sort((a, b) => median(b.vals) - median(a.vals));
    const best = scored[0];
    this.guessScreen = best.source.index;
    if (scored.length === 1) return this.lesson.sources.length === 1 ? { source: best.source, thumbs: best.set } : null;
    // Chance that a picture of the best view is flatter than one of the other view
    // (ties count half); 3 in 4 or more against every other view.
    const beats = (a, b) => {
      let w = 0;
      for (const x of a) for (const y of b) w += x > y ? 1 : x === y ? 0.5 : 0;
      return w / (a.length * b.length);
    };
    if (scored.slice(1).every((o) => beats(best.vals, o.vals) >= SCREEN_CLEARLY)) return { source: best.source, thumbs: best.set };
    return null;
  }

  async loadThumb(set, t, signal) {
    const url = set.baseUri + '/' + t + '.' + set.extension;
    let r;
    try {
      r = await fetchOk(url, { signal });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      // A copy cached from the original player (loaded as a plain image) can lack the
      // CORS headers; ask the server again.
      r = await fetchOk(url, { signal, cache: 'reload' });
    }
    return createImageBitmap(await r.blob());
  }

  // Coarse chapters from the per-minute thumbnails: a change between two thumbnails is
  // placed half way between them.
  async fromThumbnailsAsync(set) {
    const samples = [];
    let fails = 0;
    for (const t of set.timesInSeconds) {
      await this.gate.wait(0);
      // A preview picture that cannot be read is left out.
      let img = null;
      try { img = await this.loadThumb(set, t, this.ac.signal); fails = 0; } catch (e) {
        if (this.ac.signal.aborted || ++fails >= ANALYSIS_MAX_FAILS) throw e;
        continue;
      }
      samples.push({ t, sig: frameSignature(img) });
      img.close();
    }
    if (samples.length < 2) return;
    const scenes = buildScenes(samples, this.duration(), { minSec: 0 });
    this.chapters = scenes.map((s, i) => {
      const first = chapterSampleStart(samples, s);
      return {
        start: i === 0 ? 0 : (samples[first].t + samples[first - 1].t) / 2,
        end: s.end,
        precise: false,
        repTime: samples[s.rep].t,
        thumb: set.baseUri + '/' + samples[s.rep].t + '.' + set.extension,
      };
    });
    for (let i = 1; i < this.chapters.length; i++) this.chapters[i - 1].end = this.chapters[i].start;
    this.state = 'thumbnails';
    this.onChange();
  }

  fromThumbnails(set) {
    this.thumbsDone = this.fromThumbnailsAsync(set).catch((e) => { if (!this.ac.signal.aborted) log.warn('thumbnails:', e.message); });
  }

  async fromKeyframes(source, signal) {
    const reader = await new HlsVideoReader(source.v || source.av, 360).open(signal);
    this.reader = reader;
    if (this.thumbsDone) await this.thumbsDone;
    const n = reader.segments.length;
    const samples = [];
    if (store.get('debug', false)) this.samples = samples; // for tuning, development only
    const thumbs = new Map();
    let lastBuild = 0;
    let fails = 0;
    for (let i = 0; i < n; i++) {
      await this.gate.turn(300, 120, 20);
      let sig = null;
      let pic = null;
      // One segment that cannot be read (a missing keyframe, a failed request) does not end
      // the analysis: it counts as "same picture as before"; only several in a row do.
      try {
        await reader.keyframe(i, signal, (f) => { sig = frameSignature(f); pic = smallBitmap(f, CHAPTER_THUMB_W); });
        fails = 0;
      } catch (e) {
        if (signal.aborted) throw e;
        if (++fails >= ANALYSIS_MAX_FAILS) {
          if (samples.length) this.applyScenes(samples, thumbs, false);
          throw e;
        }
        log.warn('slide chapters: segment ' + i + ' skipped:', e);
      }
      const j = samples.length;
      if (!sig) {
        if (j) samples.push({ t: reader.segments[i].start, sig: samples[j - 1].sig, uniform: samples[j - 1].uniform });
        continue;
      }
      samples.push({ t: reader.segments[i].start, sig, uniform: frameUniform(sig) });
      // Keep a small picture only for the last frame of each run of identical frames.
      if (thumbs.has(j - 1) && sameView(samples[j - 1].sig, sig)) thumbs.delete(j - 1);
      thumbs.set(j, await bitmapToBlob(pic));
      this.progress = ((i + 1) / n) * 0.8;
      if (i - lastBuild >= 30) {
        lastBuild = i;
        // With per-minute chapters on screen, partial results would only show fewer.
        if (this.state !== 'thumbnails') this.applyScenes(samples, thumbs, false);
        else this.onChange();
      }
    }
    this.state = 'keyframes';
    this.uniform = uniformStretches(samples, this.duration());
    this.applyScenes(samples, thumbs, true);
    // Pin each change to about a second inside the segment where it happened.
    const chs = this.chapters;
    for (let c = 1; c < chs.length; c++) {
      const k = chs[c].firstSample;
      if (k <= 0) continue;
      await this.gate.turn(1000, 300, 30);
      const before = samples[k - 1].sig;
      let at = null;
      // A segment that cannot be read keeps the coarse (10 s) time.
      try {
        await reader.frames(reader.segmentAt(samples[k - 1].t), 1, signal, (f, t) => { if (at === null && !sameView(before, frameSignature(f))) at = t; });
      } catch (e) {
        if (signal.aborted) throw e;
        at = null;
      }
      // Seeking exactly to a frame's timestamp can still show the frame before it.
      if (at !== null) at = Math.round((at + 0.05) * 100) / 100;
      if (at !== null && at < chs[c].start) {
        chs[c].start = at;
        chs[c - 1].end = at;
      }
      chs[c].precise = true;
      this.progress = 0.8 + (c / chs.length) * 0.2;
      if (c % 5 === 0) this.onChange();
    }
    this.state = 'done';
    this.progress = 1;
    this.onChange();
  }

  applyScenes(samples, thumbs, final) {
    const total = final ? this.duration() : samples[samples.length - 1].t + 10;
    const scenes = buildScenes(samples, total);
    this.chapters = scenes.map((s) => {
      const first = chapterSampleStart(samples, s);
      let blob = null;
      // The newest picture of this scene that is still kept.
      for (let k = s.rep; k >= first && !blob; k--) blob = thumbs.get(k) || null;
      return { start: s.start, end: s.end, precise: false, repTime: samples[s.rep].t, firstSample: first, blob, thumb: blob ? this.thumbUrl(blob) : '' };
    });
    this.pruneThumbs();
    this.onChange();
  }

  save(key) {
    if (!this.lesson.mediaId || this.state !== 'done') return;
    idbCache.put(key, {
      used: Date.now(),
      v: cacheVersion('slides'),
      uniform: this.uniform,
      screen: this.screenIndex,
      at: Date.now(),
      chapters: this.chapters.map((c) => ({ start: c.start, end: c.end, precise: c.precise, repTime: c.repTime, blob: c.blob || null, thumb: c.blob ? '' : c.thumb })),
    });
  }
}

// Index of the first sample of a scene.
function chapterSampleStart(samples, scene) {
  let k = scene.rep;
  while (k > 0 && samples[k - 1].t >= scene.start) k--;
  return k;
}
