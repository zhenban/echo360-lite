// ===================================================================================
// Arranging the two pictures by hand: the divider between them (side by side) and the
// small picture-in-picture window (drag to move, snapping to the nearest corner; the grip
// resizes; a click swaps the pictures). Which layout is used, and loading the streams for
// it, is the player's (applyLayout); this only moves and sizes.
//
// deps: { $, stage, prefs (ratio, pipw, corner), savePrefs(), ui { dragging }, armIdle(),
//         redrawPdf(), onPipClick() }
// ===================================================================================

class LayoutControls {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.bindDivider();
    this.bindPip();
  }

  setRatio(r) {
    const x = this.x;
    x.prefs.ratio = clamp(r, 0.2, 0.8);
    x.stage.style.setProperty('--ratio', x.prefs.ratio.toFixed(4));
  }

  bindDivider() {
    const x = this.x;
    const divider = x.$('.divider');
    let stageRect = null;
    const finish = () => {
      divider.classList.remove('dragging');
      x.ui.dragging = false;
      x.armIdle();
    };
    onDrag(this.d, divider, {
      start: (e) => {
        if (e.button !== 0) return null;
        e.stopPropagation();
        stageRect = x.stage.getBoundingClientRect();
        divider.setPointerCapture(e.pointerId);
        divider.classList.add('dragging');
        x.ui.dragging = true;
        return { from: x.prefs.ratio };
      },
      move: (e) => this.setRatio((e.clientX - stageRect.left) / stageRect.width),
      done: () => { finish(); x.savePrefs(); x.redrawPdf(); },
      cancel: (st) => { this.setRatio(st.from); finish(); },
    });
    this.d.listen(divider, 'dblclick', () => { this.setRatio(0.5); x.savePrefs(); });
    this.d.listen(divider, 'keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        this.setRatio(x.prefs.ratio + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
        x.savePrefs();
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  // While dragging, both the frame and the picture in it are moved.
  bindPip() {
    const x = this.x;
    const st = x.stage;
    const frame = x.$('.pipframe');
    const grip = x.$('.grip');
    const pipEls = () => [frame, x.stage.querySelector('.views [data-slot=secondary]')].filter(Boolean);
    const setWidth = (w) => {
      x.prefs.pipw = w;
      st.style.setProperty('--pipw', w.toFixed(4));
    };
    const finish = () => {
      x.ui.dragging = false;
      frame.classList.remove('dragging');
      for (const elem of pipEls()) elem.style.transform = '';
    };
    onDrag(this.d, frame, {
      start: (e) => {
        if (e.button !== 0) return null;
        e.stopPropagation();
        frame.setPointerCapture(e.pointerId);
        x.ui.dragging = true;
        return { x: e.clientX, y: e.clientY, moved: false, resize: e.target === grip, rect: frame.getBoundingClientRect(), stage: st.getBoundingClientRect(), pipw: x.prefs.pipw };
      },
      move: (e, drag) => {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        frame.classList.add('dragging');
        if (drag.resize) {
          const c = x.prefs.corner;
          const r = drag.rect;
          const w = c === 'br' || c === 'tr' ? r.right - e.clientX : e.clientX - r.left;
          setWidth(clamp(w / drag.stage.width, 0.15, 0.6));
        } else {
          for (const elem of pipEls()) elem.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        }
      },
      done: (e, was) => {
        finish();
        // A tap swaps the two pictures (with the PDF shown: the PDF and the video).
        if (!was.moved) { x.onPipClick(); return; }
        if (was.resize) x.redrawPdf();
        else {
          const cx = was.rect.left + was.rect.width / 2 + (e.clientX - was.x);
          const cy = was.rect.top + was.rect.height / 2 + (e.clientY - was.y);
          const right = cx > was.stage.left + was.stage.width / 2;
          const bottom = cy > was.stage.top + was.stage.height / 2;
          x.prefs.corner = (bottom ? 'b' : 't') + (right ? 'r' : 'l');
          for (const c of CORNERS) st.classList.toggle('c-' + c, c === x.prefs.corner);
        }
        x.savePrefs();
        x.armIdle();
      },
      // Cancelled (a touch the browser took over): nothing happened, not a tap.
      cancel: (was) => {
        if (was.resize) setWidth(was.pipw);
        finish();
        x.armIdle();
      },
    });
  }
}
