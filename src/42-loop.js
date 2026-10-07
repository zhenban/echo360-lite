// ===================================================================================
// A-B loop: play a stretch of the lecture again and again (a derivation, a sentence).
//
// Set the ends with I and O (or right-click the progress bar: "Loop from here" / "Loop to
// here"); X or the band's ✕ ends it. The band on the progress bar shows the stretch and
// its ends can be dragged. Playback jumps back to A when it reaches B from inside the
// stretch; after a jump outside, a notice offers to end the loop (otherwise it loops again
// once playback is back inside).
// ===================================================================================

const LOOP_MIN_SEC = 1;

class ABLoop {
  constructor(player, disposer) {
    this.p = player;
    this.a = null;
    this.b = null;
    this.last = -1;          // time at the previous check
    this.timer = 0;
    this.d = disposer;
    this.d.add(() => clearTimeout(this.timer));
    this.build();
  }

  get active() { return this.a != null && this.b != null; }

  build() {
    const seek = this.p.$('.seek');
    this.band = h('div.loopband', { hidden: true },
      h('i.lh.la', { title: t('loopStart') }), h('i.lh.lb', { title: t('loopEnd') }),
      h('button.lx', { title: t('loopClear') + ' (X)', 'aria-label': t('loopClear'), text: '✕' }));
    seek.append(this.band);
    this.menu = h('div.menu.loopmenu', { hidden: true, role: 'menu' },
      h('button', { 'data-loop': 'a', text: t('loopFromHere') }),
      h('button', { 'data-loop': 'b', text: t('loopToHere') }),
      h('button', { 'data-loop': 'x', text: t('loopClear') }));
    const host = this.p.$('.speedmenu').parentElement;  // where the other menus live
    host.append(this.menu);
    const d = this.d;
    d.listen(this.band.querySelector('.lx'), 'pointerdown', (e) => e.stopPropagation());
    d.listen(this.band.querySelector('.lx'), 'click', (e) => { e.stopPropagation(); this.clear(); });
    for (const hd of this.band.querySelectorAll('.lh')) this.bindHandle(hd);
    let at = 0;
    d.listen(seek, 'contextmenu', (e) => {
      e.preventDefault();
      const r = seek.getBoundingClientRect();
      at = clamp((e.clientX - r.left) / r.width, 0, 1) * this.p.duration();
      const cr = host.getBoundingClientRect();
      this.menu.style.left = clamp(e.clientX - cr.left - 60, 8, cr.width - 200) + 'px';
      this.menu.style.right = 'auto';
      this.menu.querySelector('[data-loop=x]').hidden = !this.active && this.a == null;
      this.menu.hidden = false;
    });
    d.listen(this.menu, 'click', (e) => {
      const b = e.target.closest('[data-loop]');
      if (!b) return;
      e.stopPropagation();
      this.menu.hidden = true;
      if (b.dataset.loop === 'a') this.setA(at);
      else if (b.dataset.loop === 'b') this.setB(at);
      else this.clear();
    });
  }

  // Dragging an end of the band.
  bindHandle(hd) {
    const seek = this.p.$('.seek');
    const isA = hd.classList.contains('la');
    let drag = false;
    this.d.listen(hd, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      hd.setPointerCapture(e.pointerId);
      drag = true;
    });
    this.d.listen(hd, 'pointermove', (e) => {
      if (!drag) return;
      const r = seek.getBoundingClientRect();
      const tm = clamp((e.clientX - r.left) / r.width, 0, 1) * this.p.duration();
      if (isA) this.a = Math.min(tm, this.b - LOOP_MIN_SEC); else this.b = Math.max(tm, this.a + LOOP_MIN_SEC);
      this.render();
    });
    const end = (e) => {
      if (!drag) return;
      drag = false;
      e.stopPropagation();
      this.announce();
    };
    this.d.listen(hd, 'pointerup', end);
    this.d.listen(hd, 'pointercancel', end);
  }

  setA(tm) {
    this.a = clamp(tm, 0, this.p.duration());
    if (this.b != null && this.b - this.a < LOOP_MIN_SEC) this.b = null;
    this.render();
    if (this.active) this.announce(); else this.p.toast(t('loopStartSet', { time: fmtTime(this.a) }));
  }

  setB(tm) {
    const b = clamp(tm, 0, this.p.duration());
    // Without a start, loop from a little before.
    if (this.a == null || b - this.a < LOOP_MIN_SEC) this.a = Math.max(0, b - 10);
    this.b = b;
    this.render();
    this.announce();
    const v = this.p.video;
    if (v.currentTime < this.a || v.currentTime >= this.b) this.p.seek(this.a);
  }

  clear() {
    if (this.a == null && this.b == null) return;
    this.a = null;
    this.b = null;
    clearTimeout(this.timer);
    this.render();
    this.p.toast(t('loopCleared'));
  }

  announce() {
    this.p.toast(t('loopSet', { from: fmtTime(this.a), to: fmtTime(this.b) }), t('loopClear'), () => this.clear());
  }

  render() {
    const dur = this.p.duration();
    const band = this.band;
    if (this.a == null || !dur) { band.hidden = true; return; }
    const b = this.b == null ? this.a : this.b;
    band.hidden = false;
    band.classList.toggle('open', this.b == null);
    band.style.left = ((this.a / dur) * 100).toFixed(3) + '%';
    band.style.width = (((b - this.a) / dur) * 100).toFixed(3) + '%';
  }

  // Called on every time update: back to A when playback reaches B from inside.
  tick(tm) {
    const last = this.last;
    this.last = tm;
    if (!this.active) return;
    const v = this.p.video;
    if (v.seeking || v.paused) return;
    if (last >= this.a - 0.5 && last < this.b && tm >= this.b - 0.05) {
      this.p.seek(this.a);
      this.last = this.a;
      return;
    }
    // Time updates come about four times a second: aim the jump closer to B.
    const left = (this.b - tm) / (v.playbackRate || 1);
    clearTimeout(this.timer);
    if (tm >= this.a && left > 0 && left < 0.4) {
      this.timer = setTimeout(guard(() => { if (this.active && !v.paused && !v.seeking) this.tick(v.currentTime); }), left * 1000);
    }
  }

  // A seek by the user: outside the loop, offer to end it.
  seeked(target) {
    if (!this.active || (target >= this.a - 0.5 && target < this.b)) return;
    this.last = target;
    this.p.toast(t('loopOutside', { from: fmtTime(this.a), to: fmtTime(this.b) }), t('loopClear'), () => this.clear());
  }
}
