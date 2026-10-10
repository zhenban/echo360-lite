// ===================================================================================
// The progress bar: time label, progress and buffer, dragging and clicking to seek, the
// hover tip (time, marker or skippable stretch, preview picture), and the marks drawn on
// the rail (chapters, skippable stretches, what was watched).
//
// Gets only what it needs (see the player's setupParts):
//   $(sel)          the player's markup
//   video, clock    the clock <video> and its Stream (position while loading)
//   duration()      seconds
//   seek(t)         seek the player
//   isIdle()        controls hidden (nothing to draw)
//   armIdle()       restart the hide timer after a drag
//   markers         MarkersLayer (notes, bookmarks... on the bar)
//   ui              shared { dragging }
//   previewAt(t)    picture URL for the tip, or ''
//   skipAt(t)       the skippable stretch at t, or null
// ===================================================================================

class SeekBar {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.el = deps.$('.seek');
    this.timeCur = deps.$('.cur');
    this.timeDur = deps.$('.dur');
    this.lastSecond = -1;
    this.lastP = -1;
    this.lastB = -1;
    this.bind();
  }

  // Time label, progress and buffer bars. Called at most once per frame, and only while
  // the controls are visible (a forced call draws anyway).
  render(force) {
    const x = this.x;
    if (!force && x.isIdle()) return;
    const v = x.video;
    const dur = x.duration();
    const ct = x.clock.position();
    const sec = Math.floor(ct);
    if (force || sec !== this.lastSecond) {
      this.lastSecond = sec;
      const long = dur >= 3600;
      this.timeCur.textContent = fmtTime(ct, long);
      this.timeDur.textContent = fmtTime(dur, long);
      this.el.setAttribute('aria-valuetext', fmtTime(ct, long));
    }
    if (!dur) return;
    if (!x.ui.dragging) {
      const p = ct / dur;
      if (force || Math.abs(p - this.lastP) > 0.0002) {
        this.lastP = p;
        this.el.style.setProperty('--p', p.toFixed(5));
      }
    }
    const buf = v.buffered;
    let end = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf.start(i) <= ct + 0.5 && buf.end(i) > end) end = buf.end(i);
    }
    const b = end / dur;
    if (force || Math.abs(b - this.lastB) > 0.001) {
      this.lastB = b;
      this.el.style.setProperty('--b', b.toFixed(4));
    }
  }

  // Stretches [{ start, end, kind? }] as marks in the element `sel` (kind other than
  // 'silence' is drawn as an empty part).
  drawStretches(sel, list) {
    const box = this.x.$(sel);
    box.textContent = '';
    const dur = this.x.duration();
    if (!dur) return;
    const frag = document.createDocumentFragment();
    for (const s of list) {
      const i = document.createElement('i');
      if (s.kind && s.kind !== 'silence') i.className = 'empty';
      i.style.left = ((s.start / dur) * 100).toFixed(3) + '%';
      i.style.width = (((Math.min(s.end, dur) - s.start) / dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    box.appendChild(frag);
  }

  renderChapters(chapters) {
    const box = this.x.$('.chaps');
    box.textContent = '';
    const dur = this.x.duration();
    if (!dur) return;
    const frag = document.createDocumentFragment();
    for (const c of chapters) {
      if (c.start <= 0 || c.start >= dur) continue;
      const i = document.createElement('i');
      i.style.left = ((c.start / dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    box.appendChild(frag);
  }

  renderSkips(skips) { this.drawStretches('.sils', skips); }

  // Stretches watched on this device (earlier visits and this one), faint on the rail.
  renderWatched(ranges) { this.drawStretches('.wat', ranges.map(([start, end]) => ({ start, end }))); }

  bind() {
    const x = this.x;
    const d = this.d;
    const seekEl = this.el;
    const tip = x.$('.tip');
    const tipText = tip.querySelector('.tt');
    const tipLabel = tip.querySelector('.tl');
    const tipImg = tip.querySelector('.pv');
    let rect = null;
    let lastSeekAt = 0;
    const frac = (cx) => clamp((cx - rect.left) / rect.width, 0, 1);
    let nearMarker = null;
    let downX = 0;
    const hover = (e) => {
      if (!rect) rect = seekEl.getBoundingClientRect();
      const f = frac(e.clientX);
      const dur = x.duration();
      seekEl.style.setProperty('--h', f.toFixed(4));
      nearMarker = x.markers.nearest(f, rect.width, 6);
      const sil = nearMarker ? null : x.skipAt(f * dur);
      tipText.textContent = fmtTime(nearMarker ? nearMarker.time : f * dur, dur >= 3600);
      tipLabel.textContent = nearMarker ? (nearMarker.label.length > 70 ? nearMarker.label.slice(0, 67) + '…' : nearMarker.label)
        : sil ? tr(sil.kind + 'Tip', { time: fmtTime(sil.end - sil.start) }) : '';
      const pv = x.previewAt(nearMarker ? nearMarker.time : f * dur);
      if (pv) { if (tipImg.getAttribute('src') !== pv) tipImg.src = pv; tipImg.hidden = false; } else tipImg.hidden = true;
      const half = pv ? 96 : 24;
      tip.style.left = clamp(f * rect.width, half, rect.width - half) + 'px';
      return f;
    };
    d.listen(seekEl, 'pointerenter', () => { rect = seekEl.getBoundingClientRect(); });
    d.listen(seekEl, 'pointermove', (e) => { hover(e); });
    // Dragging: seeks along the way; lifting the finger seeks there (a click next to a
    // marker jumps exactly to the marked time); a cancelled touch goes back to where
    // playback was before.
    onDrag(d, seekEl, {
      start: (e) => {
        if (e.button !== 0) return null;
        rect = seekEl.getBoundingClientRect();
        seekEl.setPointerCapture(e.pointerId);
        downX = e.clientX;
        x.ui.dragging = true;
        seekEl.classList.add('dragging');
        seekEl.style.setProperty('--p', hover(e).toFixed(5));
        return { from: x.clock.position(), moved: false };
      },
      move: (e, st) => {
        const f = frac(e.clientX);
        seekEl.style.setProperty('--p', f.toFixed(5));
        const now = performance.now();
        if (now - lastSeekAt > DRAG_SEEK_MS) { lastSeekAt = now; st.moved = true; x.video.currentTime = f * x.duration(); }
      },
      done: (e) => {
        x.ui.dragging = false;
        seekEl.classList.remove('dragging');
        if (nearMarker && Math.abs(e.clientX - downX) < 4) x.seek(nearMarker.time);
        else x.seek(frac(e.clientX) * x.duration());
        x.armIdle();
      },
      cancel: (st) => {
        x.ui.dragging = false;
        seekEl.classList.remove('dragging');
        if (st.moved) x.seek(st.from);
        this.render(true);
        x.armIdle();
      },
    });
    d.listen(seekEl, 'keydown', (e) => {
      if (e.key === 'Home') { x.seek(0); e.preventDefault(); }
      if (e.key === 'End') { x.seek(x.duration()); e.preventDefault(); }
    });
    d.listen(window, 'resize', () => { rect = null; });
  }
}
