// ===================================================================================
// Slides tab of the side panel.
//
// Without slide files: one card per chapter (picture, time, the first sentence spoken on
// it), the current one highlighted and kept in view.
//
// With the lecturer's PDF (added here or dropped on the player): a reader that follows the
// lecture, turning to the page being talked about. Paging by hand pauses following; a
// button brings it back. Each page lists when it was on screen (click to jump there), and
// a small menu corrects the page for the part being played. The chapter list folds away
// below the reader.
// ===================================================================================

class SlidesPane {
  constructor(player, el) {
    this.player = player;
    this.el = el;
    this.visible = false;
    this.chapters = [];
    this.dirty = true;
    this.current = -1;
    this.cards = [];
    this.view = -1;          // page shown in the reader
    this.follow = true;
    this.showChapters = false;
    this.renderToken = 0;
    this.d = new Disposer();
    this.deckBox = h('div.sdeck');
    this.reader = h('div.reader', { hidden: true });
    this.status = h('div.sstatus', { 'aria-live': 'polite' });
    this.chapToggle = h('button.chaptoggle', { hidden: true, onclick: () => { this.showChapters = !this.showChapters; this.render(); } });
    this.list = h('div.slist');
    el.append(this.deckBox, this.reader, this.chapToggle, this.status, this.list);
    this.buildReader();
    this.d.listen(this.list, 'click', (e) => {
      const card = e.target.closest('.scard');
      if (card) this.player.seek(this.chapters[+card.dataset.i].start);
    });
  }

  get deck() {
    const d = this.player.deck;
    return d && d.pages.length ? d : null;
  }

  buildReader() {
    const r = this.reader;
    this.stage = h('div.rstage');
    this.prevBtn = h('button.rnav', { 'aria-label': t('prevPage'), title: t('prevPage'), text: '‹', onclick: () => this.turn(-1) });
    this.nextBtn = h('button.rnav', { 'aria-label': t('nextPage'), title: t('nextPage'), text: '›', onclick: () => this.turn(1) });
    this.pageLabel = h('span.rlabel');
    this.followBox = h('div.rfollow');
    this.timesBox = h('div.rtimes');
    this.fixBox = h('details.rfix');
    r.append(this.stage, h('div.rbar', null, this.prevBtn, this.pageLabel, this.nextBtn), this.followBox, this.timesBox, this.fixBox);
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
    if (on) { this.view = -1; this.render(); }
  }

  renderDeck() {
    const deck = this.player.deck;
    const box = this.deckBox;
    box.textContent = '';
    if (!deck) return;
    const input = h('input', { type: 'file', accept: '.pdf,application/pdf', multiple: true, hidden: true });
    input.addEventListener('change', guard(() => { if (input.files.length) deck.addFiles(input.files); }));
    const files = h('div.sfiles');
    for (const f of deck.files) {
      files.append(h('span.sfile', null, h('span.sfname', { text: f.name, title: f.name }),
        h('button.sfremove', { title: t('removeFile', { name: f.name }), 'aria-label': t('removeFile', { name: f.name }), text: '✕', onclick: () => deck.removeFile(f.hash) })));
    }
    files.append(h('button.sfadd', { text: deck.files.length ? t('addMoreSlides') : t('addSlides'), onclick: () => input.click() }), input);
    let msg = '';
    if (deck.state === 'loading') msg = t('deckLoading');
    else if (deck.state === 'matching') msg = t('deckMatching', { pct: Math.floor(deck.progress * 100) });
    else if (deck.state === 'error') msg = t('deckError', { msg: deck.error });
    else if (!deck.files.length) msg = t('slidesLocal');
    box.append(files);
    if (msg) box.append(h('div.sdmsg', { text: msg }));
  }

