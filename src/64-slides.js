// ===================================================================================
// Slide chapters: find where the screen view changes to a new slide.
//
// Sources, best first:
//   1. Chapter or slide data from Echo360 itself. None of the recordings checked so far had
//      any (cfg.chapters, slide decks and scenes were all empty), so this is not used yet.
//   2. Keyframes of the screen view. Every HLS segment starts with a keyframe; reading just
//      the start of a segment every CHAPTER_STEP_SEC (about 20 KB at 360p, 15 MB for two
//      hours) and decoding it with WebCodecs gives the whole lecture at that resolution.
//      Each change is then pinned to about 1 s by decoding the stretch it happened in.
//      Downloads only run while playback has enough buffer, and the result is cached in
//      IndexedDB.
//   3. Echo360's preview thumbnails (one per minute), when WebCodecs is not available.
//      They are also shown at once while the keyframes are being read.
//
// Which view is the screen: slides, code and documents have large flat areas, camera
// pictures do not (sensor noise), so the view with the most flat area is used.
//
// Change detection compares 160 x 90 brightness pictures. How large a change makes a new
// picture is learnt per recording from its own changes (see learnThreshold): ink, a pointer
// or scrolling code change fewer pixels than another slide, but how many fewer depends on
// the lecturer, the slides and the recording, so no fixed share is used. A run of quick
// changes (scrolling code, flicking through slides) becomes one chapter instead of many,
// and a short look elsewhere that comes back joins the chapter (see buildScenes).
//
// Reusable pieces:
//   HlsVideoReader   open(), segments, segmentAt(t), sampleSegments(step),
//                    keyframe(i) -> VideoFrame, frames(i, stepSec, onFrame)
//   lumaThumb(g, img), frameLuma(img), thumbChange(a, b), learnThreshold(changes)
//   buildScenes(samples, duration, opts) -> [{ start, end, rep, first }]
//   SlideAnalyzer    chapters: [{ start, end, precise, repTime, thumb }], screenIndex,
//                    lumaAt(t) (shared with the slide reader)
// ===================================================================================


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
  return parseMaster(master).variants.filter((x) => x.uri).map(({ attrs: a, uri }) => ({
    uri: new URL(uri, base).href, height: a.RESOLUTION ? +a.RESOLUTION.split('x')[1] : 0, bandwidth: +a.BANDWIDTH || 0,
  })).sort((x, y) => x.height - y.height || x.bandwidth - y.bandwidth);
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
    this.lastNeed = 0;       // bytes the last keyframe needed (header included)
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

  // Segments to sample about every stepSec seconds: [segment index] (the keyframe of each
  // segment is at its start).
  sampleSegments(stepSec) {
    const out = [];
    let next = -Infinity;
    this.segments.forEach((sg, i) => {
      if (sg.start + sg.dur / 2 < next) return;
      out.push(i);
      next = sg.start + stepSec;
    });
    return out;
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

  // First frame of segment i: fn(frame, seconds) is called once.
  async keyframe(i, signal, fn) {
    const s = this.segments[i];
    // Bytes from the start of the segment, fetching only what is still missing.
    let buf = new ArrayBuffer(0);
    const upTo = async (n) => {
      const want = Math.min(s.length, n);
      if (want <= buf.byteLength) return;
      const more = await fetchRange(s.url, s.offset + buf.byteLength, want - buf.byteLength, signal);
      this.bytes += more.byteLength;
      const all = new Uint8Array(buf.byteLength + more.byteLength);
      all.set(new Uint8Array(buf), 0);
      all.set(new Uint8Array(more), buf.byteLength);
      buf = all.buffer;
    };
    // The fragment header and the keyframe come first; their size is only known once the
    // header is read. Ask for a little more than the last keyframe needed (keyframes of one
    // stream are of similar size), the first time for just the start of the header, then
    // for whatever is still missing: a wrong guess costs a request, never a wrong result.
    await upTo(this.lastNeed ? Math.round(this.lastNeed * 1.25) : 4096);
    for (;;) {
      const boxes = mp4Boxes(new DataView(buf), 0, buf.byteLength);
      const moof = boxes.find((x) => x.type === 'moof');
      const last = boxes[boxes.length - 1];
      const end = moof ? moof.start + moof.size : last ? last.start + last.size + 8 : 8;
      if (end <= buf.byteLength || buf.byteLength >= s.length) break;
      await upTo(end);
    }
    const frag = parseFragment(buf, s.offset);
    const k = frag.samples[0];
    if (!k || !k.key) throw new Error('segment does not start with a keyframe');
    this.lastNeed = k.offset + k.size;
    await upTo(k.offset + k.size);
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
//
// Frames are compared as 160 x 90 brightness pictures (one pixel is a 2 x 2 block at 360p,
// 8 x 8 at 720p): fine enough that a changed line of slide text changes several pixels.


// Brightness of a frame at THUMB_W x THUMB_H, drawn with the 2D context g.
function lumaThumb(g, img) {
  g.drawImage(img, 0, 0, THUMB_W, THUMB_H);
  const d = g.getImageData(0, 0, THUMB_W, THUMB_H).data;
  const out = new Uint8Array(THUMB_W * THUMB_H);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return out;
}

let thumbCtx = null;
function thumbContext() {
  if (!thumbCtx) {
    const c = makeCanvas(THUMB_W, THUMB_H);
    thumbCtx = c.getContext('2d', { willReadFrequently: true });
  }
  return thumbCtx;
}

// Brightness picture of any drawable (VideoFrame, ImageBitmap, <video>, <img>).
function frameLuma(img) {
  return lumaThumb(thumbContext(), img);
}

// Pixels of two brightness pictures that differ by more than PIXEL_DIFF. Stops counting
// at `limit` (the caller only needs to know whether that many changed).
function thumbChange(a, b, limit) {
  const stop = limit || Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_DIFF && ++n >= stop) break;
  return n;
}

// Share of pixels (0-1) of two brightness pictures that changed a little: more than
// STILL_LEVELS (the same picture encoded again), at most PIXEL_DIFF (a real edge moving).
// Sensor noise and movement in a camera picture; next to nothing on a still screen.
function slightChange(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > STILL_LEVELS && d <= PIXEL_DIFF) n++;
  }
  return n / a.length;
}

