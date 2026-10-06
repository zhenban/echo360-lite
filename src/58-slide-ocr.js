// ===================================================================================
// Reading the text on the screen view, for following the lecturer's slides (M7.5).
//
// Runs only while the recording has slide files. Every 10 s HLS segment starts with a
// keyframe; the keyframes of the screen view are read at 720p (the smallest rendition at
// least that tall, or the tallest there is: text in 360p is not readable) and their text is
// recognised with Tesseract.js (pinned, from jsDelivr, loaded on first use).
//
// - A keyframe that looks like the previous one reuses its text: most of a lecture is the
//   same slide for many segments in a row. The comparison (at 160 x 90) uses the 360p
//   keyframe (about 20 KB); the 720p one (about 100 KB for a detailed screen) is only
//   downloaded where something changed.
// - Order: from the playback position onward; a seek starts again there; then the rest.
// - Pace: while playing, each reading is followed by a rest as long as it took (about half
//   of one core); while paused, readings follow each other. Downloads wait for the
//   playback buffer like all background work, and nothing runs with Data Saver on.
// - The texts are cached per recording (independent of the slide files) and a reading
//   continues where it stopped on the next visit.
//
// Cached record  ocr:<mediaId>  { v, screen, height, texts: [string], at: [text index per
// sample, -1 = not read, OCR_FAILED], stats }.
// For later features (M10 text recognition reuses the keyframes and their text):
//   reader.times[i], reader.texts, reader.at[i].
// ===================================================================================

const TESS_BASE = 'https://cdn.jsdelivr.net/npm/';
const TESS_FILES = {
  lib: 'tesseract.js@7.0.0/dist/tesseract.esm.min.js',
  worker: 'tesseract.js@7.0.0/dist/worker.min.js',
  core: 'tesseract.js-core@7.0.0',
  lang: '@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
};
const OCR_HEIGHT = 720;
const OCR_CMP_W = 160;
const OCR_CMP_H = 90;
const OCR_SAVE_EVERY = 10;     // readings between cache writes
const OCR_FAILED = -3;         // a sample whose keyframe could not be read

let tesseractPromise = null;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = import(TESS_BASE + TESS_FILES.lib).then((m) => m.default || m);
    tesseractPromise.catch(() => { tesseractPromise = null; });
  }
  return tesseractPromise;
}

// Brightness of a frame at 160 x 90.
function lumaThumb(g, img) {
  g.drawImage(img, 0, 0, OCR_CMP_W, OCR_CMP_H);
  const d = g.getImageData(0, 0, OCR_CMP_W, OCR_CMP_H).data;
  const out = new Uint8Array(OCR_CMP_W * OCR_CMP_H);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return out;
}

// Pixels of two 160 x 90 thumbnails whose brightness differs by more than OCR_PIXEL_DIFF.
// One pixel is an 8 x 8 block of a 720p frame: a word of slide text changes several of them
// by much more than that, while re-encoding the same picture changes them by a few levels.
const OCR_PIXEL_DIFF = 24;
function thumbChange(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > OCR_PIXEL_DIFF) n++;
  return n;
}

// The same text, if fewer pixels changed than a short word of text covers (about 3 x 6 at
// 160 x 90 for the smallest readable slide text): a mouse pointer, a blinking caret or the
// clock in a menu bar change fewer.
const OCR_SAME_MAX = 12;

