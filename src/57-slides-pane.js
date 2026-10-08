// ===================================================================================
// Reading along with the lecturer's PDF, and the Slides tab of the side panel.
//
// SlideReader holds the reader's state (the page shown, whether it follows the lecture)
// and draws the page into any number of places: the small reader in the Slides tab and,
// when the user opens it there, the PDF view in the main picture area. Following turns to
// the page being talked about; paging by hand pauses it until "back to the page being
// talked about". After a while without a recognised page it says so instead of presenting
// an old page as current.
//
// SlidesPane is the tab: the slide files (add, remove), the small reader with the page's
// times on screen and a "wrong page?" menu, and the chapter list (folded away below the
// reader when there is a PDF). Without slide files it is just the chapter list.
// ===================================================================================

class SlideReader {
  constructor(player) {
    this.player = player;
    this.view = -1;
    this.follow = true;
    this.stale = false;
    this.sample = -1;
    this.targets = new Map();   // name -> { stage, active, token }
    this.infoListeners = new Set();
  }

  get deck() {
    const d = this.player.deck;
    return d && d.pages.length ? d : null;
  }

  // A place to draw pages into: `stage` gets the canvases (and a "not recognised" layer).
  addTarget(name, stage) {
    // The pages go in their own box (which the picture-area view can zoom), the
    // "not recognised" note stays over it at its own size.
    const pages = h('div.rpages');
    stage.append(pages, h('div.rstale', { text: t('pageNotRecognised') }));
    this.targets.set(name, { stage, pages, active: false, token: 0 });
  }

  setActive(name, on) {
    const tg = this.targets.get(name);
    if (!tg || tg.active === on) return;
    tg.active = on;
    if (on && this.deck) {
      if (this.view >= 0) this.drawInto(tg, this.view);
      this.update(this.player.video.currentTime, true);
    }
  }

  get active() {
    for (const tg of this.targets.values()) if (tg.active) return true;
    return false;
  }

  // Returns a function that removes the listener again.
  onInfo(fn) { this.infoListeners.add(fn); return () => this.infoListeners.delete(fn); }

  info() { for (const fn of this.infoListeners) fn(); }

  // Called on time updates while some place shows the reader.
  update(t, force) {
    const deck = this.deck;
    if (!deck || !this.active) return;
    const sample = deck.sampleAt(t);
    // Long without a recognised page: do not keep presenting an old page as current.
    const stale = this.follow && deck.unrecognisedFor(t) > FOLLOW_STALE_SEC;
    const staleChanged = stale !== this.stale;
    this.stale = stale;
    for (const tg of this.targets.values()) tg.stage.classList.toggle('stale', stale);
    if (this.follow) {
      const p = deck.pageAt(t);
      if (p !== this.view || force) this.showPage(p >= 0 ? p : Math.max(0, this.view), force);
      else if (sample !== this.sample || staleChanged) this.info();
    } else if (force) this.showPage(this.view, true);
    this.sample = sample;
  }

  // Manual paging pauses following.
  turn(dir) {
    const deck = this.deck;
    if (!deck) return;
    this.follow = false;
    this.showPage(clamp(this.view + dir, 0, deck.pages.length - 1), true);
  }

  resumeFollow() {
    this.follow = true;
    this.update(this.player.video.currentTime, true);
  }

  showPage(i, force) {
    if (!this.deck || i < 0) return;
    const changed = i !== this.view;
    this.view = i;
    if (changed || force) for (const tg of this.targets.values()) if (tg.active) this.drawInto(tg, i);
    this.info();
  }

  // Draws page i into a place, with a short cross-fade over the previous page.
  drawInto(tg, i) {
    const deck = this.deck;
    const token = ++tg.token;
    const stage = tg.stage;
    const p = deck.pages[i];
    const dpr = window.devicePixelRatio || 1;
    // As wide as fits the place at the page's aspect ratio.
    const ar = p.ar || PAGE_AR_DEFAULT;
    const w = stage.clientWidth || 320;
    const hgt = stage.clientHeight || w * ar;
    // Zoomed in (picture-area view): sharper, up to a canvas the browser handles easily.
    const width = Math.min(4096, Math.max(200, Math.min(w, hgt / ar)) * dpr * (tg.sharp || 1));
    deck.render(i, width).then((src) => {
      if (token !== tg.token) return;
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      c.className = 'rpage';
      tg.pages.append(c);
      requestAnimationFrame(() => c.classList.add('in'));
      const old = [...tg.pages.querySelectorAll('canvas')].filter((x) => x !== c);
      setTimeout(() => { for (const x of old) x.remove(); }, 220);
    }).catch((e) => log.warn('render page:', e && e.message ? e.message : e));
  }

