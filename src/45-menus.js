// ===================================================================================
// The control bar's buttons and the settings menu (⋮ in the title bar), built from the
// shared components (32-ui-kit.js).
//
// Control bar: captions (on/off; unavailable with a reason when there are none), copy
// picture, copy text, and the priority overflow: when the bar is too narrow, the buttons in
// BAR_OVERFLOW make way in that order and appear at the top of the ⋮ menu instead; if it is
// still too narrow, the time moves above the progress bar. The bookmark and layout buttons
// are the player's; the speed button is SpeedControl's (48-speed.js).
//
// Settings menu: pages for quality, captions, audio, skipping silence, layout, copy text
// and theme, then actions (floating window, loop, export, shortcuts, storage and
// diagnostics, the original player). Parts give their own pages (deps.pages).
//
// deps: { $, root, pops (Popovers), stage, video, prefs, savePrefs(), cc (CaptionsView),
//         cues() ([] until loaded), screenVideo(), title, duration(), toast(msg),
//         layouts() (offered: [] none), layout(), setLayout(l), swap(), pdfMode(),
//         pages: { quality(), audio(), silence() } (items, see SettingsMenu),
//         values: { quality(), audio(), silence() } (shown next to the pages),
//         actions: { bookmark(e), popout() or null, loopA(), loopB(), loopClear(),
//         loopLabel(), exportNotes() or null, showKeys(), original() }, setTheme(t) }
// ===================================================================================

// Control-bar buttons (data-bar) that move into the ⋮ menu when the bar is too narrow,
// the first to go first. They come back in the opposite order when there is room.
const BAR_OVERFLOW = ['copyText', 'copyPicture', 'bookmark'];

