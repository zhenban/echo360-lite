// ===================================================================================
// Slides tab of the side panel: one card per chapter (picture, time, the first sentence
// spoken on it). The current chapter is highlighted and kept in view. Cards are rebuilt
// only when the chapter list changes and the tab is visible.
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
    this.d = new Disposer();
    this.status = h('div.sstatus', { 'aria-live': 'polite' });
    this.list = h('div.slist');
    el.append(this.status, this.list);
    this.d.listen(this.list, 'click', (e) => {
      const card = e.target.closest('.scard');
      if (card) this.player.seek(this.chapters[+card.dataset.i].start);
    });
  }

  setChapters(chapters, statusText) {
    this.chapters = chapters;
    this.statusText = statusText;
    this.dirty = true;
    if (this.visible) this.render();
  }

  // The transcript arrived: the "first sentence" lines need a rebuild.
  invalidate() {
    this.dirty = true;
    if (this.visible) this.render();
  }

  show(on) {
    this.visible = on;
    if (on) this.render();
  }

  render() {
    this.status.textContent = this.statusText || '';
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

  update(t, force) {
    if (!this.visible || !this.cards.length || document.hidden) return;
    const k = chapterIndexAt(this.chapters, t);
    if (k === this.current && !force) return;
    if (this.cards[this.current]) this.cards[this.current].classList.remove('cur');
    this.current = k;
    if (this.cards[k]) {
      this.cards[k].classList.add('cur');
      this.cards[k].scrollIntoView({ block: 'nearest' });
    }
  }

  dispose() {
    this.d.dispose();
  }
}