// The change of each sample against the last earlier sample that differed visibly from the
// one before it (so that slow changes, ink added a little at a time, still add up), in
// changed pixels; 0 for the first. samples: [{ luma }], sets sample.change; only samples
// from `from` on are computed (earlier ones keep theirs).
function sampleChanges(samples, from) {
  let ref = null;
  for (let k = Math.max(0, (from || 0) - 1); k >= 0 && !ref; k--) if (k === 0 || samples[k].change >= SAME_TEXT_MAX) ref = samples[k].luma;
  for (let k = from || 0; k < samples.length; k++) {
    const s = samples[k];
    if (!ref) { s.change = 0; ref = s.luma; continue; }
    s.change = thumbChange(ref, s.luma);
    if (s.change >= SAME_TEXT_MAX) ref = s.luma;
  }
}

// How many changed pixels make a new picture, learnt from this recording: its visible
// changes (SAME_TEXT_MAX or more) split into two groups (small: ink, scrolling, a pointer;
// large: another slide or program) at the point that separates them best (Otsu's method,
// on the logarithm, since the sizes span orders of magnitude). Samples without a visible
// change are left out: they say nothing about the split and, being most of a lecture,
// would pull it down to ink level (checked on four lectures: the same changes found, a
// sixth to a quarter fewer false ones). With fewer than two different visible changes
// there is nothing to split, and every visible change counts as a new picture.
function learnThreshold(changes) {
  const v = changes.filter((c) => c >= SAME_TEXT_MAX).map((c) => Math.log1p(c)).sort((a, b) => a - b);
  const n = v.length;
  let total = 0;
  for (const x of v) total += x;
  let best = -1;
  let cut = Infinity;
  let left = 0;
  for (let i = 1; i < n; i++) {
    left += v[i - 1];
    if (v[i] === v[i - 1]) continue;
    const ma = left / i;
    const mb = (total - left) / (n - i);
    const score = i * (n - i) * (mb - ma) ** 2;
    if (score > best) { best = score; cut = (v[i - 1] + v[i]) / 2; }
  }
  return cut === Infinity ? SAME_TEXT_MAX : Math.expm1(cut);
}

// Mean brightness of 5 x 5 blocks: a 32 x 18 version of a brightness picture.
function lumaBlocks(luma) {
  const W = THUMB_W / 5;
  const H = THUMB_H / 5;
  const out = new Float32Array(W * H);
  for (let y = 0; y < THUMB_H; y++) for (let x = 0; x < THUMB_W; x++) out[((y / 5) | 0) * W + ((x / 5) | 0)] += luma[y * THUMB_W + x] / 25;
  return out;
}