class SlideTextReader {
  // opts: { lesson, video, source (the screen view), disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.source = opts.source;
    this.onChange = opts.onChange || (() => {});
    this.ac = new AbortController();
    opts.disposer.add(() => this.stop());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.reader = null;
    this.times = [];         // start of each sample (segment)
    this.texts = [];
    this.at = null;          // Int32Array: text index per sample, -1 = not read
    this.state = 'idle';     // idle | loading | reading | done | unavailable
    this.error = '';
    this.stats = { read: 0, same: 0, failed: 0, ms: 0, bytes: 0, wall: 0 };
    this.debug = store.get('debug', false) ? { changes: [] } : null;
    this.engine = null;
  }

  get key() { return 'ocr:' + this.lesson.mediaId + ':' + this.source.index; }

  done() {
    return this.at ? this.at.reduce((n, x) => n + (x !== -1 ? 1 : 0), 0) : 0;
  }

  progress() {
    return this.at && this.at.length ? this.done() / this.at.length : 0;
  }

  start() {
    this.run().catch((e) => {
      if (this.ac.signal.aborted) return;
      console.warn(TAG, 'slide text:', e && e.message ? e.message : e);
      this.state = 'unavailable';
      this.error = String((e && e.message) || e);
      this.onChange();
    });
  }

  stop() {
    this.ac.abort();
    if (this.engine) this.engine.then((w) => w.terminate()).catch(() => {});
    this.engine = null;
  }

  async run() {
    const signal = this.ac.signal;
    if (!HlsVideoReader.supported()) throw new Error('WebCodecs not available');
    if (navigator.connection && navigator.connection.saveData) throw new Error('Data Saver is on');
    this.state = 'loading';
    this.onChange();
    const url = this.source.v || this.source.av;
    this.reader = await new HlsVideoReader(url, Infinity, OCR_HEIGHT).open(signal);
    this.probe = await new HlsVideoReader(url, 360).open(signal);
    this.times = this.reader.segments.map((s) => s.start);
    if (this.probe.segments.length !== this.times.length) this.probe = this.reader;
    const n = this.times.length;
    const cached = this.lesson.mediaId ? await idbCache.get(this.key) : undefined;
    if (cached && cached.v === 1 && cached.height === this.reader.info.height && Array.isArray(cached.at) && cached.at.length === n) {
      this.texts = cached.texts;
      this.at = Int32Array.from(cached.at);
      Object.assign(this.stats, cached.stats || {});
    } else {
      this.at = new Int32Array(n).fill(-1);
    }
    if (this.done() === n) { this.state = 'done'; this.onChange(); return; }
    this.state = 'reading';
    this.onChange();
    const canvas = new OffscreenCanvas(this.reader.info.width, this.reader.info.height);
    const g = canvas.getContext('2d');
    const small = new OffscreenCanvas(OCR_CMP_W, OCR_CMP_H).getContext('2d', { willReadFrequently: true });
    // The previous sample of this pass, and the thumbnail of the last one whose text was
    // read: changes are measured against that, so that slow changes (ink added a little at
    // a time) still add up.
    let prev = -1;
    let ref = null;
    const bytes = () => this.reader.bytes + (this.probe !== this.reader ? this.probe.bytes : 0);
    let unsaved = 0;
    const t0 = performance.now();
    const wall0 = this.stats.wall;
    for (let i = this.next(); i >= 0; i = this.next()) {
      await this.gate.turn(200, 0, 20);
      let thumb = null;
      let full = false;
      const bytes0 = bytes();
      try {
        await this.probe.keyframe(i, signal, (f) => { thumb = lumaThumb(small, f); });
      } catch (e) {
        if (signal.aborted) throw e;
      }
      const change = thumb && prev === i - 1 && ref ? thumbChange(ref, thumb) : -1;
      const same = change >= 0 && change < OCR_SAME_MAX;
      if (this.debug) this.debug.changes[i] = change;
      if (thumb && !same) {
        try {
          await this.reader.keyframe(i, signal, (f) => { g.drawImage(f, 0, 0, canvas.width, canvas.height); full = true; });
        } catch (e) {
          if (signal.aborted) throw e;
        }
      }
      this.stats.bytes += bytes() - bytes0;
      if (!thumb || (!same && !full)) {
        this.at[i] = OCR_FAILED;
        this.stats.failed++;
        ref = null;
      } else if (same) {
        this.at[i] = this.at[i - 1];
        this.stats.same++;
      } else {
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const a = performance.now();
        const text = await this.recognize(blob);
        const ms = performance.now() - a;
        this.at[i] = this.addText(text);
        ref = thumb;
        this.stats.read++;
        this.stats.ms += Math.round(ms);
        // Half pace while playing: rest as long as the reading took.
        if (!this.video.paused) await this.gate.wait(ms);
      }
      prev = ref ? i : -1;
      this.stats.wall = wall0 + Math.round(performance.now() - t0);
      if (++unsaved >= OCR_SAVE_EVERY) { unsaved = 0; this.save(); }
      this.onChange();
    }
    this.state = 'done';
    this.save();
    this.onChange();
  }

  addText(text) {
    this.texts.push(text);
    return this.texts.length - 1;
  }

  // The next sample to read: the first unread one from the playback position on, else the
  // first unread one. -1 when all are read.
  next() {
    const at = this.at;
    const here = this.reader.segmentAt(this.video.currentTime || 0);
    for (let i = here; i < at.length; i++) if (at[i] === -1) return i;
    for (let i = 0; i < here; i++) if (at[i] === -1) return i;
    return -1;
  }

  async recognize(blob) {
    if (!this.engine) {
      this.engine = loadTesseract().then((T) => T.createWorker('eng', 1, {
        workerPath: TESS_BASE + TESS_FILES.worker,
        corePath: TESS_BASE + TESS_FILES.core,
        langPath: TESS_BASE + TESS_FILES.lang,
      }));
      this.engine.catch(() => { this.engine = null; });
    }
    const w = await this.engine;
    if (this.ac.signal.aborted) throw new Error('aborted');
    return String((await w.recognize(blob)).data.text || '');
  }

  save() {
    if (!this.lesson.mediaId || !this.at) return;
    idbCache.put(this.key, { v: 1, screen: this.source.index, height: this.reader.info.height, texts: this.texts, at: Array.from(this.at), stats: this.stats, savedAt: Date.now() });
  }
}
