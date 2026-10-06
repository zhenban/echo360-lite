// ===================================================================================
// The lecturer's slide files (PDF) for a recording: loading, local storage, matching the
// chapters to pages, following the lecture, and the user's corrections.
//
// The PDF is the user's: they can page through it freely and remove it at any time.
// Following the lecture only turns the page for them until they take over.
//
// Files never leave the browser: they are kept in IndexedDB (by SHA-256), remembered per
// recording. pdf.js is loaded from jsDelivr (pinned) only when a recording has slide files.
//
// Stored records:
//   deck:<mediaId>        { files: [{ hash, name }], overrides: { <chapter key>: <page key> | 'none' } }
//   deckfile:<hash>       Blob of the PDF
//   deckref:<hash>        [mediaId] recordings using the file (deleted with the last one)
//   deckmatch:<mediaId>   { sig, chapters: [<page key> | null] } (matching result)
// A chapter key is its start in tenths of a second; a page key is "<hash prefix>:<page>",
// so both survive reordering files.
//
// For later features (slide text as vocabulary for transcription, chapter titles):
// controller.pages[i] = { key, file, num, title, text }.
// ===================================================================================

const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/';
const FOLLOW_MIN_SEC = 15;     // a chapter shorter than this does not turn the page
const FOLLOW_GUESS_SPAN = 3;   // unsure pages are used only between known pages this close
const FOLLOW_STALE_SEC = 120;  // after this long without a recognised page, say so
const DECK_RENDER_CACHE = 6;   // rendered pages kept

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_BASE + 'pdf.min.mjs').then((lib) => {
      // A module worker from a blob that imports the pinned worker script: a cross-origin
      // worker URL cannot be used directly.
      const url = URL.createObjectURL(new Blob(['import "' + PDFJS_BASE + 'pdf.worker.min.mjs";'], { type: 'text/javascript' }));
      lib.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
      return lib;
    });
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The page's title: the largest text in the top 40% of the page.
function pageTitle(items, pageHeight) {
  let size = 0;
  for (const it of items) if (it.str.trim() && it.transform[5] > pageHeight * 0.6) size = Math.max(size, it.height);
  if (!size) return '';
  return items.filter((it) => it.str.trim() && it.transform[5] > pageHeight * 0.6 && Math.abs(it.height - size) < 1)
    .map((it) => it.str.trim()).join(' ').replace(/\s+/g, ' ').slice(0, 120);
}

function renderPdfPage(page, width) {
  const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const c = document.createElement('canvas');
  c.width = Math.round(width);
  c.height = Math.round(vp.height);
  return page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise.then(() => c);
}

// The page to show for each chapter while following the lecture. known[i] is the page of
// chapter i (index, or -1 when unknown or not a slide); guesses[i] the best-looking page
// even when unsure (or -1). An unknown chapter shows its guess only if the known pages
// before and after it are at most FOLLOW_GUESS_SPAN apart and the guess lies between
// them (so a wrong guess cannot be far off); otherwise it keeps the last page shown.
// Chapters shorter than minSec do not turn the page (a quick look back). Before the first
// known page, that page is shown. Returns page indexes (-1 only if nothing is known).
function followPages(chapters, known, guesses, minSec) {
  const min = minSec == null ? FOLLOW_MIN_SEC : minSec;
  const n = chapters.length;
  const prev = new Array(n);
  const next = new Array(n);
  let last = -1;
  for (let i = 0; i < n; i++) { prev[i] = last; if (known[i] >= 0) last = known[i]; }
  last = -1;
  for (let i = n - 1; i >= 0; i--) { next[i] = last; if (known[i] >= 0) last = known[i]; }
  const first = known.find((p) => p >= 0);
  let cur = first === undefined ? -1 : first;
  return chapters.map((c, i) => {
    let p = known[i];
    const g = guesses ? guesses[i] : -1;
    const lo = Math.min(prev[i], next[i]);
    const hi = Math.max(prev[i], next[i]);
    if (p < 0 && g >= 0 && lo >= 0 && hi - lo <= FOLLOW_GUESS_SPAN && g >= lo && g <= hi) p = g;
    if (p >= 0 && p !== cur && c.end - c.start >= min) cur = p;
    return cur;
  });
}

