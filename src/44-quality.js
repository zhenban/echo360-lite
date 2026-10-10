// ===================================================================================
// Picture quality: per role (screen, camera) "auto" or a fixed rendition height, its page
// in the settings menu, and a cap for the camera while it is the small picture-in-picture
// window (no point fetching 1080p for a thumbnail).
//
// deps: { prefs, savePrefs(), sources, dual, screenIndex() (null until known),
//         streams() -> [{ stream, elem, pos }] (pos -1: not playing), shown() -> the stream
//         of the big picture, layout(), onChange() (the settings menu redraws) }
// ===================================================================================

class QualityController {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.levelsByRole = {};
  }

  // 'screen' or 'camera'. Until the screen view is known, the first view counts as screen.
  roleOf(pos) {
    const src = this.x.sources[pos];
    if (!src) return 'screen';
    const screen = this.x.screenIndex();
    if (screen != null) return src.index === screen ? 'screen' : 'camera';
    return pos === 0 ? 'screen' : 'camera';
  }

  qualityFor(pos) {
    return this.x.prefs.quality[this.roleOf(pos)] || 'auto';
  }

  // Applies the settings to both streams. The camera may use a smaller rendition only
  // while it is the small picture-in-picture window; the screen is never capped.
  apply() {
    for (const { stream, elem, pos } of this.x.streams()) {
      if (pos < 0 || !stream.uri) continue;
      let cap = 0;
      if (this.x.layout() === 'pip' && elem.dataset.slot === 'secondary' && this.roleOf(pos) === 'camera') {
        cap = Math.ceil(elem.clientHeight * (window.devicePixelRatio || 1));
      }
      stream.setCap(cap);
      stream.setQuality(this.qualityFor(pos));
    }
    this.levelChanged();
  }

  levelChanged() {
    for (const { stream, pos } of this.x.streams()) {
      if (pos >= 0 && stream.levels.length) this.levelsByRole[this.roleOf(pos)] = stream.levels.map((l) => l.height);
    }
    this.x.onChange();
  }

  // Shown next to the page in the settings menu: what the big picture plays now.
  value() {
    const shown = this.x.shown();
    const entry = this.x.streams().find((s) => s.stream === shown && s.pos >= 0);
    const h = shown.height;
    const want = this.x.prefs.quality[this.roleOf(entry ? entry.pos : 0)];
    return want === 'auto' ? tr('qualityAuto') + (h ? ' (' + h + 'p)' : '') : want + 'p';
  }

  // The settings page: for each view, "auto" and the renditions it has.
  items() {
    const x = this.x;
    const roles = x.dual ? ['screen', 'camera'] : [this.roleOf(0)];
    const playingAt = new Map(x.streams().filter((s) => s.pos >= 0).map((s) => [s.pos, s.stream]));
    const items = [];
    for (const role of roles) {
      const pos = x.sources.findIndex((s, i) => this.roleOf(i) === role);
      if (pos < 0) continue;
      const stream = playingAt.get(pos);
      const playing = stream && stream.height ? tr('qualityNow', { q: stream.height + 'p' }) : '';
      if (x.dual) items.push({ kind: 'group', label: tr(role === 'screen' ? 'qualityScreen' : 'qualityCamera') + (playing ? ': ' + playing : '') });
      else if (playing) items.push({ kind: 'group', label: playing });
      const heights = (this.levelsByRole[role] || []).slice().sort((a, b) => b - a);
      const opts = [['auto', tr('qualityAutoBest')]].concat(heights.map((hh) => [hh, hh + 'p']));
      for (const [val, label] of opts) {
        items.push({ kind: 'radio', label, checked: () => x.prefs.quality[role] === val, select: () => this.set(role, val) });
      }
    }
    return items;
  }

  set(role, val) {
    this.x.prefs.quality[role] = val === 'auto' ? 'auto' : +val;
    this.x.savePrefs();
    this.apply();
  }
}