  render() {
    this.status.textContent = this.statusText || '';
    this.renderDeck();
    const deck = this.deck;
    this.reader.hidden = !deck;
    this.chapToggle.hidden = !deck;
    this.chapToggle.textContent = this.showChapters ? t('hideChapters') : t('showChapters', { n: this.chapters.length });
    const listShown = !deck || this.showChapters;
    this.list.hidden = !listShown;
    this.status.hidden = !listShown;
    if (deck) this.updateReader(this.player.video.currentTime, true);
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

  // Called on time updates: chapter highlight and, while following, the reader's page.
  update(t, force) {
    if (!this.visible || document.hidden) return;
    if (this.deck) this.updateReader(t, force);
    if (!this.cards.length || this.list.hidden) return;
    const k = chapterIndexAt(this.chapters, t);
    if (k === this.current && !force) return;
    if (this.cards[this.current]) this.cards[this.current].classList.remove('cur');
    this.current = k;
    if (this.cards[k]) {
      this.cards[k].classList.add('cur');
      this.cards[k].scrollIntoView({ block: 'nearest' });
    }
  }

  updateReader(t, force) {
    const deck = this.deck;
    const chapter = chapterIndexAt(this.chapters, t);
    if (this.follow) {
      const p = deck.pageAt(t);
      if (p !== this.view || force) this.showPage(p >= 0 ? p : Math.max(0, this.view), force);
      else if (chapter !== this.readerChapter) this.renderPageInfo(); // follow hint, correction menu
    } else if (force) this.showPage(this.view, true);
    this.readerChapter = chapter;
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
    this.updateReader(this.player.video.currentTime, true);
  }

  showPage(i, force) {
    const deck = this.deck;
    if (!deck || i < 0) return;
    const changed = i !== this.view;
    this.view = i;
    if (changed || force) this.drawPage(i);
    this.renderPageInfo();
  }

  // Draws page i with a short cross-fade over the previous one.
  drawPage(i) {
    const deck = this.deck;
    const token = ++this.renderToken;
    const width = Math.max(200, this.stage.clientWidth || 320) * (window.devicePixelRatio || 1);
    const p = deck.pages[i];
    this.stage.style.aspectRatio = '1 / ' + (p.ar || 0.5625).toFixed(4);
    deck.render(i, width).then((src) => {
      if (token !== this.renderToken) return;
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      c.className = 'rpage';
      this.stage.append(c);
      requestAnimationFrame(() => c.classList.add('in'));
      const old = [...this.stage.querySelectorAll('canvas')].filter((x) => x !== c);
      setTimeout(() => { for (const x of old) x.remove(); }, 220);
    }).catch((e) => console.warn(TAG, 'render page:', e && e.message ? e.message : e));
  }

  renderPageInfo() {
    const deck = this.deck;
    const i = this.view;
    const p = deck.pages[i];
    const multi = deck.files.length > 1;
    this.pageLabel.textContent = t('pageOfN', { n: p.num, total: deck.pages.filter((x) => x.file === p.file).length })
      + (multi ? ' · ' + p.file.replace(/\.pdf$/i, '') : '');
    this.pageLabel.title = p.title || '';
    this.prevBtn.disabled = i <= 0;
    this.nextBtn.disabled = i >= deck.pages.length - 1;

    this.followBox.textContent = '';
    if (this.follow) this.followBox.append(h('span.rfollowing', { text: deck.knownAt(this.player.video.currentTime) ? t('following') : t('followingUnsure') }));
    else this.followBox.append(h('button.rback', { text: t('backToLecture'), onclick: () => this.resumeFollow() }));

    const long = this.player.duration() >= 3600;
    const times = deck.timesOf(i);
    this.timesBox.textContent = '';
    if (times.length) {
      this.timesBox.append(h('span.rtl', { text: t('shownAt') }));
      for (const r of times) this.timesBox.append(h('button.rtime', { text: fmtTime(r.start, long), onclick: () => { this.player.seek(r.start); this.resumeFollow(); } }));
    } else if (deck.state === 'ready') {
      this.timesBox.append(h('span.rtl', { text: t('notFoundInRecording') }));
    }

    // Correction for the part being played.
    const fixed = deck.correctionAt(this.player.video.currentTime);
    this.fixBox.textContent = '';
    this.fixBox.append(h('summary', { text: t('wrongPage') }),
      h('button.rfixbtn', { text: t('useThisPage', { n: p.num }), onclick: () => { deck.correct(this.player.video.currentTime, i); this.fixBox.open = false; this.resumeFollow(); } }),
      h('button.rfixbtn', { text: t('markNotSlide'), onclick: () => { deck.correct(this.player.video.currentTime, 'none'); this.fixBox.open = false; this.resumeFollow(); } }));
    if (fixed) {
      this.fixBox.append(h('button.rfixbtn', { text: t('undoCorrection'), onclick: () => { deck.correct(this.player.video.currentTime, null); this.fixBox.open = false; this.resumeFollow(); } }));
    }
  }

  dispose() {
    this.d.dispose();
  }
}
