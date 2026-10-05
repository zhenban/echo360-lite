// ===================================================================================
// Which page of the lecturer's slide file each chapter shows (or "not a slide").
//
// Pure functions on numbers; they run in a Worker (see runSlideMatch below), so the page
// never waits for them. The approach, checked against a hand-labelled lecture
// (test/fixtures/slides-*.json):
//
//   1. Layout. The slide sits in the same place in the screen recording most of the time
//      (a full-screen show or a viewer window). It is found once per lecture: on every
//      chapter, search page sizes from 50% to 100% of the frame width at every position,
//      comparing 16 x 9 grids of brightness and edge density with the average page (the
//      template gives the outline), then the best few placements with every page. The
//      confident results, grouped by transform, give the layout (or a few, when the window
//      was resized during the lecture). Views that fit none of them (zoomed in, other
//      windows) end up as "not a slide".
//   2. Image score. Each chapter is compared with every page in small neighbourhoods of
//      the layouts, on 64 x 36 grids. Edge density (mean gradient per cell) separates pages
//      of one template much better than brightness, which is mostly "white page, yellow
//      footer".
//   3. Text score. Words spoken during the chapter against the words on each page (tf-idf
//      cosine). Only a small tie-breaker: speech rarely repeats the slide text.
//   4. Sequence. A Viterbi pass over the chapters prefers staying on a page or moving to
//      the next one, allows jumps back and forward at a cost, and has a "not a slide" state.
//   5. Gate. A chapter keeps its page only with a strong image score and a clear lead over
//      the other pages, or with a plausible score that the sequence and a clearly matched
//      neighbour agree with. Anything unsure is "not matched": a wrong page is worse than
//      none.
// ===================================================================================

const MATCH_W = 256;            // frames and pages are compared at 256 pixels wide
const MATCH_H = 144;
const MATCH_SCORE = 0.55;       // image score needed on its own (with a clear lead)
const MATCH_LEAD = 0.10;        // lead over the best different page
const MATCH_SCORE_SEQ = 0.45;   // image score needed when the sequence supports the page

// ---- feature images ----

function lumaOf(rgba, n) {
  const L = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114;
  return L;
}

// |dx| + |dy|: averaged over a cell, this is the cell's edge density.
function gradOf(L, w, h) {
  const G = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let g = 0;
      if (x > 0) g += Math.abs(L[i] - L[i - 1]);
      if (y > 0) g += Math.abs(L[i] - L[i - w]);
      G[i] = g;
    }
  }
  return G;
}

function integralOf(A, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += A[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  return I;
}

// Means of the cells of a gw x gh grid laid over a w x h image at transform t (page width
// t.s, top-left t.x, t.y) for a page of aspect ar (height / width). Cells not fully inside
// get mask 0. Returns the share of cells inside.
function cellMeans(I, w, h, t, ar, gw, gh, out, mask) {
  const cw = t.s / gw;
  const ch = (t.s * ar) / gh;
  const W1 = w + 1;
  let inside = 0;
  for (let j = 0; j < gh; j++) {
    const ys = t.y + j * ch;
    const ye = ys + ch;
    const rowOk = ys >= -0.01 && ye <= h + 0.01;
    const a = Math.min(h, Math.max(0, Math.round(ys)));
    const b = Math.min(h, Math.max(0, Math.round(ye)));
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      const xs = t.x + i * cw;
      const xe = xs + cw;
      if (!rowOk || xs < -0.01 || xe > w + 0.01) { mask[k] = 0; out[k] = 0; continue; }
      const c = Math.min(w, Math.max(0, Math.round(xs)));
      const d = Math.min(w, Math.max(0, Math.round(xe)));
      out[k] = (I[b * W1 + d] - I[a * W1 + d] - I[b * W1 + c] + I[a * W1 + c]) / Math.max(1, (b - a) * (d - c));
      mask[k] = 1;
      inside++;
    }
  }
  return inside / (gw * gh);
}

