// ===================================================================================
// Reading the text on the screen view, for following the lecturer's slides (M7.5).
//
// Runs only while the recording has slide files. Every HLS segment starts with a keyframe;
// one keyframe every CHAPTER_STEP_SEC of the screen view is read at 720p (the smallest rendition at
// least that tall, or the tallest there is: text in 360p is not readable) and their text is
// recognised with Tesseract.js (pinned, from jsDelivr, loaded on first use).
//
// - A keyframe that looks like the previous one reuses its text: most of a lecture is the
//   same slide for many samples in a row. The comparison (at 160 x 90, see thumbChange)
//   uses the 360p keyframe (about 20 KB), taken from the slide analysis when it has it;
//   the 720p one (about 100 KB for a detailed screen) is only downloaded where something
//   changed.
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
// Language: chosen from the slide files' text (ocrLanguage); English data is about 3 MB,
// other languages 0.6 to 2.7 MB; each is downloaded when first needed (Tesseract.js then
// keeps it in the browser's storage), and the slides tab says which and how large while
// it loads.
// ===================================================================================

const TESS_BASE = 'https://cdn.jsdelivr.net/npm/';
const TESS_FILES = {
  lib: 'tesseract.js@7.0.0/dist/tesseract.esm.min.js',
  worker: 'tesseract.js@7.0.0/dist/worker.min.js',
  core: 'tesseract.js-core@7.0.0',
};
// Language data (pinned, from jsDelivr, 4.0.0_best_int): the scripts each one reads (the
// non-Latin ones read Latin letters too, for the English terms on such slides), the size
// of its download, and the language tag for its name. One language per engine: Tesseract.js
// loads every language of an engine from one place, and each is its own package.
const TESS_LANGS = {
  eng: { scripts: ['Latin'], bytes: 2952873, tag: 'en' },
  chi_sim: { scripts: ['Han', 'Latin'], bytes: 1718768, tag: 'zh-Hans' },
  chi_tra: { scripts: ['Han', 'Latin'], bytes: 1656239, tag: 'zh-Hant' },
  jpn: { scripts: ['Han', 'Latin'], bytes: 2030256, tag: 'ja' },
  kor: { scripts: ['Hangul', 'Latin'], bytes: 1572336, tag: 'ko' },
  rus: { scripts: ['Cyrillic', 'Latin'], bytes: 2679598, tag: 'ru' },
  ell: { scripts: ['Greek', 'Latin'], bytes: 1324749, tag: 'el' },
  ara: { scripts: ['Arabic', 'Latin'], bytes: 1661906, tag: 'ar' },
  heb: { scripts: ['Hebrew', 'Latin'], bytes: 580576, tag: 'he' },
  tha: { scripts: ['Thai', 'Latin'], bytes: 896631, tag: 'th' },
  hin: { scripts: ['Devanagari', 'Latin'], bytes: 1389692, tag: 'hi' },
};
const TESS_LANG_PATH = (lang) => TESS_BASE + '@tesseract.js-data/' + lang + '@1.0.0/4.0.0_best_int';

// Characters written differently in simplified and traditional Chinese (common ones, in
// matching order), to tell the two apart.
const HANS_ONLY = '\u8fd9\u4eec\u4e2a\u65f6\u6765\u4e3a\u8bf4\u56fd\u8fc7\u53d1\u540e\u4f1a\u5bf9\u5b66\u52a8\u5b9e\u73b0\u70b9\u7ecf\u5173\u5e94\u8fdb\u79cd\u673a\u6570\u636e\u53d8\u8ba1\u7535\u538b\u7ea7\u4ea7\u7ebf\u56fe\u5f53\u8fd8\u65e0\u4e48\u95ee\u9898\u957f\u95f4\u89c1';
const HANT_ONLY = '\u9019\u5011\u500b\u6642\u4f86\u70ba\u8aaa\u570b\u904e\u767c\u5f8c\u6703\u5c0d\u5b78\u52d5\u5be6\u73fe\u9ede\u7d93\u95dc\u61c9\u9032\u7a2e\u6a5f\u6578\u64da\u8b8a\u8a08\u96fb\u58d3\u7d1a\u7522\u7dda\u5716\u7576\u9084\u7121\u9ebc\u554f\u984c\u9577\u9593\u898b';

