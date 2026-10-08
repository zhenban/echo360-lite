// ===================================================================================
// Zoom and pan inside a view (the screen video, the camera, or the PDF in the picture
// area): the wheel or a trackpad pinch zooms around the pointer, dragging pans, a double
// click returns to the whole picture. The element keeps its place in the layout; only a
// transform and a clip are set on it, so playback, Web Audio and the layouts are untouched.
// While zoomed in, a small overview in the view's corner shows which part is visible.
// ===================================================================================

const ZOOM_MAX = 8;

class Zoomer {
  // host: the element the views live in (.views); opts.onChange() after any change.
  constructor(host, disposer, opts) {
    this.host = host;
    this.d = disposer;
    this.onChange = (opts && opts.onChange) || (() => {});
    this.canZoom = (opts && opts.canZoom) || (() => true);
    this.state = new Map();     // element -> { s, cx, cy }
    this.drag = null;
    this.dragged = false;       // a pan just ended (the click that follows is not a play toggle)
    this.map = el('div.zmap', { hidden: true, 'aria-hidden': 'true' }, el('i'));
    this.mapFor = null;
    host.append(this.map);
    this.bind();
    // Sizes change with the layout, the divider and the window: keep the view in place.
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this.refresh());
      ro.observe(host);
      this.d.add(() => ro.disconnect());
    }
  }

  // The zoomable element at an event's target (a video or the PDF stage).
  targetOf(elem) {
    if (!elem || !elem.closest) return null;
    const stage = elem.tagName === 'VIDEO' ? null : elem.closest('.pstage');
    const t = elem.tagName === 'VIDEO' ? elem : stage && stage.querySelector('.rpages');
    return t && this.host.contains(t) && this.canZoom(t) ? t : null;
  }

  get(elem) { return this.state.get(elem) || { s: 1, cx: 0.5, cy: 0.5 }; }

  zoomed(elem) { return this.get(elem).s > 1.001; }

  // Zooms `el` by `factor` keeping the point at (fx, fy) (fractions of the element) still.
  zoomAt(elem, factor, fx, fy) {
    const z = this.get(elem);
    const s = clamp(z.s * factor, 1, ZOOM_MAX);
    // The content point under the pointer before, and where it must stay.
    const px = z.cx + (fx - 0.5) / z.s;
    const py = z.cy + (fy - 0.5) / z.s;
    this.set(elem, s, px - (fx - 0.5) / s, py - (fy - 0.5) / s);
  }

  set(elem, s, cx, cy) {
    const half = 0.5 / s;
    const z = { s, cx: clamp(cx, half, 1 - half), cy: clamp(cy, half, 1 - half) };
    if (s <= 1.001) this.state.delete(elem); else this.state.set(elem, z);
    this.apply(elem);
    this.onChange();
  }

  reset(elem) { if (this.state.has(elem)) this.set(elem, 1, 0.5, 0.5); }

  resetAll() { for (const elem of [...this.state.keys()]) this.reset(elem); }

  apply(elem) {
    const z = this.get(elem);
    if (z.s <= 1.001) {
      elem.style.transform = '';
      elem.style.clipPath = '';
      elem.style.transformOrigin = '';
      elem.classList.remove('zoomed');
    } else {
      const W = elem.offsetWidth;
      const H = elem.offsetHeight;
      const tx = W / 2 - z.s * z.cx * W;
      const ty = H / 2 - z.s * z.cy * H;
      elem.style.transformOrigin = '0 0';
      elem.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + z.s.toFixed(4) + ')';
      // The clip is in the element's own (unscaled) coordinates: the visible part only.
      const l = -tx / z.s;
      const tp = -ty / z.s;
      elem.style.clipPath = 'inset(' + tp.toFixed(1) + 'px ' + (W - l - W / z.s).toFixed(1) + 'px ' + (H - tp - H / z.s).toFixed(1) + 'px ' + l.toFixed(1) + 'px)';
      elem.classList.add('zoomed');
    }
    this.renderMap(elem);
  }

  // Re-applies after the element was resized (layout change, divider, window).
  refresh() { for (const elem of this.state.keys()) this.apply(elem); }

  renderMap(elem) {
    const m = this.map;
    if (!this.zoomed(elem)) {
      if (this.mapFor === elem) { m.hidden = true; this.mapFor = null; }
      return;
    }
    this.mapFor = elem;
    const z = this.get(elem);
    const W = elem.offsetWidth;
    const H = elem.offsetHeight;
    // Where the view is inside the host, without the zoom transform (a video is placed in
    // the host directly; the PDF pages inside an untransformed stage).
    let x = elem.offsetLeft;
    let y = elem.offsetTop;
    if (elem.tagName !== 'VIDEO') {
      const r = elem.parentElement.getBoundingClientRect();
      const hr = this.host.getBoundingClientRect();
      x = r.left - hr.left;
      y = r.top - hr.top;
    }
    const mw = Math.min(140, W * 0.25);
    const mh = (mw * H) / W;
    m.hidden = false;
    m.style.width = mw + 'px';
    m.style.height = mh + 'px';
    // Bottom right of the view, clear of the title bar, toolbars and the controls.
    m.style.left = (x + W - mw - 12) + 'px';
    m.style.top = Math.max(y + 64, y + H - mh - 96) + 'px';
    const r = m.firstChild;
    r.style.left = ((z.cx - 0.5 / z.s) * 100).toFixed(2) + '%';
    r.style.top = ((z.cy - 0.5 / z.s) * 100).toFixed(2) + '%';
    r.style.width = (100 / z.s).toFixed(2) + '%';
    r.style.height = (100 / z.s).toFixed(2) + '%';
  }

  bind() {
    const d = this.d;
    d.listen(this.host, 'wheel', (e) => {
      const elem = this.targetOf(e.target);
      if (!elem) return;
      e.preventDefault();
      const r = elem.getBoundingClientRect();
      // Pixel deltas from trackpads, line deltas from some mice.
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // The rect spans the whole scaled content: the pointer's position in the content,
      // then in the visible window.
      const z = this.get(elem);
      const wx = 0.5 + ((e.clientX - r.left) / r.width - z.cx) * z.s;
      const wy = 0.5 + ((e.clientY - r.top) / r.height - z.cy) * z.s;
      this.zoomAt(elem, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), clamp(wx, 0, 1), clamp(wy, 0, 1));
    }, { passive: false });
    d.listen(this.host, 'pointerdown', (e) => {
      const elem = this.targetOf(e.target);
      if (!elem || e.button !== 0 || !this.zoomed(elem)) return;
      this.drag = { el: elem, x: e.clientX, y: e.clientY, z: this.get(elem), id: e.pointerId };
      this.dragged = false;
    });
    d.listen(this.host, 'pointermove', (e) => {
      const g = this.drag;
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!this.dragged && Math.hypot(dx, dy) < 4) return;
      if (!this.dragged) {
        this.dragged = true;
        g.el.classList.add('panning');
        // Captured once it is a drag (a plain click must still reach the picture), so the
        // drag works wherever the player is, also in a floating window.
        try { this.host.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      const W = g.el.offsetWidth;
      const H = g.el.offsetHeight;
      this.set(g.el, g.z.s, g.z.cx - dx / (W * g.z.s), g.z.cy - dy / (H * g.z.s));
    });
    const end = () => {
      if (!this.drag) return;
      this.drag.el.classList.remove('panning');
      this.drag = null;
      // The click event comes right after; it reads `dragged` and then it is cleared.
      setTimeout(() => { this.dragged = false; }, 0);
    };
    d.listen(this.host, 'pointerup', end);
    d.listen(this.host, 'pointercancel', end);
  }
}