// Normalised cross-correlation of P and f over the cells where mask is set.
function nccMasked(P, f, mask, n) {
  let mp = 0;
  let mf = 0;
  let m = 0;
  for (let i = 0; i < n; i++) if (mask[i]) { mp += P[i]; mf += f[i]; m++; }
  if (m < 4) return -1;
  mp /= m;
  mf /= m;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const a = P[i] - mp;
    const b = f[i] - mf;
    sab += a * b;
    saa += a * a;
    sbb += b * b;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

// ---- pages and frames ----

// Grids of one page, from an RGBA rendering MATCH_W pixels wide and h high.
function pageFeatures(rgba, w, h) {
  const L = lumaOf(rgba, w * h);
  const IL = integralOf(L, w, h);
  const IG = integralOf(gradOf(L, w, h), w, h);
  const ar = h / w;
  const full = { s: w, x: 0, y: 0 };
  const grid = (I, gw) => {
    const gh = Math.max(4, Math.round(gw * ar));
    const out = new Float32Array(gw * gh);
    cellMeans(I, w, h, full, ar, gw, gh, out, new Uint8Array(gw * gh));
    return out;
  };
  return {
    ar, gh16: Math.max(4, Math.round(16 * ar)), gh64: Math.max(4, Math.round(64 * ar)),
    l16: grid(IL, 16), g16: grid(IG, 16), l64: grid(IL, 64), g64: grid(IG, 64),
  };
}

// Integral images of a frame, from RGBA at MATCH_W x MATCH_H.
function frameFeatures(rgba, w, h) {
  const L = lumaOf(rgba, w * h);
  let mean = 0;
  for (let i = 0; i < L.length; i++) mean += L[i];
  return { w, h, IL: integralOf(L, w, h), IG: integralOf(gradOf(L, w, h), w, h), mean: mean / L.length };
}

function gridBuffers() {
  const n = 64 * 64;
  return { a: new Float32Array(n), b: new Float32Array(n), m: new Uint8Array(n) };
}

// Score of page p at transform t: 0.3 brightness + 0.7 edge-density correlation, on the
// 16-wide (fine = false) or 64-wide grids. Placements mostly outside the frame score -1.
// (Leaving out cells with extra edges, to tolerate ink, was tried: it raised the scores of
// non-slides as much as those of inked slides and produced a wrong match.)
function pageScore(f, p, t, fine, buf) {
  const gw = fine ? 64 : 16;
  const gh = fine ? p.gh64 : p.gh16;
  const n = gw * gh;
  if (cellMeans(f.IL, f.w, f.h, t, p.ar, gw, gh, buf.a, buf.m) < 0.8) return -1;
  cellMeans(f.IG, f.w, f.h, t, p.ar, gw, gh, buf.b, buf.m);
  return 0.3 * nccMasked(fine ? p.l64 : p.l16, buf.a, buf.m, n) + 0.7 * nccMasked(fine ? p.g64 : p.g16, buf.b, buf.m, n);
}

// Pages whose edge grids look alike (animation steps exported as separate pages, repeated
// title slides). They are not counted as competitors when measuring a lead.
function similarPages(pages) {
  const sim = pages.map(() => new Uint8Array(pages.length));
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      if (pages[i].gh64 !== pages[j].gh64) continue;
      const n = 64 * pages[i].gh64;
      if (nccMasked(pages[i].g64, pages[j].g64, new Uint8Array(n).fill(1), n) > 0.85) { sim[i][j] = 1; sim[j][i] = 1; }
    }
  }
  return sim;
}

function leadOf(scores, page, sim) {
  let second = -1;
  for (let i = 0; i < scores.length; i++) if (i !== page && !sim[page][i] && scores[i] > second) second = scores[i];
  return scores[page] - second;
}

// ---- 1. layout ----

// The average page (mean grids of all pages of the most common aspect). The template's
// background, title area and footer give the page's outline, so the coarse layout search
// compares with this one picture instead of every page.
function meanPage(pages) {
  const ar = pages[0].ar;
  const same = pages.filter((p) => p.ar === ar);
  const avg = (k) => {
    const out = new Float32Array(same[0][k].length);
    for (const p of same) for (let i = 0; i < out.length; i++) out[i] += p[k][i] / same.length;
    return out;
  };
  return { ar, gh16: same[0].gh16, gh64: same[0].gh64, l16: avg('l16'), g16: avg('g16'), l64: avg('l64'), g64: avg('g64') };
}

