// ===================================================================================
// Which page of the lecturer's slide files is on screen, from the text on screen.
//
// Pure functions on strings and numbers (the reading of the screen is in 59-slide-ocr.js).
//
//   1. Words. The text recognised in each distinct screen picture is compared with each
//      page's text (tf-idf cosine). Words on many pages (course name, footer) count little;
//      words on many screen pictures (the viewer's toolbar, tab titles, a file path) count
//      little too, whatever the software.
//   2. Evidence. How a score should be read is learnt from the lecture itself: the second
//      best page of a picture is always a wrong page, so the second best scores show what
//      "wrong" looks like in this lecture; the best scores are a mix of that and "right",
//      whose share and spread are fitted to them. A score then counts as the log of how
//      much more likely it is under "right" than under "wrong". A picture with little text
//      gives little evidence either way.
//   3. Sequence. A hidden Markov model over the pictures in time order decides all pages
//      at once (Viterbi). States: every page, and "not a slide" (remembering the last page,
//      so coming back to it is cheap). Staying or moving on one page is usual; going back,
//      jumping and leaving the slides are rarer; a jump to another file is rarer still.
//      Pages with little text are placed by their neighbours.
// ===================================================================================

const SLIDE_STOP = new Set(('the and for are but not you all any can had her was one our out has have this that with from they will would there their '
  + 'what about which when your then them these some into more than only other such also each just like been were said very where while here '
  + 'should could does using used use get got let its how why who may might must shall ours yours his him she hers').split(' '));