// The language to read the screen in, from the text of the slide files: the script most of
// their words are in (a Chinese or Japanese character counts as a word), English for Latin
// and for scripts without language data here. Japanese if a tenth or more of the Chinese
// characters are kana (Japanese prose is about a third or more kana, Chinese has none);
// simplified or traditional Chinese by which characters it uses.
function ocrLanguage(pageTexts) {
  const words = {};
  let kana = 0;
  let hans = 0;
  let hant = 0;
  for (const text of pageTexts) {
    for (const [w] of String(text || '').normalize('NFKC').matchAll(WORD_RE)) {
      if (/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u.test(w)) {
        words.Han = (words.Han || 0) + w.length;
        for (const ch of w) {
          if (/[\p{sc=Hiragana}\p{sc=Katakana}]/u.test(ch)) kana++;
          else if (HANS_ONLY.includes(ch) && !HANT_ONLY.includes(ch)) hans++;
          else if (HANT_ONLY.includes(ch) && !HANS_ONLY.includes(ch)) hant++;
        }
        continue;
      }
      const sc = WORD_SCRIPTS.find((x) => new RegExp('^\\p{sc=' + x + '}', 'u').test(w));
      if (sc) words[sc] = (words[sc] || 0) + 1;
    }
  }
  let top = 'Latin';
  for (const k of Object.keys(words)) if (words[k] > (words[top] || 0)) top = k;
  if (top === 'Han') return kana >= 0.1 * words.Han ? 'jpn' : hant > hans ? 'chi_tra' : 'chi_sim';
  return Object.keys(TESS_LANGS).find((l) => l !== 'eng' && TESS_LANGS[l].scripts[0] === top) || 'eng';
}

// The name of a language for messages ("Chinese (Simplified)"), in the page's language.
function languageName(lang) {
  const tag = (TESS_LANGS[lang] || TESS_LANGS.eng).tag;
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(tag) || tag; } catch (e) { return tag; }
}

const OCR_FAILED = -3;         // a sample whose keyframe could not be read

let tesseractPromise = null;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = import(TESS_BASE + TESS_FILES.lib).then((m) => m.default || m);
    tesseractPromise.catch(() => { tesseractPromise = null; });
  }
  return tesseractPromise;
}