// Best (page, transform) for one frame over the layout search space (page width 50% to
// 100% of the frame; the page may run off the right or bottom edge a little, as a viewer
// window often does), and the best fine score of every page.
function searchLayout(f, pages, mean) {
  const buf = gridBuffers();
  const cands = [];
  for (let k = 0; k < 11; k++) {
    const s = f.w * (0.5 + (k * 0.5) / 10);
    const ph = s * mean.ar;
    for (let y = 0; y + 0.9 * ph <= f.h + 0.5; y += 3) {
      for (let x = 0; x + 0.85 * s <= f.w + 0.5; x += 3) cands.push({ v: pageScore(f, mean, { s, x, y }, false, buf), s, x, y });
    }
  }
  cands.sort((a, b) => b.v - a.v);
  let top = null;
  const scores = new Float32Array(pages.length).fill(-1);
  for (const c of cands.slice(0, 8)) {
    for (let i = 0; i < pages.length; i++) {
      const v = pageScore(f, pages[i], c, true, buf);
      if (v > scores[i]) scores[i] = v;
      if (!top || v > top.score) top = { page: i, s: c.s, x: c.x, y: c.y, score: v };
    }
  }
  return { top, scores };
}

// The lecture's layouts: the confident layout searches grouped by transform (size within
// 6%, position within 6 px); each group seen at least twice is a layout { s, x, y,
// support } (median of the group). A lecturer may resize the viewer window once or twice
// during a lecture, so there can be more than one. `tried` collects what each chapter gave
// (for diagnostics).
function findLayouts(frames, pages, sim, tried) {
  const mean = meanPage(pages);
  const good = [];
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i]) continue;
    const r = searchLayout(frames[i], pages, mean);
    const lead = r.top ? leadOf(r.scores, r.top.page, sim) : 0;
    if (tried) tried.push(Object.assign({ chapter: i, lead }, r.top));
    if (r.top && r.top.score >= MATCH_SCORE && lead >= MATCH_LEAD) good.push(r.top);
  }
  const groups = [];
  for (const g of good) {
    const near = groups.find((gr) => Math.abs(gr[0].s - g.s) <= 0.06 * gr[0].s && Math.abs(gr[0].x - g.x) <= 6 && Math.abs(gr[0].y - g.y) <= 6);
    if (near) near.push(g); else groups.push([g]);
  }
  return groups.filter((gr) => gr.length >= 2).sort((a, b) => b.length - a.length).map((gr) => {
    const med = (k) => gr.map((g) => g[k]).sort((a, b) => a - b)[gr.length >> 1];
    return { s: med('s'), x: med('x'), y: med('y'), support: gr.length };
  });
}

// ---- 2. image scores per chapter ----

// Score of every page for one frame, searched in small neighbourhoods of the layouts.
function scoreAgainstLayouts(f, pages, layouts) {
  const buf = gridBuffers();
  const ts = [];
  for (const layout of layouts) {
    for (const ds of [0.95, 0.98, 1.01, 1.04]) {
      for (let dx = -6; dx <= 6; dx += 2) {
        for (let dy = -4; dy <= 4; dy += 2) ts.push({ s: layout.s * ds, x: layout.x + dx, y: layout.y + dy });
      }
    }
  }
  // The coarse pass picks the candidate pages, the fine pass scores them. Pages that are
  // not candidates keep a score well below any candidate.
  const coarse = new Float32Array(pages.length).fill(-1);
  for (const t of ts) for (let i = 0; i < pages.length; i++) coarse[i] = Math.max(coarse[i], pageScore(f, pages[i], t, false, buf));
  const cand = [...coarse.keys()].sort((a, b) => coarse[b] - coarse[a]).slice(0, 6);
  const scores = Float32Array.from(coarse, (v) => Math.min(v, 0.4) - 0.2);
  for (const i of cand) {
    let best = -1;
    for (const t of ts) best = Math.max(best, pageScore(f, pages[i], t, true, buf));
    scores[i] = best;
  }
  return scores;
}

// ---- 3. text ----