function slideWords(text) {
  return (String(text || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !SLIDE_STOP.has(w));
}

function wordBag(words) {
  const b = new Map();
  for (const w of words) b.set(w, (b.get(w) || 0) + 1);
  return b;
}

// scores[f * P + p]: cosine between picture f and page p. explained[f * P + p]: share of
// the picture's text that is on page p (each word weighted by how rare it is among the
// pictures, so the viewer's own words count little): a slide on screen, even zoomed in,
// explains much of what is readable; a code editor showing the slide's code next to a file
// tree, menus and other code does not. words[f]: distinct page words in picture f.
function textScores(pageTexts, frameTexts) {
  const P = pageTexts.length;
  const F = frameTexts.length;
  const pdf = new Map();
  const pageBags = pageTexts.map((t) => {
    const b = wordBag(slideWords(t));
    for (const w of b.keys()) pdf.set(w, (pdf.get(w) || 0) + 1);
    return b;
  });
  const idf = (w) => Math.log((P + 1) / (pdf.get(w) + 0.5));
  // Inverted index of the pages' weighted words.
  const post = new Map();
  const pnorm = new Float64Array(P);
  pageBags.forEach((b, p) => {
    for (const [w, c] of b) {
      const x = (1 + Math.log(c)) * idf(w);
      if (x <= 0) continue;
      pnorm[p] += x * x;
      let l = post.get(w);
      if (!l) post.set(w, (l = []));
      l.push(p, x);
    }
  });
  for (let p = 0; p < P; p++) pnorm[p] = Math.sqrt(pnorm[p]) || 1;
  const raw = new Int32Array(F);
  const allBags = frameTexts.map((t, f) => { const ws = slideWords(t); raw[f] = ws.length; return wordBag(ws); });
  const frameBags = allBags.map((b) => new Map([...b].filter(([w]) => post.has(w))));
  const fdf = new Map();
  for (const b of allBags) for (const w of b.keys()) fdf.set(w, (fdf.get(w) || 0) + 1);
  // Share of the information a word carries among the pictures: 1 for a word on one
  // picture, near 0 for a word on all of them.
  const lf = Math.log(F + 1);
  const fw = (w) => (F > 1 ? Math.log((F + 1) / fdf.get(w)) / lf : 1);
  const scores = new Float32Array(F * P);
  const explained = new Float32Array(F * P);
  const words = new Int32Array(F);
  const acc = new Float64Array(P);
  frameBags.forEach((b, f) => {
    acc.fill(0);
    let all = 0;
    for (const w of allBags[f].keys()) all += fw(w) ** 2;
    if (all > 0) {
      for (const w of b.keys()) {
        const x = fw(w) ** 2 / all;
        const l = post.get(w);
        for (let k = 0; k < l.length; k += 2) explained[f * P + l[k]] += x;
      }
    }
    let n2 = 0;
    for (const [w, c] of b) {
      const x = (1 + Math.log(c)) * idf(w) * fw(w);
      if (x <= 0) continue;
      n2 += x * x;
      const l = post.get(w);
      for (let k = 0; k < l.length; k += 2) acc[l[k]] += x * l[k + 1];
    }
    words[f] = b.size;
    const n = Math.sqrt(n2) || 1;
    for (let p = 0; p < P; p++) scores[f * P + p] = acc[p] / (n * pnorm[p]);
  });
  return { scores, explained, words, raw, P, F, pageWords: Int32Array.from(pageBags, (b) => [...b.keys()].filter((w) => idf(w) > 0).length) };
}

// Cosine similarity between every two pages (P x P), from their text alone.
function pageSimilarity(pageTexts) {
  const r = textScores(pageTexts, pageTexts);
  return r.scores;
}

// ---- evidence ----

const EVIDENCE_GRID = 101;

// Log-likelihood ratio "this page is on screen" vs "it is not", learnt from the lecture's
// own scores (see the top of the file), from two measures of a picture and a page: the
// cosine and the share of the picture's text explained by the page. Each has a normal
// distribution under "wrong", fitted to every picture's second best page (always a wrong
// page) together with the best pages it explains, and one under "right", fitted to the
// best pages it explains; the share of "right" is fitted along (EM). Returns
// { llr(score, explained), right, wrong } (means and spreads of both measures).
function scoreModel(ts, pageSim) {
  const { scores, explained, words, P, F } = ts;
  const best = [];
  const second = [];
  for (let f = 0; f < F; f++) {
    if (!words[f]) continue;
    let b = -1;
    let bi = -1;
    for (let p = 0; p < P; p++) if (scores[f * P + p] > b) { b = scores[f * P + p]; bi = p; }
    // Pages at least as close to the best page as the picture is cannot be told apart
    // from it: they are not "wrong".
    let si = -1;
    for (let p = 0; p < P; p++) if (p !== bi && pageSim[bi * P + p] < b && (si < 0 || scores[f * P + p] > scores[f * P + si])) si = p;
    best.push([b, explained[f * P + bi]]);
    second.push(si >= 0 ? [scores[f * P + si], explained[f * P + si]] : [0, 0]);
  }
  const fit = (xs, ws, d) => {
    let sw = 0;
    let sx = 0;
    let sxx = 0;
    xs.forEach((x, i) => { const w = ws ? ws[i] : 1; sw += w; sx += w * x[d]; sxx += w * x[d] * x[d]; });
    const mean = sw ? sx / sw : 0;
    return { mean, sd: Math.max(Math.sqrt(Math.max(0, sxx / (sw || 1) - mean * mean)), 0.01), w: sw };
  };
  const pdf = (d, x) => Math.exp(-0.5 * ((x - d.mean) / d.sd) ** 2) / d.sd;
  const fit2 = (xs, ws) => [fit(xs, ws, 0), fit(xs, ws, 1)];
  const pdf2 = (m, x) => pdf(m[0], x[0]) * pdf(m[1], x[1]);
  let wrong = fit2(second);
  let right = [{ mean: Math.max(0, ...best.map((x) => x[0])), sd: 0.1 }, { mean: Math.max(0, ...best.map((x) => x[1])), sd: 0.1 }];
  let share = 0.5;
  const resp = new Float64Array(best.length);
  const ones = second.map(() => 1);
  for (let it = 0; it < 200 && best.length; it++) {
    best.forEach((x, i) => {
      const a = share * pdf2(right, x);
      const b = (1 - share) * pdf2(wrong, x);
      resp[i] = a + b > 0 ? a / (a + b) : (x[0] > wrong[0].mean ? 1 : 0);
    });
    const w = resp.reduce((t, x) => t + x, 0);
    share = w / best.length;
    if (w < 0.5) { share = 0; break; }
    right = fit2(best, resp);
    wrong = fit2(second.concat(best), ones.concat(Array.from(resp, (x) => 1 - x)));
  }
  // Per measure, on a grid, made non-decreasing: a higher value is never weaker evidence,
  // and a value above the typical right one is no stronger than it.
  const n = EVIDENCE_GRID;
  const grid = (r, q) => {
    const g = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = Math.min(i / (n - 1), r.mean);
      const v = share > 0 ? Math.log(pdf(r, x)) - Math.log(pdf(q, x)) : -25;
      g[i] = Math.max(i ? g[i - 1] : -Infinity, isFinite(v) ? v : -25);
    }
    return g;
  };
  const g0 = grid(right[0], wrong[0]);
  const g1 = grid(right[1], wrong[1]);
  const at = (g, x) => g[Math.max(0, Math.min(n - 1, Math.round(x * (n - 1))))];
  const llr = (s, e) => at(g0, s) + at(g1, e);
  const sum = (m) => ({ score: [m[0].mean, m[0].sd], explained: [m[1].mean, m[1].sd] });
  return { llr, right: Object.assign({ share }, sum(right)), wrong: sum(wrong) };
}

