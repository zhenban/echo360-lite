// ===================================================================================
// Silences and empty parts during playback: the analysis (62-silence.js), the stretches
// that can be skipped (with the slide analysis' empty screens), the Skip button and
// automatic skipping, "the lecture has ended" at an empty ending, and the silence part of
// the audio menu.
//
// deps: { $, lesson, video, sources, prefs (prefs.silence), savePrefs(), seek(t),
//         duration(), toast(msg, action, fn), ui { dragging }, uniform() (empty screen
//         stretches from the slide analysis), onSkips(skips, contentEnd) }
// ===================================================================================

class SilenceUi {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    /** @type {SkipStretch[]} skippable stretches, sorted */
    this.skips = [];
    this.contentEnd = null;   // where the lecture's content ends (an empty ending follows), or null
    this.idx = -1;            // stretch the playhead is in
    this.autoSkipped = new Set();
    const av = deps.sources.find((s) => s.av);
    const p = deps.prefs.silence;
    this.analyzer = new SilenceAnalyzer({
      lesson: deps.lesson,
      video: deps.video,
      masterUrl: av ? av.av : null,
      disposer: disposer.child(),
      onChange: () => { if (!this.d.disposed) { this.update(); this.renderMenu(); } },
    });
    this.analyzer.options = { minSec: p.min, sensitivity: p.sens };
    this.d.add(() => { clearTimeout(this.skipTimer); clearTimeout(this.endTimer); });
    this.bind();
    this.renderMenu();
  }

  bind() {
    const x = this.x;
    const d = this.d;
    const p = x.prefs.silence;
    d.listen(x.$('.endskip'), 'click', (e) => { e.stopPropagation(); this.hideEnd(); x.seek(x.duration()); });
    d.listen(x.$('.endstop'), 'click', (e) => { e.stopPropagation(); this.hideEnd(); x.video.pause(); });
    d.listen(x.$('.endclose'), 'click', (e) => { e.stopPropagation(); this.hideEnd(); });
    d.listen(x.$('.skipsil'), 'click', (e) => {
      e.stopPropagation();
      const s = this.skips[this.idx];
      this.hideSkip();
      if (s) x.seek(s.end);
    });
    const menu = x.$('.audiomenu');
    d.listen(menu.querySelector('[data-sil=auto]'), 'click', (e) => {
      e.stopPropagation();
      p.auto = !p.auto;
      x.savePrefs();
      this.renderMenu();
    });
    d.listen(menu.querySelector('.silmin'), 'click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button[data-min]');
      if (!b) return;
      p.min = +b.dataset.min;
      x.savePrefs();
      this.analyzer.setOptions({ minSec: p.min });
    });
    d.listen(menu.querySelector('.silsens'), 'click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button[data-sens]');
      if (!b) return;
      p.sens = b.dataset.sens;
      x.savePrefs();
      this.analyzer.setOptions({ sensitivity: p.sens });
    });
  }

  // The transcript is known ([] when there is none): silences from it, else from the audio.
  start(cues) { this.analyzer.start(cues); }

  skipAt(t) { return this.skips[silenceIndexAt(this.skips, t)] || null; }

  // Stretches that can be skipped (silences, empty screen) and where the content ends.
  update() {
    const x = this.x;
    const a = this.analyzer;
    const audioKnown = a.source === 'transcript' || a.source === 'audio';
    this.skips = skipStretches(a.silences, x.uniform(), audioKnown, x.prefs.silence.min);
    const dur = x.duration();
    this.contentEnd = dur ? contentEndAt(this.skips, dur) : null;
    // New results (the analysis refines them as it goes) must not pop the button up again.
    this.idx = silenceIndexAt(this.skips, x.video.currentTime);
    x.onSkips(this.skips, this.contentEnd);
  }

  renderMenu() {
    const a = this.analyzer;
    const p = this.x.prefs.silence;
    const total = a.silences.reduce((n, s) => n + s.end - s.start, 0);
    const found = a.silences.length
      ? tr(a.source === 'transcript' ? 'silenceFromTranscript' : 'silenceFound', { n: a.silences.length, time: fmtTime(total) })
      : tr('silenceNone', { min: p.min < 60 ? p.min + ' s' : p.min / 60 + ' min' });
    let status;
    if (a.source === 'pending') status = tr('silenceWaiting');
    else if (a.source === 'unavailable') status = tr(a.reason === 'saveData' ? 'silenceSaveData' : 'silenceUnavailable');
    else if (a.source === 'audio' && a.progress < 1) status = tr('silenceAnalysing', { pct: Math.floor(a.progress * 100) }) + (a.silences.length ? ' ' + found : '');
    else status = found;
    const menu = this.x.$('.audiomenu');
    menu.querySelector('.silstatus').textContent = status;
    const auto = menu.querySelector('[data-sil=auto]');
    auto.setAttribute('aria-checked', String(p.auto));
    auto.querySelector('.state').textContent = p.auto ? tr('on') : tr('off');
    for (const b of menu.querySelectorAll('.silmin button')) b.setAttribute('aria-checked', String(+b.dataset.min === p.min));
    for (const b of menu.querySelectorAll('.silsens button')) b.setAttribute('aria-checked', String(b.dataset.sens === p.sens));
    // Sensitivity only matters when the audio itself is measured.
    menu.querySelector('.sens').hidden = a.source !== 'audio';
  }

  // On every time update: entering a silence offers to skip it (or skips it, if the user
  // turned that on). Only playback running into a silence skips automatically; seeking
  // into one just shows the button.
  tick(ct) {
    const x = this.x;
    const list = this.skips;
    if (!list.length && this.idx === -1) return;
    const i = silenceIndexAt(list, ct);
    if (i === this.idx) return;
    this.idx = i;
    const s = list[i];
    if (!s) { this.hideSkip(); this.hideEnd(); return; }
    const ranInto = !x.video.seeking && !x.ui.dragging && ct - s.start < 2;
    // The empty stretch at the end: the lecture is over.
    if (s.start === this.contentEnd) { this.hideSkip(); if (ranInto || ct - s.start < 15) this.showEnd(); return; }
    if (s.end - ct < 5) { this.hideSkip(); return; }
    // An empty screen with unknown audio is never skipped automatically.
    if (x.prefs.silence.auto && s.kind !== 'black' && ranInto && !this.autoSkipped.has(s.start)) {
      this.autoSkipped.add(s.start);
      const from = ct;
      this.hideSkip();
      x.seek(s.end);
      x.toast(tr(s.kind === 'blank' ? 'skippedBlank' : 'skippedSilence', { time: fmtTime(s.end - from) }), tr('undo'), () => x.seek(from));
      return;
    }
    this.showSkip(s, ct);
  }

  showSkip(s, ct) {
    const btn = this.x.$('.skipsil');
    btn.textContent = tr(s.kind === 'silence' ? 'skipSilence' : 'skipBlank', { time: fmtTime(s.end - ct) });
    btn.classList.remove('fade');
    btn.tabIndex = 0;
    clearTimeout(this.skipTimer);
    this.skipTimer = setTimeout(guard(() => this.hideSkip()), 6000);
  }

  hideSkip() {
    const btn = this.x.$('.skipsil');
    btn.classList.add('fade');
    btn.tabIndex = -1;
    clearTimeout(this.skipTimer);
  }

  // "The lecture has ended": jump to the end (finishing it) or stop here.
  showEnd() {
    this.x.$('.endnote').hidden = false;
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(guard(() => this.hideEnd()), 20000);
  }

  hideEnd() {
    this.x.$('.endnote').hidden = true;
    clearTimeout(this.endTimer);
  }
}