class SlideTextReader {
  // opts: { lesson, video, source (the screen view), disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.source = opts.source;
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('slide reader (display)', e); } };
    this.ac = new AbortController();
    opts.disposer.add(() => this.stop());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.reader = null;
    this.times = [];         // start of each sample
    this.picks = [];         // segment of each sample
    this.end = 0;            // end of the recording (of the last sample)
    this.texts = [];
    this.at = null;          // Int32Array: text index per sample, -1 = not read
    this.state = 'idle';     // idle | loading | reading | done | unavailable
    this.error = '';
    this.stats = { read: 0, same: 0, failed: 0, ms: 0, bytes: 0, wall: 0 };
    this.debug = store.get('debug', false) ? { changes: [] } : null;
    this.engine = null;
    this.shared = opts.shared || null;   // the slide analysis, if it shares its pictures
    this.lang = TESS_LANGS[opts.lang] ? opts.lang : 'eng';
    this.engineReady = false;
  }

  // The scripts this reader can read (for matching words, see slideWords).
  get scripts() { return TESS_LANGS[this.lang].scripts; }

  get key() { return 'ocr:' + this.lesson.mediaId + ':' + this.source.index + (this.lang === 'eng' ? '' : ':' + this.lang); }

  done() {
    return this.at ? this.at.reduce((n, x) => n + (x !== -1 ? 1 : 0), 0) : 0;
  }

  progress() {
    return this.at && this.at.length ? this.done() / this.at.length : 0;
  }

  start() {
    this.run().catch((e) => {
      if (this.ac.signal.aborted) return;
      log.warn('slide text:', e && e.message ? e.message : e);
      this.state = 'unavailable';
      this.error = String((e && e.message) || e);
      this.onChange();
    });
  }

  stop() {
    this.ac.abort();
    if (this.shared) this.shared.shareLumas(false);
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
    this.picks = this.reader.sampleSegments(CHAPTER_STEP_SEC);
    this.times = this.picks.map((i) => this.reader.segments[i].start);
    this.end = this.reader.duration;
    // The 360p keyframe of each sample: the probe's segment starting at the same time, or
    // the 720p one itself if the renditions are cut differently.
    this.probePicks = this.times.map((t) => this.probe.segmentAt(t + 0.01));
    if (this.probePicks.some((k, q) => Math.abs(this.probe.segments[k].start - this.times[q]) > 0.05)) { this.probe = this.reader; this.probePicks = this.picks; }
    const lumaOf = this.shared && this.shared.shareLumas(true, this.source) ? (t) => this.shared.lumaAt(t) : () => null;
    const n = this.times.length;
    const cached = this.lesson.mediaId ? await idbCache.get(this.key) : undefined;
    if (cacheValid('ocr', cached) && cached.height === this.reader.info.height && Array.isArray(cached.at) && cached.at.length === n) {
      cacheTouch(this.key);
      this.texts = cached.texts;
      this.at = Int32Array.from(cached.at);
      Object.assign(this.stats, cached.stats || {});
    } else {
      this.at = new Int32Array(n).fill(-1);
    }
    if (this.done() === n) { this.state = 'done'; if (this.shared) this.shared.shareLumas(false); this.onChange(); return; }
    this.state = 'reading';
    this.onChange();
    const canvas = new OffscreenCanvas(this.reader.info.width, this.reader.info.height);
    const g = canvas.getContext('2d');
    const small = new OffscreenCanvas(THUMB_W, THUMB_H).getContext('2d', { willReadFrequently: true });
    // The previous sample of this pass, and the thumbnail of the last one whose text was
    // read: changes are measured against that, so that slow changes (ink added a little at
    // a time) still add up.
    let prev = -1;
    let ref = null;
    const bytes = () => this.reader.bytes + (this.probe !== this.reader ? this.probe.bytes : 0);
    let unsaved = 0;
    let fails = 0;
    const t0 = performance.now();
    const wall0 = this.stats.wall;
    for (let i = this.next(); i >= 0; i = this.next()) {
      await this.gate.turn(OCR_PACE_MS[0], OCR_PACE_MS[1], BG_MIN_BUFFER_SEC);
      let thumb = lumaOf(this.times[i]);
      let full = false;
      const bytes0 = bytes();
      if (!thumb) {
        try {
          await this.probe.keyframe(this.probePicks[i], signal, (f) => { thumb = lumaThumb(small, f); });
        } catch (e) {
          if (signal.aborted) throw e;
        }
      }
      const change = thumb && prev === i - 1 && ref ? thumbChange(ref, thumb) : -1;
      const same = change >= 0 && change < SAME_TEXT_MAX;
      if (this.debug) this.debug.changes[i] = change;
      if (thumb && !same) {
        try {
          await this.reader.keyframe(this.picks[i], signal, (f) => { g.drawImage(f, 0, 0, canvas.width, canvas.height); full = true; });
        } catch (e) {
          if (signal.aborted) throw e;
        }
      }
      this.stats.bytes += bytes() - bytes0;
      if (!thumb || (!same && !full)) {
        this.at[i] = OCR_FAILED;
        this.stats.failed++;
        ref = null;
        // Several in a row (network gone): stop and keep what was read; the next visit
        // continues, retrying these.
        if (++fails >= ANALYSIS_MAX_FAILS) { this.save(); throw new Error('keyframes cannot be read'); }
      } else if (same) {
        fails = 0;
        this.at[i] = this.at[i - 1];
        this.stats.same++;
      } else {
        fails = 0;
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
    if (this.shared) this.shared.shareLumas(false);
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
    const here = Math.max(0, sampleIndexAt(this.times, this.video.currentTime || 0));
    for (let i = here; i < at.length; i++) if (at[i] === -1) return i;
    for (let i = 0; i < here; i++) if (at[i] === -1) return i;
    return -1;
  }

  async recognize(blob) {
    // Never start the engine (a Worker with tens of MB of WASM and language data) once
    // reading has been stopped; one that finishes starting after a stop is ended at once.
    if (this.ac.signal.aborted) throw new Error('aborted');
    if (!this.engine) {
      const signal = this.ac.signal;
      this.engine = loadTesseract().then((T) => T.createWorker(this.lang, 1, {
        workerPath: TESS_BASE + TESS_FILES.worker,
        corePath: TESS_BASE + TESS_FILES.core,
        langPath: TESS_LANG_PATH(this.lang),
      })).then((w) => {
        if (signal.aborted) { w.terminate(); throw new Error('aborted'); }
        this.engineReady = true;
        this.onChange();
        return w;
      });
      this.engine.catch(() => { this.engine = null; });
    }
    const w = await this.engine;
    if (this.ac.signal.aborted) throw new Error('aborted');
    return String((await w.recognize(blob)).data.text || '');
  }

  save() {
    if (!this.lesson.mediaId || !this.at) return;
    // Samples that could not be read are stored as unread, so the next visit tries them again.
    const at = Array.from(this.at, (x) => (x === OCR_FAILED ? -1 : x));
    idbCache.put(this.key, { v: cacheVersion('ocr'), used: Date.now(), screen: this.source.index, height: this.reader.info.height, texts: this.texts, at, stats: this.stats, savedAt: Date.now() });
  }
}