// A picture of (almost) one colour: a black screen, a "no signal" picture, a blank slide in
// one colour. Judged by evenness, not darkness, so any kind of empty picture counts: nearly
// every block of a 32 x 18 version is within noise of the median brightness (UNIFORM_*).
function frameUniform(luma) {
  const l = lumaBlocks(luma);
  const n = l.length;
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
  const c = makeCanvas(W, H);
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
      if (Math.abs(l - d[i + 4] - d[i + 5] - d[i + 6]) <= FLAT_LEVELS && Math.abs(l - d[i + W * 4] - d[i + W * 4 + 1] - d[i + W * 4 + 2]) <= FLAT_LEVELS) n++;
    }
  }
  return n / tot;
}

// ---- scenes ----

// samples: [{ t, luma, change }] in time order (see sampleChanges). Returns scenes
// [{ start, end, rep }] where rep is the sample that best shows the chapter: the last sample
// (ink and builds are complete there) of the view it stays on longest. A scene starts at
// its first sample; refinement moves it earlier.
//
// opts.threshold: changed pixels that make a new picture (default: learnt from the samples).
// opts.single: merge chapters of a single sample (default true; off for samples a minute
// apart, where one sample is a long stretch).
//
// 1. Runs: a new run starts where a sample changed by the threshold or more.
// 2. A run that starts with a picture already shown in the current chapter (back to the
//    slide after a look at the editor) continues the chapter.
// 3. A look elsewhere between two stays on the same picture, no longer than either of them,
//    joins them into one chapter (a short demo, then back to the slide; flicking between a
//    slide and a question board).
// 4. A chapter of a single sample is shorter than the sampling can tell apart: several in a
//    row (flicking through slides, scrolling) are one chapter, a lone one (a transition
//    caught half way) joins the next.
// All lengths are relative to each other or to the sampling step: no fixed durations.
function buildScenes(samples, duration, opts) {
  const o = Object.assign({ single: true }, opts);
  if (!samples.length) return [];
  if (samples.some((s) => s.change == null)) sampleChanges(samples);
  const thr = o.threshold != null ? o.threshold : learnThreshold(samples.slice(1).map((s) => s.change));
  const tAt = (k) => (k < samples.length ? samples[k].t : duration);
  const same = (i, j) => thumbChange(samples[i].luma, samples[j].luma, thr) < thr;
  // 1. Runs of the same picture.
  const runs = [{ a: 0, b: 0 }];
  for (let k = 1; k < samples.length; k++) {
    if (samples[k].change < thr) runs[runs.length - 1].b = k;
    else runs.push({ a: k, b: k });
  }
  // A chapter's pictures: the first and last sample of each of its runs.
  const shows = (ch, k) => ch.runs.some((r) => same(r.a, k) || (r.b !== r.a && same(r.b, k)));
  const len = (ch) => tAt(ch.b + 1) - samples[ch.a].t;
  // 2. Chapters; a return within the current chapter continues it.
  let chs = [];
  for (const r of runs) {
    const cur = chs[chs.length - 1];
    if (cur && shows(cur, r.a)) { cur.b = r.b; cur.runs.push(r); } else chs.push({ a: r.a, b: r.b, runs: [r] });
  }
  // 3. Short looks elsewhere between two stays on the same picture.
  for (let i = 1; i + 1 < chs.length; i++) {
    const [x, y, z] = [chs[i - 1], chs[i], chs[i + 1]];
    if (len(y) <= len(x) && len(y) <= len(z) && shows(x, z.a)) {
      chs.splice(i - 1, 3, { a: x.a, b: z.b, runs: x.runs.concat(y.runs, z.runs) });
      i = Math.max(0, i - 2);
    }
  }
  // 4. Chapters of one sample.
  if (o.single) {
    const out = [];
    const one = (ch) => ch.a === ch.b;
    for (let i = 0; i < chs.length; i++) {
      const ch = { a: chs[i].a, b: chs[i].b, runs: chs[i].runs.slice() };
      const absorb = (x) => { ch.b = x.b; ch.runs.push(...x.runs); };
      if (one(ch)) {
        let j = i;
        while (j + 1 < chs.length && one(chs[j + 1])) j++;
        if (j > i) { for (let q = i + 1; q <= j; q++) absorb(chs[q]); i = j; } else if (i + 1 < chs.length) { absorb(chs[i + 1]); i++; }
      }
      out.push(ch);
    }
    chs = out;
  }
  return chs.map((ch, i) => {
    let best = ch.runs[0];
    for (const x of ch.runs) if (tAt(x.b + 1) - samples[x.a].t >= tAt(best.b + 1) - samples[best.a].t) best = x;
    return {
      start: i === 0 ? 0 : samples[ch.a].t,
      end: i + 1 < chs.length ? samples[chs[i + 1].a].t : duration,
      rep: best.b,
      first: ch.a,
    };
  });
}

