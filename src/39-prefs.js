// ===================================================================================
// Settings: the defaults and one validation for everything that reads them back (the
// player at start, a backup restore). Each field is checked for type and range; anything
// else falls back to its default and unknown fields are dropped, so a damaged or foreign
// value can never stop the player from starting.
// ===================================================================================

const COPY_SPANS = [30, 60, 120, 300];

function prefDefaults() {
  return {
    primary: null, layout: 'side', ratio: 0.5, pipw: 0.26, corner: 'br', rate: 1, volume: 1, muted: false,
    captions: false, capSize: 'm', capHidePaused: true, panel: false, tab: 'transcript', panelw: 360,
    audio: { level: false, voice: false, mono: false },
    silence: { auto: false, min: 30, sens: 'normal' },
    copySpan: 60,
    pdfMain: false, pdfFirst: false,
    quality: { screen: 'auto', camera: 'auto' },
  };
}

function sanitizePrefs(raw) {
  const d = prefDefaults();
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : def);
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const oneOf = (v, list, def) => (list.includes(v) ? v : def);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const audio = obj(r.audio);
  const silence = obj(r.silence);
  const quality = obj(r.quality);
  const height = (v) => (v === 'auto' || (Number.isInteger(v) && v > 0 && v <= 4320) ? v : 'auto');
  return {
    primary: Number.isInteger(r.primary) && r.primary >= 0 ? r.primary : d.primary,
    layout: oneOf(r.layout, LAYOUTS, d.layout),
    ratio: num(r.ratio, 0.2, 0.8, d.ratio),
    pipw: num(r.pipw, 0.15, 0.6, d.pipw),
    corner: oneOf(r.corner, CORNERS, d.corner),
    rate: num(r.rate, 0.25, 4, d.rate),
    volume: num(r.volume, 0, 1, d.volume),
    muted: bool(r.muted, d.muted),
    captions: bool(r.captions, d.captions),
    capSize: oneOf(r.capSize, Object.keys(CAPTION_SIZES), d.capSize),
    capHidePaused: bool(r.capHidePaused, d.capHidePaused),
    panel: bool(r.panel, d.panel),
    tab: oneOf(r.tab, SIDEBAR_TABS, d.tab),
    panelw: num(r.panelw, 260, 2000, d.panelw),
    audio: { level: bool(audio.level, false), voice: bool(audio.voice, false), mono: bool(audio.mono, false) },
    silence: {
      auto: bool(silence.auto, false),
      min: oneOf(silence.min, SILENCE_MIN_CHOICES, d.silence.min),
      sens: oneOf(silence.sens, Object.keys(SILENCE_SENSITIVITY), d.silence.sens),
    },
    copySpan: oneOf(r.copySpan, COPY_SPANS, d.copySpan),
    pdfMain: bool(r.pdfMain, d.pdfMain),
    pdfFirst: bool(r.pdfFirst, d.pdfFirst),
    quality: { screen: height(quality.screen), camera: height(quality.camera) },
  };
}

// A saved position ({ t, at }) or null.
function sanitizePos(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.t !== 'number' || !isFinite(raw.t) || raw.t < 0) return null;
  return { t: raw.t, at: typeof raw.at === 'number' && isFinite(raw.at) ? raw.at : 0 };
}

// localStorage entries a backup may restore, with their validation. Development
// switches (debug, dryRun, ...) are never restored.
const BACKUP_LOCAL = [
  { match: (k) => k === 'prefs', clean: sanitizePrefs },
  { match: (k) => /^pos:[\w:.-]{1,200}$/.test(k), clean: sanitizePos },
];
