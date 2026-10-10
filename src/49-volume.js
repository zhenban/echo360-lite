// ===================================================================================
// The volume control: a speaker button that mutes and unmutes (its icon follows the
// level: muted, low, high), and a slider that the stylesheet shows only while a mouse is
// over the control or the keyboard focus is on it (touch screens never show it; devices
// there have volume keys). The mouse wheel over the control changes the volume; changes
// by the wheel or the arrow keys show the level on the picture for a moment.
//
// deps: { $, video }
// ===================================================================================

class VolumeControl {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.button = deps.$('.mute');
    this.input = deps.$('.volume');
    this.osd = deps.$('.volosd');
    this.wheelSum = 0;
    this.osdTimer = 0;
    disposer.add(() => clearTimeout(this.osdTimer));
    const v = deps.video;
    disposer.listen(this.button, 'click', () => this.toggleMute());
    disposer.listen(this.input, 'input', () => { v.volume = +this.input.value; v.muted = v.volume === 0; });
    disposer.listen(deps.$('.vol'), 'wheel', (e) => this.onWheel(e), { passive: false });
    this.render();
  }

  // A muted (or zero) volume comes back at the last level, or half when there is none.
  toggleMute() {
    const v = this.x.video;
    if (v.muted || v.volume === 0) {
      v.muted = false;
      if (v.volume === 0) v.volume = 0.5;
    } else v.muted = true;
  }

  // Changes the volume by dv; show: put the new level on the picture (keys and wheel).
  by(dv, show) {
    const v = this.x.video;
    if (dv > 0) v.muted = false;
    v.volume = clamp(Math.round((v.volume + dv) * 100) / 100, 0, 1);
    if (show) this.showLevel();
  }

  // One mouse-wheel notch is one step, whatever distance the browser reports for it (53 to
  // 120 px, or 3 lines); a touchpad's many small deltas add up to VOLUME_WHEEL_PX per step.
  // Up is louder.
  onWheel(e) {
    e.preventDefault();
    const raw = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    const px = clamp(raw, -VOLUME_WHEEL_PX, VOLUME_WHEEL_PX);
    if (Math.sign(px) !== Math.sign(this.wheelSum)) this.wheelSum = 0;
    this.wheelSum += px;
    const steps = Math.trunc(this.wheelSum / VOLUME_WHEEL_PX);
    if (!steps) return;
    this.wheelSum -= steps * VOLUME_WHEEL_PX;
    this.by(-steps * VOLUME_STEP, true);
  }

  level() {
    const v = this.x.video;
    return v.muted ? 0 : v.volume;
  }

  showLevel() {
    const level = this.level();
    this.osd.textContent = level ? tr('volumeLevel', { pct: Math.round(level * 100) }) : tr('muted');
    this.osd.classList.add('on');
    clearTimeout(this.osdTimer);
    this.osdTimer = setTimeout(guard(() => this.osd.classList.remove('on')), VOLUME_OSD_MS);
  }

  render() {
    const level = this.level();
    const silent = level === 0;
    const b = this.button;
    b.innerHTML = svg(silent ? 'muted' : level < 0.5 ? 'volumeLow' : 'volume');
    b.setAttribute('aria-label', tr(silent ? 'unmute' : 'mute'));
    b.dataset.tip = tr(silent ? 'unmuteKey' : 'muteKey');
    this.input.value = String(level);
    this.input.setAttribute('aria-valuetext', Math.round(level * 100) + '%');
    this.input.style.setProperty('--v', level * 100 + '%');
  }
}