class MenuBar {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    const $ = deps.$;
    this.out = [];
    this.settings = new SettingsMenu(deps.pops, 'settings', tr('moreMenu'), () => this.rootItems(), disposer);
    this.bind();
    // The bar is measured again whenever its width changes.
    const row = $('.row');
    if (typeof ResizeObserver === 'function') disposer.observe(new ResizeObserver(() => this.fitBar())).observe(row);
    this.fitBar();
  }

  bind() {
    const x = this.x;
    const $ = x.$;
    const d = this.d;
    const more = $('.morebtn');
    d.listen(more, 'click', () => this.settings.toggle(more, 'below'));
    // A press on a control that is not available says why (touch screens have no tooltips).
    d.listen(x.root, 'click', (e) => {
      const b = e.target.closest && e.target.closest('[aria-disabled=true][data-reason]');
      if (b && b.dataset.reason) { e.stopImmediatePropagation(); x.toast(b.dataset.reason); }
    }, true);
    d.listen($('.ccbtn'), 'click', () => this.setCaptions(!x.cc.on));
    d.listen($('.framebtn'), 'click', () => this.copyFrame());
    d.listen($('.textbtn'), 'click', () => this.copyCaptions());
    d.listen($('.diagclose'), 'click', (e) => { e.stopPropagation(); this.showDiagnostics(false); });
    d.listen($('.diagbox'), 'click', (e) => { if (e.target === $('.diagbox')) this.showDiagnostics(false); });
    d.listen($('.diagcopy'), 'click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText($('.diagtext').textContent)
        .then(() => x.toast(tr('diagCopied')), (err) => x.toast(tr('copyFailed', { msg: (err && err.message) || err })));
    });
  }

  anyOpen() { return this.x.pops.isOpen(); }

  closeAll() { this.x.pops.close(true); }

  // Redraws the settings menu if it is open (a part's state changed).
  refresh() { this.settings.refresh(); }

  // ---- the control bar ----

  // Moves buttons out of the bar (BAR_OVERFLOW order) until it fits, then the time.
  fitBar() {
    const $ = this.x.$;
    const row = $('.row');
    const bottom = $('.bottom');
    const btns = BAR_OVERFLOW.map((k) => this.x.root.querySelector('.row [data-bar=' + k + ']'));
    for (const b of btns) b.classList.remove('out');
    bottom.classList.remove('compact');
    row.classList.add('measure');
    const over = () => row.scrollWidth > row.clientWidth + 1;
    let n = 0;
    while (n < btns.length && over()) btns[n++].classList.add('out');
    if (over()) bottom.classList.add('compact');
    row.classList.remove('measure');
    this.out = BAR_OVERFLOW.slice(0, n).filter((k, i) => !btns[i].hidden);
    this.refresh();
  }

  // The bar's buttons moved into the menu, as menu actions.
  overflowItems() {
    const x = this.x;
    const btn = (k) => x.root.querySelector('.row [data-bar=' + k + ']');
    const item = {
      bookmark: { kind: 'action', label: tr('bookmark'), key: 'B', run: (e) => x.actions.bookmark(e) },
      copyPicture: { kind: 'action', label: tr('copyFrame'), key: 'P', run: () => this.copyFrame() },
      copyText: { kind: 'action', label: tr('copyCaptions'), key: 'A', run: () => this.copyCaptions(), reason: () => unavailableReason(btn('copyText')) },
    };
    // In the bar's order (bookmark, copy picture, copy text).
    const list = BAR_OVERFLOW.slice().reverse().filter((k) => this.out.includes(k)).map((k) => item[k]);
    return list.length ? list.concat({ kind: 'sep' }) : [];
  }

  // ---- the settings menu ----

  rootItems() {
    const x = this.x;
    const a = x.actions;
    const layouts = x.layouts();
    return [
      ...this.overflowItems(),
      { kind: 'page', label: tr('quality'), value: x.values.quality, items: x.pages.quality },
      { kind: 'page', label: tr('captionsPage'), value: () => (x.cc.on ? tr('on') : tr('off')), items: () => this.captionItems() },
      { kind: 'page', label: tr('audio'), value: x.values.audio, items: x.pages.audio, hidden: () => !x.pages.audio },
      { kind: 'page', label: tr('silencePage'), value: x.values.silence, items: x.pages.silence, hidden: () => !x.pages.silence },
      { kind: 'page', label: tr('layout'), value: () => tr(layoutKey(x.layout())), items: () => this.layoutItems(), hidden: () => !layouts.length },
      { kind: 'page', label: tr('copyCaptionsSpan'), value: () => spanLabel(x.prefs.copySpan), items: () => this.copyItems() },
      { kind: 'page', label: tr('theme'), value: () => tr(themeKey(x.prefs.theme)), items: () => this.themeItems() },
      { kind: 'sep' },
      { kind: 'action', label: tr('popout'), key: 'W', run: () => a.popout(), hidden: () => !a.popout },
      { kind: 'page', label: tr('loopMenu'), value: a.loopLabel, items: () => this.loopItems() },
      { kind: 'action', label: tr('exportNotes'), key: 'E', run: () => a.exportNotes(), hidden: () => !a.exportNotes },
      { kind: 'action', label: tr('keysMenu'), key: '?', run: () => a.showKeys() },
      { kind: 'page', label: tr('storageMenu'), items: () => this.storageItems() },
      { kind: 'action', label: tr('useOriginal'), run: () => a.original() },
      { kind: 'foot', text: 'Lite Player for Echo360 ' + VERSION },
    ];
  }

  captionItems() {
    const x = this.x;
    const none = () => unavailableReason(x.$('.ccbtn'));
    return [
      { kind: 'toggle', label: tr('showCaptions'), on: () => x.cc.on, set: (on) => this.setCaptions(on), reason: none },
      { kind: 'toggle', label: tr('hideCaptionsPaused'), on: () => !!x.prefs.capHidePaused, set: (on) => this.setHidePaused(on) },
      { kind: 'group', label: tr('captionSize') },
      ...Object.keys(CAPTION_SIZES).map((s) => ({
        kind: 'radio', label: tr('size' + s.toUpperCase()), checked: () => x.prefs.capSize === s, select: () => this.setCaptionSize(s),
      })),
    ];
  }

  layoutItems() {
    const x = this.x;
    return [
      ...x.layouts().map((l) => ({ kind: 'radio', label: tr(layoutKey(l)), checked: () => x.layout() === l, select: () => x.setLayout(l) })),
      { kind: 'text', text: () => tr('layoutPdfNote'), hidden: () => !x.pdfMode() },
      { kind: 'sep' },
      { kind: 'action', label: tr('swapViews'), key: 'S', run: () => x.swap() },
    ];
  }

  copyItems() {
    const x = this.x;
    return [
      { kind: 'text', text: () => tr('copyCaptionsSpanDesc') },
      ...COPY_SPANS.map((s) => ({
        kind: 'radio', label: spanLabel(s), checked: () => x.prefs.copySpan === s,
        select: () => { x.prefs.copySpan = s; x.savePrefs(); },
      })),
    ];
  }

  themeItems() {
    const x = this.x;
    return [
      ...THEMES.map((t) => ({ kind: 'radio', label: tr(themeKey(t)), checked: () => x.prefs.theme === t, select: () => x.setTheme(t) })),
      { kind: 'text', text: () => tr('themeNote') },
    ];
  }

  loopItems() {
    const a = this.x.actions;
    return [
      { kind: 'action', label: tr('loopFromHere'), key: 'I', run: () => a.loopA() },
      { kind: 'action', label: tr('loopToHere'), key: 'O', run: () => a.loopB() },
      { kind: 'action', label: tr('loopClear'), key: 'X', run: () => a.loopClear(), reason: () => (a.loopLabel() === tr('loopNone') ? tr('loopNone') : '') },
    ];
  }

  // Analysis results stored on this device (size, clear) and the diagnostics.
  storageItems() {
    const size = el('span.grow', { text: tr('cachesMeasuring') });
    const clear = el('button.pbtn', { text: tr('cachesClear') });
    clear.addEventListener('click', guard(async (e) => {
      e.stopPropagation();
      clear.disabled = true;
      const n = await analysisCaches.clear();
      size.textContent = tr('cachesCleared', { n });
    }));
    analysisCaches.usage().then((u) => {
      size.textContent = tr('cachesSize', { mb: (u.bytes / 1e6).toFixed(u.bytes < 1e7 ? 1 : 0), n: u.count });
    }).catch(() => { size.textContent = tr('cachesUnknown'); });
    const row = el('div.mrow', null, size, clear);
    return [
      { kind: 'custom', render: () => row },
      { kind: 'text', text: () => tr('cachesInfo') },
      { kind: 'sep' },
      { kind: 'action', label: tr('diagMenu'), run: () => this.showDiagnostics(true) },
    ];
  }

  // ---- captions ----

  // Captions can be turned on once they are loaded; until then (or when there are none)
  // the button says why not.
  captionsAvailable(reason) {
    setUnavailable(this.x.$('.ccbtn'), reason, tr('captionsKey'));
    setUnavailable(this.x.$('.textbtn'), reason ? tr('copyNoCaptions') : '', tr('copyCaptionsKey'));
    this.refresh();
  }

  setCaptions(on, restoring) {
    const x = this.x;
    x.cc.setOn(on);
    x.cc.update(x.video.currentTime);
    if (!restoring) { x.prefs.captions = on; x.savePrefs(); }
    setPressed(x.$('.ccbtn'), on);
    this.refresh();
  }

  setHidePaused(on) {
    this.x.prefs.capHidePaused = !!on;
    this.x.savePrefs();
    this.x.stage.classList.toggle('hidecc-paused', !!on);
  }

  setCaptionSize(size) {
    if (!(size in CAPTION_SIZES)) return;
    this.x.prefs.capSize = size;
    this.x.cc.setSize(size);
    this.x.savePrefs();
  }

  // ---- copying (picture, what was said) ----

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

  // ---- diagnostics ----

  get diagnosticsOpen() { return !this.x.$('.diagbox').hidden; }

  showDiagnostics(on) {
    const x = this.x;
    if (on === false) { x.$('.diagbox').hidden = true; x.$('.morebtn').focus({ preventScroll: true }); return; }
    x.$('.diagtext').textContent = x.diagnostics();
    x.$('.diagbox').hidden = false;
    x.$('.diagcopy').focus();
  }
}

function layoutKey(l) {
  return { side: 'layoutSide', pip: 'layoutPip', single: 'layoutSingle' }[l];
}

function themeKey(t) {
  return { system: 'themeSystem', dark: 'themeDark', light: 'themeLight' }[t];
}

function spanLabel(s) {
  return tr('copySpanValue', { time: s < 60 ? tr('seconds', { n: s }) : s === 60 ? tr('minute') : tr('minutes', { n: s / 60 }) });
}
