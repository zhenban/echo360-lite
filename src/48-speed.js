// ===================================================================================
// The speed control: the control bar's speed button ("1.5×") opens a popover with the
// current value shown large and one track from SPEED_MIN to SPEED_MAX. The thumb moves
// in 0.05 steps and snaps to the stops (SPEED_STOPS) near it; the labelled stops can be
// tapped. Keys on the track: arrows 0.05, [ and ] (and Page Up / Down) the next stop,
// Home / End the ends. [ and ] also work anywhere in the player (42-keys.js).
//
// deps: { $, pops (Popovers), rate() (current), setRate(r) }
// ===================================================================================

const SPEED_STEP = 0.05;

function fmtRate(r) {
  return String(+r.toFixed(2)) + '×';
}

// The next stop from `current` in direction dir (-1, 1); current if there is none.
function nextSpeed(current, dir) {
  const eps = 0.001;
  if (dir > 0) return SPEED_STOPS.find((s) => s > current + eps) || current;
  for (let i = SPEED_STOPS.length - 1; i >= 0; i--) if (SPEED_STOPS[i] < current - eps) return SPEED_STOPS[i];
  return current;
}

function snapSpeed(v) {
  const stop = SPEED_STOPS.find((s) => Math.abs(s - v) <= SPEED_SNAP);
  if (stop != null) return stop;
  return clamp(Math.round(v / SPEED_STEP) * SPEED_STEP, SPEED_MIN, SPEED_MAX);
}

class SpeedControl {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.button = deps.$('.speed');
    this.pop = deps.pops.create('spdpop', 'dialog', tr('speed'));
    this.build();
    disposer.listen(this.button, 'click', () => deps.pops.toggle(this.pop, this.button, 'above'));
    this.render(deps.rate());
  }

  frac(r) { return (r - SPEED_MIN) / (SPEED_MAX - SPEED_MIN); }

  build() {
    const x = this.x;
    this.value = el('b.spd-val', { 'aria-hidden': 'true' });
    this.thumb = el('div.spd-thumb');
    this.stops = SPEED_STOPS.map((s) => el('i.spd-stop', { style: 'left:' + (this.frac(s) * 100).toFixed(2) + '%' }));
    this.track = el('div.spd-track', {
      role: 'slider', tabindex: '0', 'data-autofocus': true, 'aria-label': tr('speed'),
      'aria-valuemin': String(SPEED_MIN), 'aria-valuemax': String(SPEED_MAX),
    }, el('div.spd-rail'), el('div.spd-fill'), ...this.stops, this.thumb);
    this.labels = SPEED_LABELS.map((s) => el('button', {
      'data-rate': String(s), text: fmtRate(s), style: 'left:' + (this.frac(s) * 100).toFixed(2) + '%',
    }));
    this.pop.el.append(el('div.spd', null,
      el('div.spd-head', null, el('span', { text: tr('speed') }), this.value),
      this.track, el('div.spd-labels', null, ...this.labels)));
    const d = this.d;
    const track = this.track;
    const at = (e) => {
      const r = track.getBoundingClientRect();
      return snapSpeed(SPEED_MIN + clamp((e.clientX - r.left) / r.width, 0, 1) * (SPEED_MAX - SPEED_MIN));
    };
    onDrag(d, track, {
      start: (e) => {
        if (e.button !== 0) return null;
        track.setPointerCapture(e.pointerId);
        track.classList.add('dragging');
        const from = x.rate();
        x.setRate(at(e));
        return { from };
      },
      move: (e) => x.setRate(at(e)),
      done: () => track.classList.remove('dragging'),
      cancel: (st) => { track.classList.remove('dragging'); x.setRate(st.from); },
    });
    d.listen(track, 'keydown', (e) => {
      const r = x.rate();
      const to = {
        ArrowLeft: r - SPEED_STEP, ArrowDown: r - SPEED_STEP, ArrowRight: r + SPEED_STEP, ArrowUp: r + SPEED_STEP,
        '[': nextSpeed(r, -1), PageDown: nextSpeed(r, -1), ']': nextSpeed(r, 1), PageUp: nextSpeed(r, 1),
        Home: SPEED_MIN, End: SPEED_MAX,
      }[e.key];
      if (to == null) return;
      e.preventDefault();
      x.setRate(clamp(Math.round(to * 100) / 100, SPEED_MIN, SPEED_MAX));
    });
    d.listen(this.pop.el, 'click', (e) => {
      const b = e.target.closest('button[data-rate]');
      if (b) x.setRate(+b.dataset.rate);
    });
  }

  render(rate) {
    const text = fmtRate(rate);
    this.button.textContent = text;
    this.button.setAttribute('aria-label', tr('speedNow', { rate: text }));
    this.value.textContent = text;
    this.track.style.setProperty('--f', clamp(this.frac(rate), 0, 1).toFixed(4));
    this.track.setAttribute('aria-valuenow', String(rate));
    this.track.setAttribute('aria-valuetext', text);
    SPEED_STOPS.forEach((s, i) => this.stops[i].classList.toggle('on', Math.abs(s - rate) < 0.001));
    for (const b of this.labels) b.classList.toggle('on', Math.abs(+b.dataset.rate - rate) < 0.001);
  }
}