  // "Page 5 of 21 · file" for the page shown.
  label() {
    const deck = this.deck;
    const p = deck.pages[this.view];
    if (!p) return '';
    return t('pageOfN', { n: p.num, total: deck.pages.filter((x) => x.file === p.file).length })
      + (deck.files.length > 1 ? ' · ' + p.file.replace(/\.pdf$/i, '') : '');
  }

  // The following line: following (sure / unsure / stale), or a button back to it.
  // `compact` gives the short wording for the toolbar over the PDF view.
  followElement(compact) {
    const now = this.player.video.currentTime;
    if (!this.follow) return h('button.rback', { text: compact ? t('backToLectureShort') : t('backToLecture'), onclick: () => this.resumeFollow() });
    const state = this.stale ? 'Stale' : this.deck.knownAt(now) ? '' : 'Unsure';
    return h('span.rfollowing', { text: t('following' + state + (compact ? 'Short' : '')) });
  }
}

class SlidesPane {
  constructor(player, el) {
    this.player = player;
    this.el = el;
    this.visible = false;
    this.chapters = [];
    this.dirty = true;
    this.current = -1;
    this.cards = [];
    this.showChapters = false;
    this.d = new Disposer();
    this.reader = player.reader;
    this.deckBox = h('div.sdeck');
    this.readerBox = h('div.reader', { hidden: true });
    this.status = h('div.sstatus', { 'aria-live': 'polite' });
    this.chapToggle = h('button.chaptoggle', { hidden: true, onclick: () => { this.showChapters = !this.showChapters; this.render(); } });
    this.list = h('div.slist');
    el.append(this.deckBox, this.readerBox, this.chapToggle, this.status, this.list);
    this.buildReader();
    this.d.add(this.reader.onInfo(() => { if (this.visible) this.renderPageInfo(); }));
    this.d.listen(this.list, 'click', (e) => {
      const card = e.target.closest('.scard');
      if (card) this.player.seek(this.chapters[+card.dataset.i].start);
    });
  }

  get deck() { return this.reader.deck; }

  buildReader() {
    const r = this.readerBox;
    const stage = h('div.rstage');
    this.reader.addTarget('side', stage);
    this.stage = stage;
    this.prevBtn = h('button.rnav', { 'aria-label': t('prevPage'), title: t('prevPage'), text: '‹', onclick: () => this.reader.turn(-1) });
    this.nextBtn = h('button.rnav', { 'aria-label': t('nextPage'), title: t('nextPage'), text: '›', onclick: () => this.reader.turn(1) });
    this.pageLabel = h('span.rlabel');
    this.mainBtn = h('button.rmain', { onclick: () => this.player.setPdfMain(!this.player.prefs.pdfMain) });
    this.followBox = h('div.rfollow');
    this.timesBox = h('div.rtimes');
    this.fixBox = h('details.rfix');
    r.append(stage, h('div.rbar', null, this.prevBtn, this.pageLabel, this.nextBtn), this.mainBtn, this.followBox, this.timesBox, this.fixBox);
  }

  setChapters(chapters, statusText) {
    this.chapters = chapters;
    this.statusText = statusText;
    this.dirty = true;
    if (this.visible) this.render();
  }

  // The transcript or the slide files changed.
  invalidate() {
    this.dirty = true;
    if (this.visible) this.render();
  }

  show(on) {
    this.visible = on;
    this.reader.setActive('side', on && !!this.deck);
    if (on) this.render();
  }

  renderDeck() {
    const deck = this.player.deck;
    const box = this.deckBox;
    box.textContent = '';
    if (!deck) return;
    const input = h('input', { type: 'file', accept: '.pdf,application/pdf', multiple: true, hidden: true });
    // Failures are shown in this tab (deck.error).
    input.addEventListener('change', guard(() => { if (input.files.length) deck.addFiles(input.files).catch(() => {}); }));
    const files = h('div.sfiles');
    for (const f of deck.files) {
      files.append(h('span.sfile', null, h('span.sfname', { text: f.name, title: f.name }),
        h('button.sfremove', { title: t('removeFile', { name: f.name }), 'aria-label': t('removeFile', { name: f.name }), text: '✕', onclick: () => deck.removeFile(f.hash) })));
    }
    files.append(h('button.sfadd', { text: deck.files.length ? t('addMoreSlides') : t('addSlides'), onclick: () => input.click() }), input);
    let msg = '';
    if (deck.state === 'loading') msg = t('deckLoading');
    else if (deck.state === 'reading') {
      const r = deck.ocr;
      msg = !r ? t('deckWaiting')
        : r.state === 'reading' && !r.engineReady && r.stats.read === 0 ? t('deckLangLoading', { lang: languageName(r.lang), mb: (TESS_LANGS[r.lang].bytes / 1e6).toFixed(1) })
          : t('deckReading', { pct: Math.floor(deck.progress * 100) });
    }
    else if (deck.state === 'error') msg = deck.error;
    else if (!deck.files.length) msg = t('slidesLocal');
    box.append(files);
    if (msg) box.append(h('div.sdmsg', { text: msg }));
  }