class SlideDeckController {
  // opts: { lesson, slides (SlideAnalyzer), cues: () => cues, disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.slides = opts.slides;
    this.cues = opts.cues;
    this.onChange = opts.onChange || (() => {});
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.files = [];          // [{ hash, name }]
    this.docs = [];           // pdf.js loading tasks of the open documents, per file
    this.pages = [];          // [{ key, file, num, title, text, doc, h }]
    this.overrides = {};
    this.matched = null;      // [page key | null] per chapter, from matching
    this.guesses = [];        // [page key | null] per chapter: best-looking page, even if unsure
    this.shown = [];          // page index to show per chapter (following)
    this.state = 'empty';     // empty | loading | matching | ready | error
    this.progress = 0;
    this.error = '';
    this.job = null;
    this.rendered = new Map(); // "index@width" -> canvas
    this.d.add(() => this.closeDocs());
  }

  get key() { return 'deck:' + this.lesson.mediaId; }

  // Closes the open documents (through their loading tasks, which own them in pdf.js).
  closeDocs() {
    for (const task of this.docs) task.destroy().catch(() => {});
    this.docs = [];
    this.rendered.clear();
  }

  async restore() {
    if (!this.lesson.mediaId) return;
    const rec = await idbCache.get(this.key);
    if (!rec || !Array.isArray(rec.files) || !rec.files.length) return;
    this.files = rec.files;
    this.overrides = rec.overrides || {};
    await this.reload();
  }

  saveRecord() {
    if (this.lesson.mediaId) idbCache.put(this.key, { files: this.files, overrides: this.overrides });
  }

  // Adds PDF files (from a drop or a file picker). Returns how many were PDFs.
  async addFiles(fileList) {
    const pdfs = [...fileList].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) return 0;
    for (const f of pdfs) {
      const buf = await f.arrayBuffer();
      const hash = await sha256Hex(buf);
      if (this.files.some((x) => x.hash === hash)) continue;
      await idbCache.put('deckfile:' + hash, new Blob([buf], { type: 'application/pdf' }));
      const refs = (await idbCache.get('deckref:' + hash)) || [];
      if (!refs.includes(this.lesson.mediaId)) await idbCache.put('deckref:' + hash, refs.concat(this.lesson.mediaId));
      this.files.push({ hash, name: f.name });
    }
    this.saveRecord();
    await this.reload();
    return pdfs.length;
  }

  async removeFile(hash) {
    this.files = this.files.filter((f) => f.hash !== hash);
    const prefix = hash.slice(0, 12) + ':';
    for (const k of Object.keys(this.overrides)) if (String(this.overrides[k]).startsWith(prefix)) delete this.overrides[k];
    this.saveRecord();
    // The file itself is deleted when no other recording uses it.
    const refs = ((await idbCache.get('deckref:' + hash)) || []).filter((m) => m !== this.lesson.mediaId);
    if (refs.length) await idbCache.put('deckref:' + hash, refs);
    else { await idbCache.del('deckref:' + hash); await idbCache.del('deckfile:' + hash); }
    await this.reload();
  }

  // Opens all files, reads the pages' titles and text, then matches the chapters.
  async reload() {
    const job = {};
    this.job = job;
    this.closeDocs();
    this.pages = [];
    this.matched = null;
    this.shown = [];
    if (!this.files.length) { this.state = 'empty'; this.onChange(); return; }
    this.state = 'loading';
    this.onChange();
    try {
      const lib = await loadPdfJs();
      const pages = [];
      for (const f of this.files) {
        const blob = await idbCache.get('deckfile:' + f.hash);
        if (!blob) continue;
        const task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
        const doc = await task.promise;
        if (this.job !== job) { task.destroy().catch(() => {}); return; }
        this.docs.push(task);
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const tc = await page.getTextContent();
          const [x0, y0, x1, y1] = page.view;
          pages.push({
            key: f.hash.slice(0, 12) + ':' + n, file: f.name, num: n, doc, ar: (y1 - y0) / (x1 - x0),
            title: pageTitle(tc.items, y1 - y0),
            text: tc.items.map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim(),
          });
        }
      }
      if (this.job !== job) return;
      this.pages = pages;
      this.recompute();
      await this.match(job);
    } catch (e) {
      if (this.ac.signal.aborted || this.job !== job) return;
      console.warn(TAG, 'slide file:', e && e.message ? e.message : e);
      this.state = 'error';
      this.error = String((e && e.message) || e);
      this.onChange();
    }
  }

  // Page i rendered `width` pixels wide (cached).
  async render(i, width) {
    const k = i + '@' + Math.round(width);
    let c = this.rendered.get(k);
    if (!c) {
      const page = await this.pages[i].doc.getPage(this.pages[i].num);
      c = await renderPdfPage(page, width);
      this.rendered.set(k, c);
      if (this.rendered.size > DECK_RENDER_CACHE) this.rendered.delete(this.rendered.keys().next().value);
    }
    return c;
  }

  // What a matching result depends on.
  signature() {
    const chs = this.slides.chapters;
    return [this.files.map((f) => f.hash.slice(0, 12)).join(','), chs.length, chs.length ? Math.round(chs[chs.length - 1].start) : 0].join('|');
  }

  async match(job) {
    const chs = this.slides.chapters;
    if (!chs.length || this.slides.state !== 'done') { this.state = 'ready'; this.onChange(); return; }
    const sig = this.signature();
    const cached = await idbCache.get('deckmatch:' + this.lesson.mediaId);
    if (cached && cached.sig === sig && Array.isArray(cached.chapters)) {
      this.matched = cached.chapters;
      this.guesses = cached.guesses || [];
      this.state = 'ready';
      this.recompute();
      this.onChange();
      return;
    }
    this.state = 'matching';
    this.progress = 0;
    this.onChange();
    const frames = await this.slides.chapterFrames(MATCH_W, MATCH_H, this.ac.signal, (p) => { this.progress = p * 0.3; this.onChange(); });
    if (this.job !== job) return;
    const pages = [];
    for (let i = 0; i < this.pages.length; i++) {
      const c = await this.render(i, MATCH_W);
      pages.push({ rgba: c.getContext('2d').getImageData(0, 0, c.width, c.height).data, h: c.height });
    }
    this.rendered.clear();
    const cues = this.cues() || [];
    const input = {
      frames,
      pages,
      chapterTexts: chs.map((c) => cues.filter((q) => q.start < c.end && q.end > c.start).map((q) => q.text).join(' ')),
      pageTexts: this.pages.map((p) => p.text),
    };
    this.progress = 0.35;
    this.onChange();
    const r = await runSlideMatch(input, this.ac.signal);
    if (this.job !== job) return;
    this.matched = r.chapters.map((c) => (c.page >= 0 ? this.pages[c.page].key : null));
    this.guesses = r.chapters.map((c) => (c.guess >= 0 ? this.pages[c.guess].key : null));
    idbCache.put('deckmatch:' + this.lesson.mediaId, { sig, chapters: this.matched, guesses: this.guesses, at: Date.now() });
    console.info(TAG, 'slides matched: ' + this.matched.filter(Boolean).length + ' of ' + chs.length + ' chapters (' + r.ms + ' ms)');
    this.state = 'ready';
    this.progress = 1;
    this.recompute();
    this.onChange();
  }

  // Called when the chapter list changes (it arrives after the files on a first visit).
  chaptersChanged() {
    if (this.pages.length && this.state !== 'loading') this.match(this.job);
  }

  indexOfKey(k) {
    return k ? this.pages.findIndex((p) => p.key === k) : -1;
  }

  chapterKey(i) {
    const c = this.slides.chapters[i];
    return c ? String(Math.round(c.start * 10)) : '';
  }

  // Page index of chapter i from the user's correction or the match (-1: none / not a slide).
  knownPage(i) {
    const o = this.overrides[this.chapterKey(i)];
    if (o === 'none') return -1;
    if (o && this.indexOfKey(o) >= 0) return this.indexOfKey(o);
    return this.matched ? this.indexOfKey(this.matched[i]) : -1;
  }

  recompute() {
    const chs = this.slides.chapters;
    const guesses = chs.map((c, i) => (this.overrides[this.chapterKey(i)] === 'none' ? -1 : this.indexOfKey((this.guesses || [])[i])));
    this.shown = this.pages.length ? followPages(chs, chs.map((c, i) => this.knownPage(i)), guesses) : [];
  }

  // Page to show at time t while following (-1 when nothing is known yet).
  pageAt(t) {
    const k = chapterIndexAt(this.slides.chapters, t);
    if (k >= 0 && k < this.shown.length) return this.shown[k];
    return this.shown.length ? this.shown[0] : -1;
  }

  // Whether the page at time t was recognised (or set by the user) for that very part,
  // rather than carried over from an earlier part.
  knownAt(t) {
    const k = chapterIndexAt(this.slides.chapters, t);
    return k >= 0 && this.knownPage(k) >= 0;
  }

  // Seconds since a page was last recognised at time t (0 while recognised, Infinity if
  // never). Following stops claiming a page after FOLLOW_STALE_SEC.
  unrecognisedFor(t) {
    const chs = this.slides.chapters;
    const k = chapterIndexAt(chs, t);
    if (k >= 0 && this.knownPage(k) >= 0) return 0;
    for (let j = k - 1; j >= 0; j--) if (this.knownPage(j) >= 0) return Math.max(0, t - chs[j].end);
    return Infinity;
  }

  // When page i was on screen: [{ start, end }] from matched or corrected chapters, with
  // neighbouring chapters joined.
  timesOf(i) {
    const out = [];
    const chs = this.slides.chapters;
    for (let c = 0; c < chs.length; c++) {
      if (this.knownPage(c) !== i) continue;
      const last = out[out.length - 1];
      if (last && last.endChapter === c - 1) { last.end = chs[c].end; last.endChapter = c; } else out.push({ start: chs[c].start, end: chs[c].end, endChapter: c });
    }
    return out;
  }

  // The user's correction for the chapter playing at time t: a page index, 'none' (not a
  // slide) or null (back to automatic).
  correct(t, value) {
    const c = chapterIndexAt(this.slides.chapters, t);
    const key = this.chapterKey(c);
    if (!key) return;
    if (value === null) delete this.overrides[key];
    else this.overrides[key] = value === 'none' ? 'none' : this.pages[value].key;
    this.saveRecord();
    this.recompute();
    this.onChange();
  }

  correctionAt(t) {
    return this.overrides[this.chapterKey(chapterIndexAt(this.slides.chapters, t))] || null;
  }

  matchedCount() {
    let n = 0;
    for (let i = 0; i < this.slides.chapters.length; i++) if (this.knownPage(i) >= 0) n++;
    return n;
  }
}
