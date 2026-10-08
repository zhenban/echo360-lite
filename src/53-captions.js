// ===================================================================================
// Captions overlay and transcript panel. Both read one sorted cue list.
// ===================================================================================

// Finds the cue for a playback time. Sequential playback moves forward one cue at a time,
// so the previous answer is checked first; seeks fall back to a binary search.
class CueIndex {
  constructor(cues) {
    this.cues = cues;
    this.last = -1;
  }

  // Index of the last cue that started at or before t (-1 before the first cue).
  started(t) {
    const c = this.cues;
    const i = this.last;
    if (i >= 0 && i < c.length && c[i].start <= t && (i + 1 === c.length || c[i + 1].start > t)) return i;
    if (i + 1 < c.length && c[i + 1].start <= t && (i + 2 >= c.length || c[i + 2].start > t)) return (this.last = i + 1);
    let lo = 0;
    let hi = c.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    this.last = k;
    return k;
  }

  // Index of the cue being spoken at t, or -1 in a gap.
  active(t) {
    const k = this.started(t);
    return k >= 0 && t < this.cues[k].end ? k : -1;
  }
}

// What was said in the last `span` seconds before t, in whole sentences: { start, end,
// text } or null. A cue that continues a sentence from the cue before it pulls that one
// in (at most 30 s further back); the sentence being spoken at t is completed (at most
// 20 s ahead). Cues are sentence-ish but often break mid-sentence.
function captionExcerpt(cues, t, span) {
  const ends = (s) => /[.?!]["')\]]?\s*$/.test(s);
  let a = cues.findIndex((c) => c.end > t - span);
  if (a < 0) return null;
  let b = a;
  while (b + 1 < cues.length && cues[b + 1].start <= t) b++;
  if (cues[a].start > t) return null;
  const from = t - span;
  while (a > 0 && !ends(cues[a - 1].text) && cues[a - 1].start >= from - 30) a--;
  while (b + 1 < cues.length && !ends(cues[b].text) && cues[b + 1].start <= t + 20) b++;
  const text = cues.slice(a, b + 1).map((c) => c.text.trim()).join(' ').replace(/\s+/g, ' ');
  return { start: cues[a].start, end: cues[b].end, text };
}

const CAPTION_SIZES = { s: 0.8, m: 1, l: 1.3, xl: 1.65 };

class CaptionsView {
  constructor(elem, video) {
    this.el = elem;
    this.video = video;
    this.textEl = elem.firstElementChild;
    this.index = null;
    this.on = false;
    this.shown = -2;
    this.timer = 0;
  }

  setCues(cues) {
    this.index = new CueIndex(cues);
    this.shown = -2;
  }

  setOn(on) {
    this.on = on;
    this.el.hidden = !on;
    this.shown = -2;
    if (!on) this.clearTimer();
  }

  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
  }

  // timeupdate fires only about 4 times a second, so a caption could change up to 250 ms
  // late. While playing, one timer is set for the next cue boundary instead.
  scheduleNext(t) {
    this.clearTimer();
    const v = this.video;
    if (!v || v.paused || v.seeking || !this.index) return;
    const c = this.index.cues;
    const k = this.index.started(t);
    let next = k + 1 < c.length ? c[k + 1].start : Infinity;
    if (k >= 0 && c[k].end > t) next = Math.min(next, c[k].end);
    if (!isFinite(next)) return;
    const ms = ((next - t) / (v.playbackRate || 1)) * 1000;
    if (ms > 400) return; // the next timeupdate comes first
    this.timer = setTimeout(guard(() => { this.timer = 0; this.update(this.video.currentTime); }), Math.max(0, ms) + 5);
  }

  dispose() {
    this.clearTimer();
  }

  setSize(size) {
    this.el.style.setProperty('--capscale', String(CAPTION_SIZES[size] || 1));
  }

  // Called on timeupdate/seeked (about 4 times a second): writes the DOM only when the cue
  // changes.
  update(t) {
    if (!this.on || !this.index || document.hidden) return;
    const k = this.index.active(t);
    this.scheduleNext(t);
    if (k === this.shown) return;
    this.shown = k;
    if (k < 0) { this.el.classList.add('empty'); this.textEl.textContent = ''; return; }
    this.el.classList.remove('empty');
    this.textEl.textContent = this.index.cues[k].text;
  }
}

// Transcript tab of the side panel. The list is built once, on first show; rows use
// `content-visibility: auto`, so off-screen rows cost no layout or paint.
class TranscriptPanel {
  constructor(player, elem, marksEl, disposer) {
    this.player = player;
    this.el = elem;
    this.visible = false;
    this.marksEl = marksEl;
    this.list = elem.querySelector('.tlist');
    this.search = elem.querySelector('.tsearch');
    this.countEl = elem.querySelector('.tcount');
    this.backBtn = elem.querySelector('.tback');
    this.cues = [];
    this.lower = null;
    this.index = null;
    this.rows = null;
    this.current = -1;
    this.follow = true;
    this.hits = [];
    this.hitPos = -1;
    this.searchTimer = 0;
    this.programmaticScrollUntil = 0;
    this.d = disposer || new Disposer();   // owned by whoever created this (parent.child())
    this.bind();
  }

