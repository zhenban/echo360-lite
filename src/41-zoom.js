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
    this.map = h('div.zmap', { hidden: true, 'aria-hidden': 'true' }, h('i'));
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
  targetOf(el) {
    if (!el || !el.closest) return null;
    const stage = el.tagName === 'VIDEO' ? null : el.closest('.pstage');
    const t = el.tagName === 'VIDEO' ? el : stage && stage.querySelector('.rpages');
    return t && this.host.contains(t) && this.canZoom(t) ? t : null;
  }

  get(el) { return this.state.get(el) || { s: 1, cx: 0.5, cy: 0.5 }; }

  zoomed(el) { return this.get(el).s > 1.001; }

  // Zooms `el` by `factor` keeping the point at (fx, fy) (fractions of the element) still.
  zoomAt(el, factor, fx, fy) {
    const z = this.get(el);
    const s = clamp(z.s * factor, 1, ZOOM_MAX);
    // The content point under the pointer before, and where it must stay.
    const px = z.cx + (fx - 0.5) / z.s;
    const py = z.cy + (fy - 0.5) / z.s;
    this.set(el, s, px - (fx - 0.5) / s, py - (fy - 0.5) / s);
  }

  set(el, s, cx, cy) {
    const half = 0.5 / s;
    const z = { s, cx: clamp(cx, half, 1 - half), cy: clamp(cy, half, 1 - half) };
    if (s <= 1.001) this.state.delete(el); else this.state.set(el, z);
    this.apply(el);
    this.onChange();
  }

  reset(el) { if (this.state.has(el)) this.set(el, 1, 0.5, 0.5); }

  resetAll() { for (const el of [...this.state.keys()]) this.reset(el); }

  apply(el) {
    const z = this.get(el);
    if (z.s <= 1.001) {
      el.style.transform = '';
      el.style.clipPath = '';
      el.style.transformOrigin = '';
      el.classList.remove('zoomed');
    } else {
      const W = el.offsetWidth;
      const H = el.offsetHeight;
      const tx = W / 2 - z.s * z.cx * W;
      const ty = H / 2 - z.s * z.cy * H;
      el.style.transformOrigin = '0 0';
      el.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + z.s.toFixed(4) + ')';
      // The clip is in the element's own (unscaled) coordinates: the visible part only.
      const l = -tx / z.s;
      const tp = -ty / z.s;
      el.style.clipPath = 'inset(' + tp.toFixed(1) + 'px ' + (W - l - W / z.s).toFixed(1) + 'px ' + (H - tp - H / z.s).toFixed(1) + 'px ' + l.toFixed(1) + 'px)';
      el.classList.add('zoomed');
    }
    this.renderMap(el);
  }

  // Re-applies after the element was resized (layout change, divider, window).
  refresh() { for (const el of this.state.keys()) this.apply(el); }

  renderMap(el) {
    const m = this.map;
    if (!this.zoomed(el)) {
      if (this.mapFor === el) { m.hidden = true; this.mapFor = null; }
      return;
    }
    this.mapFor = el;
    const z = this.get(el);
    const W = el.offsetWidth;
    const H = el.offsetHeight;
    // Where the view is inside the host, without the zoom transform (a video is placed in
    // the host directly; the PDF pages inside an untransformed stage).
    let x = el.offsetLeft;
    let y = el.offsetTop;
    if (el.tagName !== 'VIDEO') {
      const r = el.parentElement.getBoundingClientRect();
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
      const el = this.targetOf(e.target);
      if (!el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Pixel deltas from trackpads, line deltas from some mice.
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // The rect spans the whole scaled content: the pointer's position in the content,
      // then in the visible window.
      const z = this.get(el);
      const wx = 0.5 + ((e.clientX - r.left) / r.width - z.cx) * z.s;
      const wy = 0.5 + ((e.clientY - r.top) / r.height - z.cy) * z.s;
      this.zoomAt(el, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), clamp(wx, 0, 1), clamp(wy, 0, 1));
    }, { passive: false });
    d.listen(this.host, 'pointerdown', (e) => {
      const el = this.targetOf(e.target);
      if (!el || e.button !== 0 || !this.zoomed(el)) return;
      this.drag = { el, x: e.clientX, y: e.clientY, z: this.get(el), id: e.pointerId };
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