const STOP_WORDS = new Set(('the and for are but not you all any can had her was one our out has have this that with from they '
  + 'will would there their what about which when your then them these some into more than only other such also each just like '
  + 'been were said very where while here should could does using used use get got let').split(' '));

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
}

// tf-idf cosine similarity of each chapter's speech to each page's text.
function textScores(chapterTexts, pageTexts) {
  const df = new Map();
  const pageBags = pageTexts.map((t) => {
    const bag = new Map();
    for (const w of words(t)) if (!STOP_WORDS.has(w)) bag.set(w, (bag.get(w) || 0) + 1);
    for (const w of bag.keys()) df.set(w, (df.get(w) || 0) + 1);
    return bag;
  });
  const n = pageTexts.length;
  const vec = (bag) => {
    const v = new Map();
    let norm = 0;
    for (const [w, c] of bag) {
      const x = (1 + Math.log(c)) * Math.log((n + 1) / ((df.get(w) || 0) + 1));
      if (x > 0) { v.set(w, x); norm += x * x; }
    }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const pv = pageBags.map(vec);
  return chapterTexts.map((t) => {
    const bag = new Map();
    for (const w of words(t)) if (!STOP_WORDS.has(w) && df.has(w)) bag.set(w, (bag.get(w) || 0) + 1);
    const cv = vec(bag);
    return Float32Array.from(pv, (p) => {
      let dot = 0;
      for (const [w, x] of cv.v) { const y = p.v.get(w); if (y) dot += x * y; }
      return dot / (cv.norm * p.norm);
    });
  });
}

// ---- 4. sequence ----

// Viterbi over chapters. States: pages 0..n-1 and n = "not a slide". Emission: image score
// plus a little text score for pages, a constant for "not a slide". Transitions favour the
// same page and the next one; other jumps cost more. Returns the page per chapter, -1 for
// "not a slide".
function alignSequence(img, txt) {
  const C = img.length;
  if (!C) return [];
  const n = img[0].length;
  const NONE = n;
  const emit = (c, s) => (s === NONE ? 0.42 : img[c][s] + 0.15 * (txt ? txt[c][s] : 0));
  const trans = (a, b) => {
    if (a === b) return 0;
    if (a === NONE || b === NONE) return 0.04;
    if (b === a + 1) return 0.02;
    if (b > a && b <= a + 3) return 0.08;
    return 0.14;
  };
  let score = new Float32Array(n + 1);
  const back = [];
  for (let s = 0; s <= n; s++) score[s] = emit(0, s);
  for (let c = 1; c < C; c++) {
    const next = new Float32Array(n + 1);
    const bp = new Int16Array(n + 1);
    for (let s = 0; s <= n; s++) {
      let best = -Infinity;
      let arg = 0;
      for (let r = 0; r <= n; r++) {
        const v = score[r] - trans(r, s);
        if (v > best) { best = v; arg = r; }
      }
      next[s] = best + emit(c, s);
      bp[s] = arg;
    }
    back.push(bp);
    score = next;
  }
  let s = 0;
  for (let k = 1; k <= n; k++) if (score[k] > score[s]) s = k;
  const path = new Array(C);
  path[C - 1] = s;
  for (let c = C - 1; c > 0; c--) { s = back[c - 1][s]; path[c - 1] = s; }
  return path.map((v) => (v === NONE ? -1 : v));
}

// ---- 5. decision ----

// Final page per chapter (-1 = not matched): { page, score, lead, by, guess }. by is
// 'image' when the image alone is clear, or 'sequence' when the image is plausible (but
// not clear), the sequence chose the same page, and a chapter within 3 on either side was
// clearly matched to that page or a neighbouring one. guess is the best-looking page even
// when unsure (only for turning pages while following, never shown as a match).
function decidePages(img, path, sim) {
  const tops = img.map((scores) => {
    let top = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[top]) top = i;
    return { top, score: scores[top], lead: leadOf(scores, top, sim) };
  });
  const clear = tops.map((t) => t.score >= MATCH_SCORE && t.lead >= MATCH_LEAD);
  return tops.map((t, c) => {
    const guess = t.score > 0 ? t.top : -1;
    if (clear[c]) return { page: t.top, score: t.score, lead: t.lead, by: 'image', guess };
    const p = path[c];
    const plausible = p >= 0 && (p === t.top || sim[p][t.top]) && img[c][p] >= MATCH_SCORE_SEQ && t.lead >= 0.05;
    let near = false;
    for (let d = -3; d <= 3 && plausible && !near; d++) {
      const k = c + d;
      if (d !== 0 && k >= 0 && k < tops.length && clear[k] && Math.abs(tops[k].top - p) <= 1) near = true;
    }
    if (plausible && near) return { page: p, score: img[c][p], lead: t.lead, by: 'sequence', guess };
    return { page: -1, score: t.score, lead: t.lead, by: '', guess };
  });
}