// Index of the last of the ascending times that is at or before t (-1 if none).
function sampleIndexAt(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return k;
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

// A small copy of a frame, made synchronously (a VideoFrame is only valid in its callback),
// in the frame's own shape (a 4:3 screen stays 4:3).
function smallBitmap(img, w) {
  const iw = img.displayWidth || img.width || 16;
  const ih = img.displayHeight || img.height || 9;
  const c = new OffscreenCanvas(w, Math.max(1, Math.round((w * ih) / iw)));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function bitmapToBlob(canvas) {
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

// The screen among scored views [{ vals, ... }] (see findScreen): the one with the lowest
// (lowerIsScreen) or highest median; sure if every view was scored and the chosen one's
// values beat each other view's in SCREEN_CLEARLY of all pairs. { best, sure }.
function pickScreen(scored, lowerIsScreen, viewCount) {
  const median = (v) => { const a = v.slice().sort((x, y) => x - y); return (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2; };
  // Share of pairs in which a value of `a` is above one of `b` (ties count half).
  const above = (a, b) => {
    let w = 0;
    for (const x of a) for (const y of b) w += x > y ? 1 : x === y ? 0.5 : 0;
    return w / (a.length * b.length);
  };
  const order = scored.slice().sort((a, b) => (lowerIsScreen ? median(a.vals) - median(b.vals) : median(b.vals) - median(a.vals)));
  const best = order[0];
  const sure = order.length === viewCount && order.slice(1).every((o) => (lowerIsScreen ? above(o.vals, best.vals) : above(best.vals, o.vals)) >= SCREEN_CLEARLY);
  return { best, sure };
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
    /** @type {Chapter[]} */
    this.chapters = [];
    this.uniform = [];       // stretches where the screen shows (almost) one colour
    this.screenIndex = null;
    this.guessScreen = null;
    this.screenSure = true;     // false: the views did not differ clearly (the screen is a guess)
    this.manualScreen = null;   // the view the user chose, if any
    this.reader = null;
    this.urls = [];
    this.d.add(() => { for (const u of this.urls) URL.revokeObjectURL(u); this.urlOf = null; });
  }

  // Each run has its own signal and gate: a run replaced by chooseScreen stops at its next
  // step and never writes into the new one's results.
  start() {
    const signal = this.ac.signal;
    this.run(signal, this.gate).catch((e) => {
      if (signal.aborted) return;
      log.warn('slide detection stopped:', e && e.message ? e.message : e);
      if (!this.chapters.length) { this.state = 'unavailable'; this.onChange(); }
    });
  }

  duration() {
    return mediaDuration(this.video, this.lesson);
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

  async run(signal, gate) {
    this.reason = null;   // why the analysis is unavailable, if it says ('saveData')
    const key = 'slides:' + this.lesson.mediaId;
    const id = this.lesson.mediaId;
    const pick = id ? await idbCache.get('screenpick:' + id) : null;
    this.manualScreen = pick && this.lesson.sources.some((x) => x.index === pick.index) ? pick.index : null;
    const cached = id ? await idbCache.get(key) : undefined;
    if (signal.aborted) return;
    // A result for another view than the one chosen by hand is made again.
    if (cacheValid('slides', cached) && Array.isArray(cached.chapters) && (this.manualScreen == null || cached.screen === this.manualScreen)) {
      cacheTouch(key);
      this.uniform = Array.isArray(cached.uniform) ? cached.uniform : [];
      this.screenIndex = cached.screen;
      this.screenSure = cached.sure !== false;
      this.chapters = cached.chapters.map((c) => Object.assign({}, c, { thumb: c.blob ? this.thumbUrl(c.blob) : c.thumb }));
      this.state = 'done';
      this.progress = 1;
      this.onChange();
      return;
    }
    // Data Saver: no downloads at all (finding the screen view already reads keyframes or
    // preview pictures); only a stored result is used.
    if (saveDataOn()) { this.reason = 'saveData'; this.state = 'unavailable'; this.onChange(); return; }
    // Which view is the screen is needed early (quality settings are per view).
    const screen = await this.findScreen(signal);
    if (signal.aborted) return;
    if (!screen) { this.state = 'unavailable'; this.onChange(); return; }
    this.screenIndex = screen.source.index;
    this.screenSure = screen.sure;
    this.onChange();
    await gate.wait(BG_START_DELAY_MS); // let playback start first
    if (screen.thumbs) this.fromThumbnails(screen.thumbs, signal, gate);
    if (!HlsVideoReader.supported()) {
      if (this.chapters.length) { this.state = 'done'; this.progress = 1; this.onChange(); }
      return;
    }
    await this.fromKeyframes(screen.source, signal, gate, screen.reader);
    if (!signal.aborted) this.save(key);
  }

  // The user says which view is the screen (index), or leaves it to the analysis (null).
  // Kept per recording; the chapters are found again from that view.
  async chooseScreen(index) {
    const id = this.lesson.mediaId;
    if (id) {
      if (index == null) await idbCache.del('screenpick:' + id);
      else await idbCache.put('screenpick:' + id, { index });
    }
    // Confirming the view in use only remembers it.
    if (index != null && index === this.screenIndex) {
      this.manualScreen = index;
      this.screenSure = true;
      this.onChange();
      return;
    }
    this.ac.abort();
    this.ac = new AbortController();
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    if (this.lesson.mediaId) await idbCache.del('slides:' + this.lesson.mediaId);
    this.state = 'pending';
    this.progress = 0;
    this.chapters = [];
    this.uniform = [];
    this.thumbsDone = null;
    this.lumas = null;
    this.pruneThumbs();
    this.onChange();
    this.start();
  }

  // Which view is the screen: { source, thumbs (its preview set or null), sure, reader },
  // or null if no view can be read at all.
  // 1. The view the user chose for this recording.
  // 2. With one view, that view.
  // 3. How each view changes over time, from pairs of keyframes CHAPTER_STEP_SEC apart
  //    spread over the recording: a screen is still between changes (the same picture is
  //    encoded the same way, so nearly every pixel stays within STILL_LEVELS) and then
  //    changes in a step; a camera always changes a little everywhere (sensor noise, people
  //    moving). The share of slightly changed pixels per pair is lower for the screen on
  //    every recording checked (median about 0.2-11% against 12-35%, the highest screen
  //    value from a document camera). Echo360's data does not say which view is which.
  // 4. Without WebCodecs: the preview pictures' flat area (slides and documents are
  //    flatter than camera pictures; weaker, a busy screen can be less flat).
  // The most likely view is used even when the views do not differ clearly (sure = false):
  // a wrong guess shows wrong chapters that the user can fix by choosing the view, while
  // giving up would hide the feature. "Clearly" is SCREEN_CLEARLY: the chosen view's
  // values are below (or for flatness above) another view's in that share of pairs.
  async findScreen(signal) {
    const sources = this.lesson.sources;
    const setOf = (src) => (this.lesson.thumbnails || []).find((x) => x.sourceIndex === src.index && Array.isArray(x.timesInSeconds) && x.timesInSeconds.length) || null;
    if (this.manualScreen != null) {
      const src = sources.find((x) => x.index === this.manualScreen);
      this.guessScreen = src.index;
      return { source: src, thumbs: setOf(src), sure: true, reader: null };
    }
    if (sources.length === 1) { this.guessScreen = sources[0].index; return { source: sources[0], thumbs: setOf(sources[0]), sure: true, reader: null }; }
    const decide = (scored, lowerIsScreen) => {
      const r = pickScreen(scored, lowerIsScreen, sources.length);
      this.guessScreen = r.best.source.index;
      return { source: r.best.source, thumbs: setOf(r.best.source), sure: r.sure, reader: r.best.reader || null };
    };
    if (HlsVideoReader.supported()) {
      const scored = [];
      for (const src of sources) {
        const vals = [];
        let rd = null;
        try {
          rd = await new HlsVideoReader(src.v || src.av, 360).open(signal);
          const picks = rd.sampleSegments(CHAPTER_STEP_SEC);
          for (let k = 0; k < SCREEN_PROBES && picks.length > 1; k++) {
            const q = Math.floor(((k + 0.5) * (picks.length - 1)) / SCREEN_PROBES);
            let a = null;
            let b = null;
            try {
              await rd.keyframe(picks[q], signal, (f) => { a = frameLuma(f); });
              await rd.keyframe(picks[q + 1], signal, (f) => { b = frameLuma(f); });
            } catch (e) { if (signal.aborted) throw e; continue; }
            vals.push(slightChange(a, b));
          }
        } catch (e) { if (signal.aborted) throw e; }
        if (vals.length >= SCREEN_PROBES / 2) scored.push({ source: src, vals, reader: rd });
      }
      if (scored.length) return decide(scored, true);
    }
    const scored = [];
    for (const src of sources) {
      const set = setOf(src);
      if (!set) continue;
      const ts = set.timesInSeconds;
      const vals = [];
      for (let k = 0; k < SCREEN_PROBES; k++) {
        // One picture that cannot be read does not decide anything.
        let img = null;
        try { img = await this.loadThumb(set, ts[Math.floor(((k + 0.5) * ts.length) / SCREEN_PROBES)], signal); } catch (e) { if (signal.aborted) throw e; }
        if (!img) continue;
        vals.push(flatShare(img));
        img.close();
      }
      if (vals.length >= SCREEN_PROBES / 2) scored.push({ source: src, vals });
    }
    return scored.length ? decide(scored, false) : null;
  }

  async loadThumb(set, t, signal) {
    const url = thumbUrlOf(set, t);
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
  async fromThumbnailsAsync(set, signal, gate) {
    const samples = [];
    let fails = 0;
    for (const t of set.timesInSeconds) {
      await gate.wait(0);
      // A preview picture that cannot be read is left out.
      let img = null;
      try { img = await this.loadThumb(set, t, signal); fails = 0; } catch (e) {
        if (signal.aborted || ++fails >= ANALYSIS_MAX_FAILS) throw e;
        continue;
      }
      samples.push({ t, luma: frameLuma(img) });
      img.close();
    }
    if (samples.length < 2 || signal.aborted) return;
    const scenes = buildScenes(samples, this.duration(), { single: false });
    this.chapters = scenes.map((sc, i) => ({
      start: i === 0 ? 0 : (samples[sc.first].t + samples[sc.first - 1].t) / 2,
      end: sc.end,
      precise: false,
      repTime: samples[sc.rep].t,
      thumb: thumbUrlOf(set, samples[sc.rep].t),
    }));
    for (let i = 1; i < this.chapters.length; i++) this.chapters[i - 1].end = this.chapters[i].start;
    this.state = 'thumbnails';
    this.onChange();
  }

  fromThumbnails(set, signal, gate) {
    this.thumbsDone = this.fromThumbnailsAsync(set, signal, gate).catch((e) => { if (!signal.aborted) log.warn('thumbnails:', e.message); });
  }

  // The 360p brightness picture of the screen view at sample time t, while the scan keeps
  // them (see shareLumas), else null. The slide reader compares the same pictures; sharing
  // saves downloading them twice.
  lumaAt(t) {
    return (this.lumas && this.lumas.get(Math.round(t * 10))) || null;
  }

  // The slide reader of `source` wants the pictures (true) or no longer does (false). They
  // are kept while either the scan runs or a reader of the scanned view uses them.
  shareLumas(on, source) {
    this.sharing = !!on && !!source && source.index === this.screenIndex;
    if (!this.sharing && this.state === 'done') this.lumas = null;
    return this.sharing;
  }

  async fromKeyframes(source, signal, gate, opened) {
    const reader = opened || await new HlsVideoReader(source.v || source.av, 360).open(signal);
    if (this.thumbsDone) await this.thumbsDone;
    if (signal.aborted) return;
    this.reader = reader;   // read by the development tools (dev/chap-run.mjs)
    const picks = reader.sampleSegments(CHAPTER_STEP_SEC);
    const n = picks.length;
    const samples = [];
    const lumas = new Map();
    this.lumas = lumas;
    if (store.get('debug', false)) this.samples = samples; // for tuning, development only
    const thumbs = new Map();
    let lastBuild = 0;
    let fails = 0;
    for (let q = 0; q < n; q++) {
      const i = picks[q];
      await gate.turn(CHAPTER_PACE_MS[0], CHAPTER_PACE_MS[1], BG_MIN_BUFFER_SEC);
      let luma = null;
      let pic = null;
      // One segment that cannot be read (a missing keyframe, a failed request) does not end
      // the analysis: it counts as "same picture as before"; only several in a row do.
      try {
        await reader.keyframe(i, signal, (f) => { luma = frameLuma(f); pic = smallBitmap(f, CHAPTER_THUMB_W); });
        fails = 0;
      } catch (e) {
        if (signal.aborted) throw e;
        if (++fails >= ANALYSIS_MAX_FAILS) {
          if (samples.length) this.applyScenes(samples, thumbs, reader.segments[i].start);
          throw e;
        }
        log.warn('slide chapters: segment ' + i + ' skipped:', e);
      }
      const j = samples.length;
      const t = reader.segments[i].start;
      if (!luma) {
        if (j) samples.push({ t, luma: samples[j - 1].luma, uniform: samples[j - 1].uniform, change: 0 });
        continue;
      }
      samples.push({ t, luma, uniform: frameUniform(luma) });
      lumas.set(Math.round(t * 10), luma);
      sampleChanges(samples, j);
      // Keep a small picture only for the last frame of each run of the same picture.
      if (thumbs.has(j - 1) && samples[j].change < SAME_TEXT_MAX) thumbs.delete(j - 1);
      thumbs.set(j, await bitmapToBlob(pic));
      if (signal.aborted) return;
      this.progress = ((q + 1) / n) * 0.8;
      if (q - lastBuild >= 30) {
        lastBuild = q;
        // With per-minute chapters on screen, partial results would only show fewer.
        if (this.state !== 'thumbnails') this.applyScenes(samples, thumbs, q + 1 < n ? reader.segments[picks[q + 1]].start : this.duration());
        else this.onChange();
      }
    }
    this.state = 'keyframes';
    this.uniform = uniformStretches(samples, this.duration());
    const thr = this.applyScenes(samples, thumbs, this.duration());
    // Pin each change to about a second: the first frame between the last sample before it
    // and the first one after it that differs from the one before as much as a new picture.
    const chs = this.chapters;
    const g = thumbContext();
    for (let c = 1; c < chs.length; c++) {
      const k = chs[c].firstSample;
      if (k <= 0) continue;
      await gate.turn(CHAPTER_REFINE_PACE_MS[0], CHAPTER_REFINE_PACE_MS[1], STREAM_MAX_BUFFER_SEC);
      const before = samples[k - 1].luma;
      /** @type {number | null} */
      let at = null;
      // A segment that cannot be read keeps the coarse time.
      try {
        for (let i = reader.segmentAt(samples[k - 1].t); at === null && i < reader.segments.length && reader.segments[i].start < samples[k].t; i++) {
          await reader.frames(i, 1, signal, (f, ft) => { if (at === null && thumbChange(before, lumaThumb(g, f), thr) >= thr) at = ft; });
        }
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
    if (!this.sharing) this.lumas = null;
    this.progress = 1;
    this.onChange();
  }

  // Chapters from the samples so far (end: when the last one ends). Returns the threshold
  // used.
  applyScenes(samples, thumbs, end) {
    const thr = learnThreshold(samples.slice(1).map((x) => x.change));
    const scenes = buildScenes(samples, end, { threshold: thr });
    this.chapters = scenes.map((sc) => {
      let blob = null;
      // The newest picture of this scene that is still kept.
      for (let k = sc.rep; k >= sc.first && !blob; k--) blob = thumbs.get(k) || null;
      return { start: sc.start, end: sc.end, precise: false, repTime: samples[sc.rep].t, firstSample: sc.first, blob, thumb: blob ? this.thumbUrl(blob) : '' };
    });
    this.threshold = thr;
    this.pruneThumbs();
    this.onChange();
    return thr;
  }

  save(key) {
    if (!this.lesson.mediaId || this.state !== 'done') return;
    idbCache.put(key, {
      used: Date.now(),
      v: cacheVersion('slides'),
      uniform: this.uniform,
      screen: this.screenIndex,
      sure: this.screenSure !== false,
      at: Date.now(),
      chapters: this.chapters.map((c) => ({ start: c.start, end: c.end, precise: c.precise, repTime: c.repTime, blob: c.blob || null, thumb: c.blob ? '' : c.thumb })),
    });
  }
}
