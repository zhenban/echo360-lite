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
  // deps: { mount (where the menus live), rail (the progress bar), video, duration(),
  //         seek(t), toast(msg, action, fn) }
  constructor(deps, disposer) {
    this.p = deps;
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
    const seek = this.p.rail;
    this.band = el('div.loopband', { hidden: true },
      el('i.lh.la', { title: tr('loopStart') }), el('i.lh.lb', { title: tr('loopEnd') }),
      el('button.lx', { title: tr('loopClear') + ' (X)', 'aria-label': tr('loopClear'), text: '✕' }));
    seek.append(this.band);
    this.menu = el('div.menu.loopmenu', { hidden: true, role: 'menu' },
      el('button', { 'data-loop': 'a', text: tr('loopFromHere') }),
      el('button', { 'data-loop': 'b', text: tr('loopToHere') }),
      el('button', { 'data-loop': 'x', text: tr('loopClear') }));
    const host = this.p.mount;  // where the other menus live
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
    const seek = this.p.rail;
    const isA = hd.classList.contains('la');
    onDrag(this.d, hd, {
      start: (e) => {
        if (e.button !== 0) return null;
        e.stopPropagation();
        hd.setPointerCapture(e.pointerId);
        return { a: this.a, b: this.b };
      },
      move: (e) => {
        const r = seek.getBoundingClientRect();
        const tm = clamp((e.clientX - r.left) / r.width, 0, 1) * this.p.duration();
        if (isA) this.a = Math.min(tm, this.b - LOOP_MIN_SEC); else this.b = Math.max(tm, this.a + LOOP_MIN_SEC);
        this.render();
      },
      done: (e) => { e.stopPropagation(); this.announce(); },
      // A cancelled drag leaves the loop as it was.
      cancel: (st) => { this.a = st.a; this.b = st.b; this.render(); },
    });
  }

  setA(tm) {
    this.a = clamp(tm, 0, this.p.duration());
    if (this.b != null && this.b - this.a < LOOP_MIN_SEC) this.b = null;
    this.render();
    if (this.active) this.announce(); else this.p.toast(tr('loopStartSet', { time: fmtTime(this.a) }));
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
    this.p.toast(tr('loopCleared'));
  }

  announce() {
    this.p.toast(tr('loopSet', { from: fmtTime(this.a), to: fmtTime(this.b) }), tr('loopClear'), () => this.clear());
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
    this.p.toast(tr('loopOutside', { from: fmtTime(this.a), to: fmtTime(this.b) }), tr('loopClear'), () => this.clear());
  }
}