  render() {
    this.status.textContent = this.statusText || '';
    this.renderDeck();
    const deck = this.deck;
    this.readerBox.hidden = !deck;
    this.reader.setActive('side', this.visible && !!deck);
    this.chapToggle.hidden = !deck || !this.chapters.length;
    this.chapToggle.textContent = this.showChapters ? t('hideChapters') : t('showChapters', { n: this.chapters.length });
    const listShown = !deck || this.showChapters;
    this.list.hidden = !listShown;
    this.status.hidden = !listShown;
    if (deck) this.reader.update(this.player.video.currentTime, true);
    if (!listShown) return;
    if (!this.dirty) { this.update(this.player.video.currentTime, true); return; }
    this.dirty = false;
    const long = this.player.duration() >= 3600;
    const cues = this.player.cues;
    const index = cues && cues.length ? new CueIndex(cues) : null;
    const frag = document.createDocumentFragment();
    this.cards = this.chapters.map((c, i) => {
      let said = '';
      if (index) {
        // The sentence being spoken when the slide appears, or the next one.
        const k = index.started(c.start);
        const cue = k >= 0 && cues[k].end > c.start ? cues[k] : cues[k + 1];
        if (cue && cue.start < c.end) said = cue.text;
      }
      const img = c.thumb ? h('img', { src: c.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : h('div.noimg');
      const card = h('button.scard', { 'data-i': String(i) },
        img,
        h('div.smeta', null,
          h('div.stitle', null, h('span.sn', { text: t('slideN', { n: i + 1 }) }), h('span.st', { text: fmtTime(c.start, long) + (c.precise ? '' : ' ~') })),
          said ? h('div.ssaid', { text: said }) : null));
      frag.appendChild(card);
      return card;
    });
    this.list.textContent = '';
    this.list.appendChild(frag);
    this.current = -1;
    this.update(this.player.video.currentTime, true);
  }

  // Called on time updates: the chapter highlight (the reader updates itself).
  update(t, force) {
    if (!this.visible || document.hidden || !this.cards.length || this.list.hidden) return;
    const k = chapterIndexAt(this.chapters, t);
    if (k === this.current && !force) return;
    if (this.cards[this.current]) this.cards[this.current].classList.remove('cur');
    this.current = k;
    if (this.cards[k]) {
      this.cards[k].classList.add('cur');
      this.cards[k].scrollIntoView({ block: 'nearest' });
    }
  }

  renderPageInfo() {
    const deck = this.deck;
    const rd = this.reader;
    const i = rd.view;
    const p = deck && deck.pages[i];
    if (!p) return;
    this.pageLabel.textContent = rd.label();
    this.pageLabel.title = p.title || '';
    this.prevBtn.disabled = i <= 0;
    this.nextBtn.disabled = i >= deck.pages.length - 1;
    this.mainBtn.textContent = this.player.prefs.pdfMain ? t('pdfMainClose') : t('pdfMainOpen');

    this.followBox.textContent = '';
    this.followBox.append(rd.followElement());

    const long = this.player.duration() >= 3600;
    const times = deck.timesOf(i);
    this.timesBox.textContent = '';
    if (times.length) {
      this.timesBox.append(h('span.rtl', { text: t('shownAt') }));
      for (const r of times) this.timesBox.append(h('button.rtime', { text: fmtTime(r.start, long), onclick: () => { this.player.seek(r.start); rd.resumeFollow(); } }));
    } else if (deck.state === 'ready') {
      this.timesBox.append(h('span.rtl', { text: t('notFoundInRecording') }));
    }

    // Correction for the part being played.
    const fixed = deck.correctionAt(this.player.video.currentTime);
    this.fixBox.textContent = '';
    this.fixBox.append(h('summary', { text: t('wrongPage') }),
      h('button.rfixbtn', { text: t('useThisPage', { n: p.num }), onclick: () => { deck.correct(this.player.video.currentTime, i); this.fixBox.open = false; rd.resumeFollow(); } }),
      h('button.rfixbtn', { text: t('markNotSlide'), onclick: () => { deck.correct(this.player.video.currentTime, 'none'); this.fixBox.open = false; rd.resumeFollow(); } }));
    if (fixed) {
      this.fixBox.append(h('button.rfixbtn', { text: t('undoCorrection'), onclick: () => { deck.correct(this.player.video.currentTime, null); this.fixBox.open = false; rd.resumeFollow(); } }));
    }
  }

  dispose() {
    this.reader.setActive('side', false);
    this.d.dispose();
  }
}