// Evidence for each picture and page: ev[f * P + p] (log-likelihood ratio against "not a
// slide"). A page without any text gives no evidence: where it was shown follows from the
// pages around it. A picture with nothing readable at all (a camera, a black screen) is
// taken as not showing any page: a page on screen always comes with some text, if only a
// title or the viewer around it.
function slideEvidence(ts, model) {
  const { scores, explained, P, F, pageWords, raw } = ts;
  const ev = new Float32Array(F * P);
  const none = model.llr(0, 0);
  for (let f = 0; f < F; f++) {
    for (let p = 0; p < P; p++) ev[f * P + p] = !raw[f] ? none : pageWords[p] ? model.llr(scores[f * P + p], explained[f * P + p]) : 0;
  }
  return ev;
}

// ---- sequence ----

// Log-probabilities of moving between two pictures in a row (the second picture differs
// from the first, so something changed on screen).
const SLIDE_MOVES = {
  stay: Math.log(0.45),      // same page (ink, pointer, a build step)
  next: Math.log(0.30),      // next page
  back: Math.log(0.05),      // previous page
  jump: Math.log(0.04),      // any other page of the same file (spread over the file)
  file: Math.log(0.01),      // a page of another file (spread over that file)
  off: Math.log(0.15),       // something that is not a slide
  offStay: Math.log(0.60),   // still not a slide
  offBack: Math.log(0.20),   // back to the page shown before
  offNext: Math.log(0.10),   // back to the slides, one page on
  offJump: Math.log(0.07),   // back to the slides at another page of the same file
  offFile: Math.log(0.03),   // back to the slides in another file
};

// ev: evidence per picture (F x P); fileOf[p]: file of page p; seq[t]: picture shown at
// step t (time order, one step per distinct picture); force[t] (optional): the user's
// correction for step t (a page, FORCE_OFF for "not a slide", -1 for none). Returns per
// step a page index or -1 (not a slide).
const FORCE_OFF = -2;

function decodeSlides(ev, P, fileOf, seq, force) {
  const S = 2 * P + 1;    // pages, "not a slide" after page p, "not a slide" before any page
  const NONE = 2 * P;
  const T = seq.length;
  const files = [];
  for (let p = 0; p < P; p++) (files[fileOf[p]] ||= []).push(p);
  const nf = files.length;
  const M = SLIDE_MOVES;
  const back = new Int32Array(T * S);
  const emit = (t, V) => {
    const f = seq[t];
    if (f >= 0) for (let p = 0; p < P; p++) V[p] += ev[f * P + p];
    const k = force ? force[t] : -1;
    if (k >= 0) { for (let s = 0; s < S; s++) if (s !== k) V[s] = -Infinity; } else if (k === FORCE_OFF) for (let p = 0; p < P; p++) V[p] = -Infinity;
  };
  let V = new Float64Array(S).fill(-Infinity);
  for (let p = 0; p < P; p++) V[p] = -Math.log(2 * P);
  V[NONE] = -Math.log(2);
  if (T) emit(0, V);
  const fileBest = new Float64Array(nf);
  const fileArg = new Int32Array(nf);
  const offBest = new Float64Array(nf);
  const offArg = new Int32Array(nf);
  // Best and second best file, for moves into another file.
  const top = (arr) => {
    let a = -1;
    let b = -1;
    for (let k = 0; k < nf; k++) if (a < 0 || arr[k] > arr[a]) { b = a; a = k; } else if (b < 0 || arr[k] > arr[b]) b = k;
    return [a, b];
  };
  for (let t = 1; t < T; t++) {
    const N = new Float64Array(S).fill(-Infinity);
    const B = back.subarray(t * S, (t + 1) * S);
    fileBest.fill(-Infinity);
    offBest.fill(-Infinity);
    for (let p = 0; p < P; p++) {
      const k = fileOf[p];
      if (V[p] > fileBest[k]) { fileBest[k] = V[p]; fileArg[k] = p; }
      if (V[P + p] > offBest[k]) { offBest[k] = V[P + p]; offArg[k] = P + p; }
    }
    const [fa, fb] = top(fileBest);
    const [oa, ob] = top(offBest);
    for (let q = 0; q < P; q++) {
      const k = fileOf[q];
      const n = files[k].length;
      const same = (r) => r >= 0 && r < P && fileOf[r] === k;
      let best = V[q] + M.stay;
      let arg = q;
      const from = (s, v) => { if (v > best) { best = v; arg = s; } };
      if (same(q - 1)) { from(q - 1, V[q - 1] + M.next); from(P + q - 1, V[P + q - 1] + M.offNext); }
      if (same(q + 1)) from(q + 1, V[q + 1] + M.back);
      from(P + q, V[P + q] + M.offBack);
      from(fileArg[k], fileBest[k] + M.jump - Math.log(n));
      from(offArg[k], offBest[k] + M.offJump - Math.log(n));
      const of = fa !== k ? fa : fb;
      if (of >= 0) from(fileArg[of], fileBest[of] + M.file - Math.log(n));
      const oo = oa !== k ? oa : ob;
      if (oo >= 0) from(offArg[oo], offBest[oo] + M.offFile - Math.log(n));
      from(NONE, V[NONE] + M.offJump - Math.log(P));
      N[q] = best;
      B[q] = arg;
      const a = V[q] + M.off;
      const b = V[P + q] + M.offStay;
      N[P + q] = a >= b ? a : b;
      B[P + q] = a >= b ? q : P + q;
    }
    N[NONE] = V[NONE] + M.offStay;
    B[NONE] = NONE;
    emit(t, N);
    V = N;
  }
  let s = 0;
  for (let i = 1; i < S; i++) if (V[i] > V[s]) s = i;
  const out = new Int32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    out[t] = s < P ? s : -1;
    if (t > 0) s = back[t * S + s];
  }
  return out;
}

