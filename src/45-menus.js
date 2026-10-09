// ===================================================================================
// The control bar's menus: speed, layout, captions, copy, quality and audio buttons open
// their menu (one at a time, closed by a click elsewhere or Esc); the ⋯ menu (analysis
// results stored, diagnostics, shortcuts). Also what those menus do that belongs to no
// other part: captions on/off and size, copying the picture or what was said.
//
// deps: { $, root, stage, video, prefs, savePrefs(), setRate(r), setLayout(name), cc
//         (CaptionsView), cues() ([] until loaded), screenVideo(), title, duration(),
//         toast(msg), wake(), showKeys(), diagnostics() -> text, onOpen(menu) (quality,
//         audio: draw before showing), onCloseAll() (other popups to close too) }
// ===================================================================================

class MenuBar {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    const $ = deps.$;
    this.menus = [['.speed', '.speedmenu'], ['.layout', '.layoutmenu'], ['.ccbtn', '.ccmenu'], ['.audiobtn', '.audiomenu'],
      ['.qbtn', '.qualitymenu'], ['.copybtn', '.copymenu'], ['.morebtn', '.moremenu']].map(([b, m]) => [$(b), $(m)]);
    this.buildSpeeds();
    this.bind();
  }

  buildSpeeds() {
    const menu = this.x.$('.speedmenu');
    for (const s of SPEEDS) menu.append(el('button', { role: 'menuitemradio', 'data-rate': String(s), text: s + 'x' }));
  }

  anyOpen() {
    return [...this.x.root.querySelectorAll('.menu')].some((m) => !m.hidden);
  }

  closeAll() {
    for (const m of this.x.root.querySelectorAll('.menu')) m.hidden = true;
    this.x.onCloseAll();
  }

  bind() {
    const x = this.x;
    const $ = x.$;
    const d = this.d;
    for (const [btn, menu] of this.menus) {
      d.listen(btn, 'click', (e) => {
        e.stopPropagation();
        const open = menu.hidden;
        for (const [, m] of this.menus) m.hidden = true;
        if (open) {
          if (menu.classList.contains('copymenu')) this.renderCopyMenu();
          if (menu.classList.contains('moremenu')) this.renderMoreMenu();
          x.onOpen(menu);
        }
        menu.hidden = !open;
        x.wake();
      });
    }
    d.listen(x.root, 'click', (e) => {
      if (e.target.closest('.menu, .speed, .layout, .ccbtn, .audiobtn, .qbtn, .copybtn, .morebtn')) return;
      for (const [, m] of this.menus) m.hidden = true;
      x.onCloseAll();
    });
    d.listen($('.speedmenu'), 'click', (e) => {
      const b = e.target.closest('button[data-rate]');
      if (b) { x.setRate(+b.dataset.rate); $('.speedmenu').hidden = true; }
    });
    d.listen($('.layoutmenu'), 'click', (e) => {
      const b = e.target.closest('button[data-layout]');
      if (b) { x.setLayout(b.dataset.layout); $('.layoutmenu').hidden = true; }
    });
    d.listen($('.copymenu'), 'click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button[data-copy], button[data-span]');
      if (!b) return;
      if (b.dataset.span) {
        x.prefs.copySpan = +b.dataset.span;
        x.savePrefs();
        this.renderCopyMenu();
        return;
      }
      $('.copymenu').hidden = true;
      if (b.dataset.copy === 'frame') this.copyFrame(); else this.copyCaptions();
    });
    d.listen($('.cctoggle'), 'click', () => this.setCaptions(!x.cc.on));
    d.listen($('.cchidepaused'), 'click', () => {
      x.prefs.capHidePaused = !x.prefs.capHidePaused;
      x.savePrefs();
      this.renderCaptionMenu();
    });
    d.listen($('.ccmenu .sizes'), 'click', (e) => {
      const b = e.target.closest('button[data-size]');
      if (b) this.setCaptionSize(b.dataset.size);
    });
    d.listen($('.diagclose'), 'click', (e) => { e.stopPropagation(); $('.diagbox').hidden = true; });
    d.listen($('.diagcopy'), 'click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText($('.diagtext').textContent)
        .then(() => x.toast(tr('diagCopied')), (err) => x.toast(tr('copyFailed', { msg: (err && err.message) || err })));
    });
  }

  // ---- speed ----

  renderSpeed(rate) {
    this.x.$('.speed').textContent = rate + 'x';
    for (const b of this.x.root.querySelectorAll('.speedmenu button')) b.setAttribute('aria-checked', String(+b.dataset.rate === rate));
  }

  // ---- captions ----

  setCaptions(on, restoring) {
    const x = this.x;
    x.cc.setOn(on);
    x.cc.update(x.video.currentTime);
    if (!restoring) { x.prefs.captions = on; x.savePrefs(); }
    x.$('.ccbtn').classList.toggle('active', on);
    this.renderCaptionMenu();
  }

  setCaptionSize(size) {
    if (!(size in CAPTION_SIZES)) return;
    this.x.prefs.capSize = size;
    this.x.cc.setSize(size);
    this.x.savePrefs();
    this.renderCaptionMenu();
  }

  renderCaptionMenu() {
    const x = this.x;
    const on = x.cc.on;
    const toggle = x.$('.cctoggle');
    toggle.setAttribute('aria-checked', String(on));
    toggle.querySelector('.state').textContent = on ? tr('on') : tr('off');
    for (const b of x.root.querySelectorAll('.ccmenu .sizes button')) b.setAttribute('aria-checked', String(b.dataset.size === x.prefs.capSize));
    const hide = x.$('.cchidepaused');
    hide.setAttribute('aria-checked', String(!!x.prefs.capHidePaused));
    hide.querySelector('.state').textContent = x.prefs.capHidePaused ? tr('on') : tr('off');
    x.stage.classList.toggle('hidecc-paused', !!x.prefs.capHidePaused);
  }

  // ---- copying (picture, what was said) ----

  renderCopyMenu() {
    const span = this.x.prefs.copySpan || 60;
    for (const b of this.x.root.querySelectorAll('.copymenu [data-span]')) b.setAttribute('aria-checked', String(+b.dataset.span === span));
  }

  // Copies the current picture at the video's own resolution. Must run from a user action.
  copyFrame() {
    const x = this.x;
    const v = x.screenVideo();
    if (!v.videoWidth) { x.toast(tr('copyFailed', { msg: 'no picture yet' })); return; }
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    // The clipboard item is created synchronously (within the user action) from a promise.
    const blob = new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      .then(() => x.toast(tr('copiedFrame', { w: c.width, h: c.height })))
      .catch((e) => x.toast(tr('copyFailed', { msg: (e && e.message) || e })));
  }

  // Copies what was said in the last copySpan seconds, in whole sentences, with the
  // lecture's name and the time range.
  copyCaptions() {
    const x = this.x;
    const cues = x.cues();
    if (!cues.length) { x.toast(tr('copyNoCaptions')); return; }
    const ex = captionExcerpt(cues, x.video.currentTime, x.prefs.copySpan || 60);
    if (!ex) { x.toast(tr('copyNoCaptions')); return; }
    const long = x.duration() >= 3600;
    const from = fmtTime(ex.start, long);
    const to = fmtTime(ex.end, long);
    const text = x.title + '\n' + from + '–' + to + '\n\n' + ex.text + '\n';
    navigator.clipboard.writeText(text)
      .then(() => x.toast(tr('copiedCaptions', { from, to })))
      .catch((e) => x.toast(tr('copyFailed', { msg: (e && e.message) || e })));
  }

  // ---- the ⋯ menu: analysis results stored on this device (size, clear), diagnostics, keys ----

  renderMoreMenu() {
    const x = this.x;
    const m = x.$('.moremenu');
    m.textContent = '';
    const size = el('span.grow', { text: tr('cachesMeasuring') });
    const clear = el('button', { text: tr('cachesClear') });
    clear.addEventListener('click', guard(async (e) => {
      e.stopPropagation();
      clear.disabled = true;
      const n = await analysisCaches.clear();
      size.textContent = tr('cachesCleared', { n });
    }));
    m.append(el('div.head', { text: 'Lite Player for Echo360 ' + VERSION }),
      el('div.row', { title: tr('cachesInfo') }, size, clear),
      el('button', { text: tr('diagMenu'), onclick: (e) => { e.stopPropagation(); m.hidden = true; this.showDiagnostics(); } }),
      el('button', { text: tr('keysTitle') + ' (?)', onclick: (e) => { e.stopPropagation(); m.hidden = true; x.showKeys(); } }));
    analysisCaches.usage().then((u) => {
      size.textContent = tr('cachesSize', { mb: (u.bytes / 1e6).toFixed(u.bytes < 1e7 ? 1 : 0), n: u.count });
    }).catch(() => { size.textContent = tr('cachesUnknown'); });
  }

  get diagnosticsOpen() { return !this.x.$('.diagbox').hidden; }

  showDiagnostics(on) {
    const x = this.x;
    if (on === false) { x.$('.diagbox').hidden = true; return; }
    x.$('.diagtext').textContent = x.diagnostics();
    x.$('.diagbox').hidden = false;
    x.$('.diagcopy').focus();
  }
}
