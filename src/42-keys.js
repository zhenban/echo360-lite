// ===================================================================================
// Keyboard shortcuts and their help panel (`?`).
//
// Keys are mapped to named actions the player provides (the player's keyActions); an
// action returning false means "not available now" and the key is left to the page.
// Typing in a field never triggers a shortcut.
// ===================================================================================

// As listed in the help panel: [keys, string key].
/** @type {[string[], string][]} */
const KEY_HELP = [
  [['Space', 'K'], 'keyPlay'], [['←', '→'], 'keySeek5'], [['J', 'L'], 'keySeek10'], [['↑', '↓'], 'keyVolume'],
  [['M'], 'keyMute'], [['F'], 'keyFullscreen'], [['S'], 'keySwap'], [['[', ']'], 'keySpeed'],
  [['C'], 'keyCaptions'], [['T'], 'keyTranscript'], [['B'], 'keyBookmark'], [['G'], 'keyTag'], [['U'], 'keyFlag'],
  [['Shift+←', 'Shift+→'], 'keySlide'], [['P'], 'keyCopyFrame'], [['A'], 'keyCopyCaptions'],
  [['W'], 'keyPopout'], [['E'], 'keyExport'], [['+', '-'], 'keyZoom'], [['0'], 'keyZoomReset'], [['I', 'O'], 'keyLoop'], [['X'], 'keyLoopClear'],
  [['?'], 'keyHelp'], [['Esc'], 'keyEscape'],
];

// Key (as KeyboardEvent.key, letters in either case) -> [action, argument]. Shift+arrows
// step through chapters.
const KEY_ACTIONS = {
  ' ': ['togglePlay'], k: ['togglePlay'],
  ArrowLeft: ['seekBy', -5], ArrowRight: ['seekBy', 5], j: ['seekBy', -10], l: ['seekBy', 10],
  ArrowUp: ['volumeBy', VOLUME_STEP], ArrowDown: ['volumeBy', -VOLUME_STEP], m: ['toggleMute'],
  f: ['fullscreen'], s: ['swap'], c: ['captions'], t: ['transcript'],
  b: ['bookmark'], u: ['flag'], g: ['tag'], p: ['copyFrame'], a: ['copyCaptions'],
  Escape: ['escape'], '?': ['help'],
  '+': ['zoom', 1.25], '=': ['zoom', 1.25], '-': ['zoom', 0.8], _: ['zoom', 0.8], 0: ['zoom', 0],
  i: ['loopA'], o: ['loopB'], x: ['loopClear'], w: ['popout'], e: ['exportNotes'],
  ']': ['speed', 1], '[': ['speed', -1],
};

class KeyboardShortcuts {
  // deps: { $, isDestroyed(), actions: { name(arg, event) -> false if not handled }, wake() }
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    // Also listened to in the floating window's document (see PopoutController).
    this.onKey = (e) => this.handle(e);
    this.d.listen(document, 'keydown', this.onKey, true);
    const box = deps.$('.keyhelp');
    this.d.listen(deps.$('.khclose'), 'click', (e) => { e.stopPropagation(); this.showHelp(false); });
    this.d.listen(box, 'click', (e) => { if (e.target === box) this.showHelp(false); });
  }

  handle(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || this.x.isDestroyed()) return;
    const target = e.composedPath()[0];
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) && target.type !== 'range') return;
    // An open menu or popover handles its own keys (arrows, Enter, [ and ] on the speed
    // track); only Esc goes on to close it.
    if (target && target.closest && target.closest('.pop') && e.key !== 'Escape') return;
    let entry = KEY_ACTIONS[e.key] || KEY_ACTIONS[e.key.length === 1 ? e.key.toLowerCase() : ''];
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.shiftKey) entry = ['stepChapter', e.key === 'ArrowLeft' ? -1 : 1];
    // On the volume slider every arrow changes the volume (left and right do not seek).
    if (target && target.type === 'range' && /^Arrow(Left|Right)$/.test(e.key) && !e.shiftKey) entry = ['volumeBy', e.key === 'ArrowLeft' ? -VOLUME_STEP : VOLUME_STEP];
    if (e.key === '?') entry = ['help'];
    if (!entry) return;
    const [name, arg] = entry;
    const fn = name === 'help' ? () => this.showHelp(this.x.$('.keyhelp').hidden) : this.x.actions[name];
    if (!fn || fn(arg, e) === false) return;
    e.preventDefault();
    e.stopPropagation();
    this.x.wake();
  }

  get helpOpen() { return !this.x.$('.keyhelp').hidden; }

  showHelp(on) {
    const box = this.x.$('.keyhelp');
    if (on) {
      const list = box.querySelector('.khlist');
      list.textContent = '';
      for (const [keys, label] of KEY_HELP) {
        list.append(el('div', null, ...keys.map((k) => el('kbd', { text: k }))), el('div', { text: tr(label) }));
      }
    }
    // Focus goes back to where it was (the ⋮ button when opened from its menu).
    if (on && box.hidden) {
      const active = box.getRootNode().activeElement;
      this.returnTo = active && active.offsetParent ? active : null;
    }
    box.hidden = !on;
    if (on) box.querySelector('.khclose').focus();
    else (this.returnTo || this.x.$('.morebtn')).focus({ preventScroll: true });
  }
}