// ---- one lecture ----

// input: { pageTexts: [string], fileOf: [file index per page], texts: [string] (each
// distinct picture read), at: [per 10 s sample: index into texts, -1 = not read yet],
// force: [per sample: page, FORCE_OFF or -1] (optional) }.
// Returns { pages: Int32Array per sample (page index, -1 = not a slide, -2 = not read yet),
// model }.
function followLecture(input) {
  const P = input.pageTexts.length;
  const at = input.at;
  const force = input.force || [];
  const out = new Int32Array(at.length).fill(-2);
  if (!P || !input.texts.length) return { pages: out, model: null };
  const ts = textScores(input.pageTexts, input.texts);
  const model = scoreModel(ts, pageSimilarity(input.pageTexts));
  const ev = slideEvidence(ts, model);
  // One step per run of samples showing the same picture (with the same correction).
  const seq = [];
  const fs = [];
  const stepOf = new Int32Array(at.length).fill(-1);
  for (let i = 0; i < at.length; i++) {
    if (at[i] < 0) continue;
    const k = force[i] == null ? -1 : force[i];
    const last = seq.length - 1;
    if (last >= 0 && seq[last] === at[i] && fs[last] === k && stepOf[i - 1] === last) { stepOf[i] = last; continue; }
    seq.push(at[i]);
    fs.push(k);
    stepOf[i] = seq.length - 1;
  }
  const states = decodeSlides(ev, P, Int32Array.from(input.fileOf), seq, fs);
  for (let i = 0; i < at.length; i++) if (stepOf[i] >= 0) out[i] = states[stepOf[i]];
  return { pages: out, model: { right: model.right, wrong: model.wrong } };
}

// ---- the Worker ----

// Source of a Worker running followLecture, assembled from the functions above so the code
// that runs is exactly the code in this file.
function slideTextWorkerSource() {
  const fns = [slideWords, wordBag, textScores, pageSimilarity, scoreModel, slideEvidence, decodeSlides, followLecture];
  return '"use strict";\n'
    + 'const SLIDE_STOP = new Set(' + JSON.stringify([...SLIDE_STOP]) + ');\n'
    + 'const SLIDE_MOVES = ' + JSON.stringify(SLIDE_MOVES) + ';\n'
    + 'const EVIDENCE_GRID = ' + EVIDENCE_GRID + ';\n'
    + 'const FORCE_OFF = ' + FORCE_OFF + ';\n'
    + fns.map((f) => f.toString()).join('\n\n') + '\n'
    + 'self.onmessage = (e) => {\n'
    + '  const t0 = Date.now();\n'
    + '  try { const r = followLecture(e.data.input); r.ms = Date.now() - t0; self.postMessage({ id: e.data.id, ok: true, result: r }, [r.pages.buffer]); }\n'
    + '  catch (err) { self.postMessage({ id: e.data.id, ok: false, error: String((err && err.message) || err) }); }\n'
    + '};\n';
}

// One Worker for a player's lifetime; run(input) resolves with followLecture's result.
class SlideTextWorker {
  constructor(disposer) {
    this.worker = null;
    this.seq = 0;
    this.waiting = new Map();
    disposer.add(() => this.close());
  }

  run(input) {
    // Closed with the player: never start a new Worker afterwards.
    if (this.closed) return Promise.reject(new Error('closed'));
    if (!this.worker) {
      const url = URL.createObjectURL(new Blob([slideTextWorkerSource()], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
      this.worker.onmessage = (e) => {
        const w = this.waiting.get(e.data.id);
        if (!w) return;
        this.waiting.delete(e.data.id);
        if (e.data.ok) w.resolve(e.data.result); else w.reject(new Error(e.data.error));
      };
      this.worker.onerror = (e) => {
        for (const w of this.waiting.values()) w.reject(new Error(e.message || 'worker error'));
        this.waiting.clear();
      };
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, input });
    });
  }

  close() {
    this.closed = true;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error('closed'));
    this.waiting.clear();
  }
}
