// ===================================================================================
// Progress-bar markers for timed items (notes, bookmarks, flags, discussion posts).
// The layer is rebuilt only when the data or the duration changes; hover and click use
// the seek bar's existing pointer handlers via nearest().
// ===================================================================================

class MarkersLayer {
  constructor(el) {
    this.el = el;
    this.items = [];
    this.dur = 0;
  }

  set(items, dur) {
    this.items = items.slice().sort((a, b) => a.time - b.time);
    this.dur = dur;
    this.render();
  }

  render() {
    const el = this.el;
    el.textContent = '';
    if (!this.dur) return;
    const frag = document.createDocumentFragment();
    for (const m of this.items) {
      if (m.time < 0 || m.time > this.dur) continue;
      const i = document.createElement('i');
      i.className = 'mk mk-' + m.kind;
      if (m.color) i.style.background = m.color;
      i.style.left = ((m.time / this.dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    el.appendChild(frag);
  }

  // Closest item within `px` pixels of fraction `f` on a bar `width` pixels wide.
  nearest(f, width, px) {
    if (!this.items.length || !this.dur || !width) return null;
    const t0 = f * this.dur;
    const tol = (px / width) * this.dur;
    let best = null;
    let bestD = tol;
    for (const m of this.items) {
      const dd = Math.abs(m.time - t0);
      if (dd <= bestD) { best = m; bestD = dd; }
      if (m.time > t0 + tol) break;
    }
    return best;
  }
}