  setCues(cues) {
    this.cues = cues;
    this.index = new CueIndex(cues);
    this.lower = null;
    if (this.rows) { this.list.textContent = ''; this.rows = null; }
  }

  get open() { return this.visible; }

  build() {
    if (this.rows) return;
    const long = this.player.duration() >= 3600;
    const frag = document.createDocumentFragment();
    this.rows = this.cues.map((c, i) => {
      const row = document.createElement('div');
      row.className = 'trow';
      row.dataset.i = String(i);
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = fmtTime(c.start, long);
      const tx = document.createElement('span');
      tx.className = 'tx';
      tx.textContent = c.text;
      row.append(ts, tx);
      frag.appendChild(row);
      return row;
    });
    this.list.appendChild(frag);
    this.current = -1;
  }

  show(on) {
    this.visible = on;
    if (on) {
      this.build();
      this.follow = true;
      this.backBtn.hidden = true;
      this.update(this.player.video.currentTime, true);
    }
  }

  // Called on timeupdate/seeked while the panel is open: moves the highlight when the cue
  // changes and keeps it in view unless the user has scrolled away.
  update(t, force) {
    if (!this.open || !this.rows || document.hidden) return;
    const k = this.index.started(t);
    if (k === this.current && !force) return;
    if (this.current >= 0 && this.rows[this.current]) this.rows[this.current].classList.remove('cur');
    this.current = k;
    if (k < 0) return;
    this.rows[k].classList.add('cur');
    if (this.follow) this.scrollTo(k);
  }

  scrollTo(k) {
    const row = this.rows[k];
    if (!row) return;
    this.programmaticScrollUntil = performance.now() + 600;
    row.scrollIntoView({ block: 'center' });
  }

  stopFollowing() {
    if (!this.follow) return;
    this.follow = false;
    this.backBtn.hidden = false;
  }

  bind() {
    const d = this.d;
    d.listen(this.list, 'click', (e) => {
      const row = e.target.closest('.trow');
      if (!row) return;
      this.player.seek(this.cues[+row.dataset.i].start);
      this.follow = true;
      this.backBtn.hidden = true;
    });
    // Any user-initiated scrolling of the list pauses auto-follow.
    const userScroll = () => this.stopFollowing();
    d.listen(this.list, 'wheel', userScroll, { passive: true });
    d.listen(this.list, 'touchmove', userScroll, { passive: true });
    d.listen(this.list, 'keydown', (e) => { if (/^(Arrow|Page|Home|End| )/.test(e.key)) userScroll(); });
    d.listen(this.list, 'scroll', () => { if (performance.now() > this.programmaticScrollUntil && this.dragScroll) userScroll(); }, { passive: true });
    d.listen(this.list, 'pointerdown', (e) => { if (e.target === this.list) this.dragScroll = true; });
    d.listen(window, 'pointerup', () => { this.dragScroll = false; });
    d.listen(this.backBtn, 'click', () => {
      this.follow = true;
      this.backBtn.hidden = true;
      if (this.current >= 0) this.scrollTo(this.current);
    });
    d.listen(this.search, 'input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.runSearch(), 150);
    });
    d.listen(this.search, 'keydown', (e) => {
      if (e.key === 'Enter') { this.stepHit(e.shiftKey ? -1 : 1); e.preventDefault(); }
      if (e.key === 'Escape') { this.search.value = ''; this.runSearch(); e.preventDefault(); }
      e.stopPropagation();
    });
    d.listen(this.el.querySelector('.tprev'), 'click', () => this.stepHit(-1));
    d.listen(this.el.querySelector('.tnext'), 'click', () => this.stepHit(1));
    d.add(() => clearTimeout(this.searchTimer));
  }

  runSearch() {
    const q = this.search.value.trim().toLowerCase();
    for (const i of this.hits) if (this.rows && this.rows[i]) this.rows[i].classList.remove('hit');
    this.hits = [];
    this.hitPos = -1;
    if (q) {
      if (!this.lower) this.lower = this.cues.map((c) => c.text.toLowerCase());
      for (let i = 0; i < this.lower.length; i++) if (this.lower[i].includes(q)) this.hits.push(i);
      for (const i of this.hits) this.rows[i].classList.add('hit');
    }
    this.countEl.textContent = q ? tr('searchCount', { n: this.hits.length }) : '';
    this.renderMarks();
  }

  stepHit(dir) {
    if (!this.hits.length) return;
    this.hitPos = (this.hitPos + dir + this.hits.length) % this.hits.length;
    const k = this.hits[this.hitPos];
    this.countEl.textContent = tr('searchPos', { i: this.hitPos + 1, n: this.hits.length });
    this.stopFollowing();
    this.scrollTo(k);
  }

  // Search hits on the progress bar, merged into 0.25% buckets (at most 400 marks).
  renderMarks() {
    const elem = this.marksEl;
    elem.textContent = '';
    const dur = this.player.duration();
    if (!this.hits.length || !dur) return;
    const seen = new Set();
    const frag = document.createDocumentFragment();
    for (const i of this.hits) {
      const bucket = Math.floor((this.cues[i].start / dur) * 400);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      const m = document.createElement('i');
      m.style.left = (bucket / 4).toFixed(2) + '%';
      frag.appendChild(m);
    }
    elem.appendChild(frag);
  }

  dispose() {
    this.d.dispose();
  }
}