// Everything for one lecture. input: { frames: [RGBA at MATCH_W x MATCH_H or null],
// pages: [{ rgba, h }] rendered MATCH_W wide, chapterTexts: [string], pageTexts: [string] }.
// Returns { layout, chapters: [{ page, score, lead, by }] }.
function matchLecture(input) {
  const pages = input.pages.map((p) => pageFeatures(p.rgba, MATCH_W, p.h));
  const sim = similarPages(pages);
  const frames = input.frames.map((rgba) => (rgba ? frameFeatures(rgba, MATCH_W, MATCH_H) : null));
  const tried = [];
  const layouts = findLayouts(frames, pages, sim, tried);
  if (!layouts.length) return { layouts, tried, chapters: frames.map(() => ({ page: -1, score: 0, lead: 0, by: '', guess: -1 })) };
  const img = frames.map((f) => (f ? scoreAgainstLayouts(f, pages, layouts) : new Float32Array(pages.length).fill(-1)));
  const txt = input.chapterTexts && input.pageTexts ? textScores(input.chapterTexts, input.pageTexts) : null;
  const path = alignSequence(img, txt);
  return { layouts, tried, chapters: decidePages(img, path, sim) };
}

// ---- the Worker ----

// Source of a Worker running matchLecture, assembled from the functions above so the code
// that runs is exactly the code in this file.
function slideMatchWorkerSource() {
  const fns = [lumaOf, gradOf, integralOf, cellMeans, nccMasked, pageFeatures, frameFeatures, gridBuffers, pageScore,
    similarPages, leadOf, meanPage, searchLayout, findLayouts, scoreAgainstLayouts, words, textScores, alignSequence, decidePages,
    matchLecture];
  const consts = { MATCH_W, MATCH_H, MATCH_SCORE, MATCH_LEAD, MATCH_SCORE_SEQ };
  return '"use strict";\n'
    + Object.entries(consts).map(([k, v]) => 'const ' + k + ' = ' + JSON.stringify(v) + ';').join('\n') + '\n'
    + 'const STOP_WORDS = new Set(' + JSON.stringify([...STOP_WORDS]) + ');\n'
    + fns.map((f) => f.toString()).join('\n\n') + '\n'
    + 'self.onmessage = (e) => {\n'
    + '  const t0 = Date.now();\n'
    + '  try { const r = matchLecture(e.data); r.ms = Date.now() - t0; self.postMessage({ ok: true, result: r }); }\n'
    + '  catch (err) { self.postMessage({ ok: false, error: String((err && err.message) || err) }); }\n'
    + '};\n';
}

// Runs matchLecture in a Worker; rejects when workers are unavailable, the job fails, or
// the signal aborts.
function runSlideMatch(input, signal) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      const url = URL.createObjectURL(new Blob([slideMatchWorkerSource()], { type: 'text/javascript' }));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
    } catch (e) { reject(e); return; }
    const onAbort = () => { done(); reject(new Error('aborted')); };
    const done = () => { worker.terminate(); if (signal) signal.removeEventListener('abort', onAbort); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e) => { done(); if (e.data.ok) resolve(e.data.result); else reject(new Error(e.data.error)); };
    worker.onerror = (e) => { done(); reject(new Error(e.message || 'worker error')); };
    const transfer = [];
    for (const f of input.frames) if (f) transfer.push(f.buffer);
    for (const p of input.pages) transfer.push(p.rgba.buffer);
    worker.postMessage(input, transfer);
  });
}
