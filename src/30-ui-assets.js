// ===================================================================================
// UI assets: inline SVG icons, the stylesheet (injected once into the shadow root) and
// the DOM template. The look follows docs/DESIGN.md: every colour, radius, spacing and
// duration is a token (a CSS custom property) defined at the top of the stylesheet.
// ===================================================================================

// One icon set on a 24px grid. The <svg> wrapper sets the stroke for all of them (see
// svg()), so an icon is only its shapes and cannot drift to another weight. Filled shapes
// mean "on" or "exists" (a bookmark here); small glyphs (the "10") are filled text.
const ICON = {
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M7.5 5.5h2.5v13H7.5zM14 5.5h2.5v13H14z"/>',
  back10: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4h4"/><text x="12.2" y="15.6" font-size="7.5" font-weight="600" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">10</text>',
  fwd10: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4h-4"/><text x="11.8" y="15.6" font-size="7.5" font-weight="600" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">10</text>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  muted: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5m0-5l-5 5"/>',
  fullscreen: '<path d="M4 9V4.5h4.5M20 9V4.5h-4.5M4 15v4.5h4.5M20 15v4.5h-4.5"/>',
  exitFullscreen: '<path d="M8.5 4v4.5H4M15.5 4v4.5H20M8.5 20v-4.5H4M15.5 20v-4.5H20"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  next: '<path d="M9.5 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  swap: '<path d="M5 8h13l-3.5-3.5M19 16H6l3.5 3.5"/>',
  layoutSide: '<rect x="3" y="6" width="8" height="12" rx="1.5"/><rect x="13" y="6" width="8" height="12" rx="1.5"/>',
  layoutPip: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><rect x="12.5" y="11.5" width="5.5" height="4.5" rx="1"/>',
  layoutSingle: '<rect x="3" y="5" width="18" height="14" rx="1.5"/>',
  cc: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M16.5 10.2a2.2 2.2 0 1 0 0 3.6"/>',
  slides: '<rect x="3.5" y="5" width="17" height="11.5" rx="1.5"/><path d="M12 16.5v3M8.5 20h7"/>',
  transcript: '<path d="M5 6.5h14M5 10.5h14M5 14.5h9M5 18.5h6"/>',
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z"/>',
  bookmarkOn: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z" fill="currentColor"/>',
  flag: '<path d="M6 21V4.5M6 5h11l-2.5 4 2.5 4H6"/>',
  flagOn: '<path d="M6 21V4.5"/><path d="M6 5h11l-2.5 4 2.5 4H6z" fill="currentColor"/>',
  notes: '<path d="M6 3.5h9l3 3V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z"/><path d="M9 10h6M9 13.5h6M9 17h4"/>',
  discussion: '<path d="M4.5 5.5h15v10h-9l-4 3.5v-3.5h-2z"/>',
  copyPicture: '<path d="M15.5 5.5V5A1.5 1.5 0 0 0 14 3.5H6A1.5 1.5 0 0 0 4.5 5v8A1.5 1.5 0 0 0 6 14.5h.5"/><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M8.5 17l3.5-3.5 2.5 2.5 1.5-1.5 3.5 3.5"/>',
  copyText: '<path d="M15.5 5.5V5A1.5 1.5 0 0 0 14 3.5H6A1.5 1.5 0 0 0 4.5 5v8A1.5 1.5 0 0 0 6 14.5h.5"/><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M11.5 12.5h5M11.5 15.5h3.5"/>',
  more: '<circle cx="12" cy="5.5" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="12" cy="18.5" r=".9"/>',
  close: '<path d="M6.5 6.5l11 11m0-11l-11 11"/>',
  up: '<path d="M6.5 14.5l5.5-5.5 5.5 5.5"/>',
  down: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
};
const svg = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round">' + ICON[name] + '</svg>';

// Playback speed: the range of the speed control and the stops it snaps to ([ and ] step
// between the stops).
const SPEED_MIN = 0.5;
const SPEED_MAX = 3;
const SPEED_STOPS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SPEED_LABELS = [1, 1.5, 2, 2.5, 3];   // stops labelled under the track

// The light theme's tokens. Only the side panel, popovers and dialogs take them: the
// picture area and the controls over it always use the dark ones.
const LIGHT_TOKENS = `
  --s0: #F2F3F4; --s1: #E7E8EA; --s2: #F8F8F9; --s3: #DCDDE0;
  --line: rgba(0,0,0,.12); --fill: rgba(0,0,0,.06); --fill-2: rgba(0,0,0,.10);
  --text: #232529; --text-2: #555960; --text-3: #8A8D94;
  --accent: #076B75; --on-accent: #FFFFFF; --accent-soft: rgba(7,107,117,.12);
  --hl: rgba(255,186,0,.38); --warn-bg: rgba(181,120,0,.12); --warn-text: #6B4A00;
  --danger: #B3261E; --danger-bg: rgba(179,38,30,.10); --shadow: 0 8px 28px rgba(0,0,0,.16);
  color-scheme: light;`;
const THEMED = '.panel, .pop, .dialog';

const PLAYER_CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483000; display: block;
  --video: #000; --s0: #18191B; --s1: #222326; --s2: #2C2D31; --s3: #37383D;
  --line: rgba(255,255,255,.10); --fill: rgba(255,255,255,.10); --fill-2: rgba(255,255,255,.16);
  --text: #ECEDEF; --text-2: #A8ABB2; --text-3: #8A8D94;
  --accent: #3DBEC4; --on-accent: #0B2E30; --accent-soft: rgba(61,190,196,.16);
  --scrim: rgba(0,0,0,.72); --overlay: rgba(24,25,27,.92); --cap-bg: rgba(0,0,0,.78); --backdrop: rgba(0,0,0,.6);
  --hl: rgba(255,196,0,.40); --warn-bg: rgba(255,170,0,.14); --warn-text: #FFD38A;
  --danger: #FF8A80; --danger-bg: rgba(255,82,82,.14); --shadow: 0 8px 28px rgba(0,0,0,.5);
  --mk-note: #7FA8FF; --mk-bookmark: #FF9F43; --mk-flag: #FF7A93; --mk-comment: #C3A1FF; --mk-last: #FFFFFF;
  --sp1: 4px; --sp2: 8px; --sp3: 12px; --sp4: 16px; --sp6: 24px;
  --r1: 4px; --r2: 8px; --r3: 12px;
  --t-fast: 120ms; --t: 180ms; --ease: cubic-bezier(.2,.8,.2,1);
  --btn: 40px; --panelw: 360px;
  background: var(--video); color: var(--text); color-scheme: dark;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; -webkit-font-smoothing: antialiased; }
@media (pointer: coarse) { :host { --btn: 44px; } }
@media (prefers-reduced-motion: reduce) { :host { --t-fast: 0ms; --t: 0ms; } }
.app[data-theme=light] :is(${THEMED}) { ${LIGHT_TOKENS} }
@media (prefers-color-scheme: light) { .app[data-theme=system] :is(${THEMED}) { ${LIGHT_TOKENS} } }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r2); }
svg { width: 24px; height: 24px; display: block; flex: none; }
.num { font-variant-numeric: tabular-nums; }
.app { position: absolute; inset: 0; }
.stage { position: absolute; inset: 0; overflow: hidden; container: stage / inline-size; --ratio: .5; --pipw: .26; }
.app.panel-open .stage { right: var(--panelw); }

/* ---- buttons: icon buttons and toggles (the same everywhere) ---- */
.btn { position: relative; width: var(--btn); height: var(--btn); display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--r2); flex: none; transition: background-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease); }
.btn:hover { background: var(--fill); }
.btn:active { background: var(--fill-2); }
/* A toggle that is on: the accent colour and a bar under the icon (the bar does not rely on colour). */
:is(.btn, .chip)[aria-pressed=true] { color: var(--accent); }
:is(.btn, .chip)[aria-pressed=true]::after { content: ""; position: absolute; left: 50%; bottom: 3px; width: 16px; height: 2px; margin-left: -8px;
  border-radius: 1px; background: currentColor; }
/* Not available now (the reason is in its tooltip and shown when pressed). */
.btn[aria-disabled=true] { color: var(--text-3); }
.btn[aria-disabled=true]:hover { background: none; }
.pbtn { height: 32px; padding: 0 var(--sp3); border-radius: var(--r2); background: var(--fill); font-size: 13px; }
.pbtn:hover { background: var(--fill-2); }
.pbtn.primary { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.pbtn:disabled { color: var(--text-3); cursor: default; }
.link { font-size: 12px; color: var(--text-2); padding: 2px 0; }
.link:hover { color: var(--text); text-decoration: underline; }
.link.on { color: var(--accent); }
.link.danger:hover { color: var(--danger); }

/* ---- title bar and control bar over the picture ---- */
.top, .bottom { position: absolute; left: 0; right: 0; transition: opacity var(--t) var(--ease); }
.top { top: 0; z-index: 4; display: flex; align-items: center; gap: var(--sp2); padding: var(--sp2) var(--sp3) var(--sp6);
  background: linear-gradient(var(--scrim), transparent); }
/* The bar's background (a scrim over the picture) lets clicks through: only its buttons
   and title take them, so toolbars and windows near the top stay usable. */
.top { pointer-events: none; }
.top > * { pointer-events: auto; }
.bottom { bottom: 0; z-index: 4; padding: var(--sp6) var(--sp3) var(--sp1); background: linear-gradient(transparent, var(--scrim)); }
.idle .top, .idle .bottom { opacity: 0; pointer-events: none; }
.idle { cursor: none; }
.back { display: inline-flex; align-items: center; justify-content: center; width: var(--btn); height: var(--btn); border-radius: var(--r2);
  color: inherit; text-decoration: none; flex: none; }
.back:hover { background: var(--fill); }
.title { flex: 0 1 auto; margin-right: auto; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { position: relative; flex: none; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 var(--sp3) 0 var(--sp2);
  border-radius: var(--r2); background: var(--fill); font-size: 13px; }
.chip:hover { background: var(--fill-2); }
.chip svg { width: 18px; height: 18px; }
@media (pointer: coarse) { .chip { height: 44px; } }
.row { display: flex; align-items: center; gap: 2px; height: calc(var(--btn) + 4px); }
.spacer { flex: 1; min-width: 0; }
.row .out { display: none; }
.time { margin: 0 var(--sp2); font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.time .dur, .time .sep { color: var(--text-2); }
/* Narrow bar: the time moves above the progress bar, current time left, length right. */
.bottom.compact .time { position: absolute; left: var(--sp3); right: var(--sp3); top: 2px; margin: 0; display: flex; justify-content: space-between;
  font-size: 12px; pointer-events: none; }
.bottom.compact .time .sep { display: none; }
.vol { display: flex; align-items: center; }
.vol input { width: 72px; margin: 0 var(--sp2) 0 0; }
@media (pointer: coarse) { .vol input { display: none; } }
input[type=range] { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; cursor: pointer;
  background: linear-gradient(to right, var(--text) var(--v, 100%), var(--fill-2) var(--v, 100%)); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: var(--text); }
input[type=range]::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: var(--text); }
.speed { flex: none; min-width: 52px; height: var(--btn); padding: 0 var(--sp2); border-radius: var(--r2); font-size: 14px; font-weight: 600;
  font-variant-numeric: tabular-nums; transition: background-color var(--t-fast) var(--ease); }
.speed:hover, .speed[aria-expanded=true] { background: var(--fill); }

/* ---- progress bar ---- */
.seek { position: relative; height: 20px; margin: 0 2px 2px; cursor: pointer; touch-action: none; --p: 0; --b: 0; --h: 0; }
.bottom.compact .seek { margin-top: 16px; }
.rail { position: absolute; left: 0; right: 0; top: 8px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.22); overflow: hidden;
  transition: transform var(--t-fast) var(--ease); }
.seek:hover .rail, .seek.dragging .rail { transform: scaleY(1.5); }
.bar { position: absolute; inset: 0; transform-origin: 0 50%; }
.buf { background: rgba(255,255,255,.32); transform: scaleX(var(--b)); }
.hov { background: rgba(255,255,255,.26); transform: scaleX(var(--h)); opacity: 0; }
.seek:hover .hov { opacity: 1; }
.fill { background: var(--accent); transform: scaleX(var(--p)); }
.knob-track { position: absolute; inset: 0; transform: translateX(calc(var(--p) * 100%)); pointer-events: none; }
.knob { position: absolute; left: -7px; top: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--accent);
  transform: scale(0); transition: transform var(--t-fast) var(--ease); }
.seek:hover .knob, .seek.dragging .knob, .seek:focus-visible .knob { transform: scale(1); }
@media (pointer: coarse) { .knob { transform: scale(1); } .seek { height: 28px; } .rail { top: 12px; } .knob { top: 7px; } }
.tip { position: absolute; bottom: 24px; left: 0; max-width: 260px; padding: var(--sp1) var(--sp2); border-radius: var(--r2); background: var(--overlay);
  font-size: 12px; transform: translateX(-50%); pointer-events: none; opacity: 0; }
.tip .tt { display: block; font-variant-numeric: tabular-nums; font-weight: 600; }
.tip .tl { display: block; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tip .tl:empty { display: none; }
.seek:hover .tip, .seek.dragging .tip { opacity: 1; }
.tip .pv { display: block; width: 176px; aspect-ratio: 16 / 9; object-fit: contain; margin: 2px 0 var(--sp1); border-radius: var(--r1); background: var(--video); }
.wat { position: absolute; inset: 0; pointer-events: none; }
.wat i { position: absolute; top: 0; bottom: 0; background: rgba(255,255,255,.16); }
.sils, .chaps { position: absolute; inset: 0; }
.chaps i { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--video); }
/* Skippable stretches: silences sparse diagonal lines, empty screens dense dots. */
.sils i { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(135deg, rgba(255,255,255,.6) 0 1.5px, transparent 1.5px 5px); }
.sils i.empty { background: radial-gradient(rgba(255,255,255,.7) .8px, transparent 1px) 0 0 / 3px 3px; }
.marks { position: absolute; left: 0; right: 0; top: 4px; height: 12px; pointer-events: none; }
.marks i { position: absolute; top: 0; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px; background: var(--mk-bookmark); }
/* Markers for timed items: a different shape for each kind as well as a colour. */
.imarks { position: absolute; left: 0; right: 0; top: 0; height: 20px; pointer-events: none; }
.mk { position: absolute; top: 1px; width: 7px; height: 7px; margin-left: -3.5px; background: var(--mk-note); }
.mk-note { border-radius: 50%; box-shadow: 0 0 0 1.5px var(--video); }
.mk-bookmark { width: 6px; height: 8px; margin-left: -3px; background: var(--mk-bookmark); clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 72%, 0 100%); }
.mk-flag { width: 8px; height: 8px; margin-left: -1px; background: var(--mk-flag); clip-path: polygon(0 0, 100% 50%, 0 100%); }
.mk-comment { background: var(--mk-comment); transform: rotate(45deg) scale(.85); }
.mk-laststop { top: 0; width: 2px; height: 14px; margin-left: -1px; border-radius: 1px; background: var(--mk-last); }
/* A-B loop band on the progress bar */
.loopband { position: absolute; top: 3px; height: 14px; z-index: 2; border-radius: var(--r1); pointer-events: none;
  background: rgba(255,255,255,.14); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,.9); min-width: 2px; }
.loopband.open { background: none; }
.loopband .lh { position: absolute; top: -3px; width: 8px; height: 20px; margin-left: -4px; border-radius: 3px; background: #fff;
  pointer-events: auto; cursor: ew-resize; touch-action: none; }
.loopband .la { left: 0; } .loopband .lb { left: 100%; }
.loopband.open .lb { display: none; }
.loopband .lx { position: absolute; right: -8px; top: -24px; width: 20px; height: 20px; padding: 0; border-radius: 50%; font-size: 11px; line-height: 20px;
  text-align: center; background: #fff; color: #000; pointer-events: auto; }

/* ---- the pictures ---- */
.views { position: absolute; inset: 0; }
video, .pdfview { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: contain; background: var(--video); }
[data-slot=off] { display: none !important; }
.l-single :is(video, .pdfview)[data-slot=secondary] { display: none; }
.l-side :is(video, .pdfview)[data-slot=primary] { width: calc(var(--ratio) * 100%); }
.l-side :is(video, .pdfview)[data-slot=secondary] { left: auto; right: 0; width: calc((1 - var(--ratio)) * 100%); }
/* The lecturer's PDF as a picture of its own (see SlideReader). */
.pdfview { background: var(--s1); overflow: hidden; }
.pstage { position: absolute; inset: 0; }
.rpages { position: absolute; inset: 0; }
.pstage .rpage { position: absolute; left: 50%; top: 50%; width: auto; height: auto; max-width: 100%; max-height: 100%; transform: translate(-50%, -50%); }
.pbar { position: absolute; left: 50%; top: 60px; z-index: 3; display: flex; align-items: center; gap: var(--sp1); padding: 2px var(--sp1); border-radius: var(--r3);
  max-width: calc(100% - 16px); overflow: hidden; transform: translateX(-50%); background: var(--overlay); font-size: 12px; white-space: nowrap;
  transition: opacity var(--t) var(--ease); }
.pfollow { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.idle .pbar { opacity: 0; pointer-events: none; }
.pbar .btn { width: 32px; height: 32px; }
.pbar .btn svg { width: 20px; height: 20px; }
.pbar .btn:disabled { color: var(--text-3); background: none; cursor: default; }
.plabel { padding: 0 var(--sp1); font-variant-numeric: tabular-nums; }
.pfollow .rback { padding: 3px 10px; font-size: 12px; }
.pfollow .rfollowing { color: var(--text-2); padding: 0 6px; }
.l-pip .pdfview[data-slot=secondary] .pbar { display: none; }
.divider { position: absolute; top: 0; bottom: 0; left: calc(var(--ratio) * 100%); width: 16px; margin-left: -8px; cursor: col-resize; z-index: 3; display: none; touch-action: none; }
.divider::after { content: ""; position: absolute; left: 7px; top: 50%; width: 2px; height: 48px; margin-top: -24px; border-radius: 1px; background: rgba(255,255,255,.35);
  transition: background-color var(--t-fast) var(--ease); }
.divider:hover::after, .divider.dragging::after { background: var(--accent); }
.l-side .divider { display: block; }
/* Swapping the two pictures, on the line between them. */
.swapdot { position: absolute; z-index: 4; left: calc(var(--ratio) * 100%); top: 50%; width: var(--btn); height: var(--btn); margin: -84px 0 0 calc(var(--btn) / -2);
  display: none; align-items: center; justify-content: center; border-radius: 50%; background: var(--overlay); transition: opacity var(--t) var(--ease); }
.swapdot svg { width: 20px; height: 20px; }
.swapdot:hover { background: var(--s3); }
.l-side .swapdot { display: inline-flex; }
.idle .swapdot { opacity: 0; pointer-events: none; }
.l-pip :is(video, .pdfview)[data-slot=secondary], .pipframe { left: auto; top: auto; width: calc(var(--pipw) * 100%); height: auto; aspect-ratio: 16 / 9; }
.l-pip :is(video, .pdfview)[data-slot=secondary] { z-index: 2; border-radius: var(--r2); box-shadow: var(--shadow); }
.pipframe { position: absolute; z-index: 3; display: none; border-radius: var(--r2); cursor: grab; touch-action: none; }
.pipframe.dragging { cursor: grabbing; }
.l-pip .pipframe { display: block; }
.pipframe:hover { box-shadow: inset 0 0 0 2px rgba(255,255,255,.5); }
.grip { position: absolute; width: 20px; height: 20px; opacity: 0; transition: opacity var(--t-fast) var(--ease); touch-action: none; }
.grip::before { content: ""; position: absolute; inset: 5px; border: 2px solid #fff; border-radius: 2px; }
.pipframe:hover .grip { opacity: .9; }
@media (pointer: coarse) { .grip { width: 32px; height: 32px; opacity: .9; } .grip::before { inset: 10px; } }
.l-pip.c-br :is(video, .pdfview)[data-slot=secondary], .l-pip.c-br .pipframe { right: 16px; bottom: 88px; }
.l-pip.c-bl :is(video, .pdfview)[data-slot=secondary], .l-pip.c-bl .pipframe { left: 16px; bottom: 88px; }
.l-pip.c-tr :is(video, .pdfview)[data-slot=secondary], .l-pip.c-tr .pipframe { right: 16px; top: 64px; }
.l-pip.c-tl :is(video, .pdfview)[data-slot=secondary], .l-pip.c-tl .pipframe { left: 16px; top: 64px; }
.c-br .grip { left: 0; top: 0; cursor: nwse-resize; }
.c-bl .grip { right: 0; top: 0; cursor: nesw-resize; }
.c-tr .grip { left: 0; bottom: 0; cursor: nesw-resize; }
.c-tl .grip { right: 0; bottom: 0; cursor: nwse-resize; }
.zmap { position: absolute; z-index: 3; border: 1px solid rgba(255,255,255,.75); border-radius: var(--r1); background: rgba(0,0,0,.4); pointer-events: none; }
.zmap i { position: absolute; border: 1.5px solid #fff; background: rgba(255,255,255,.2); border-radius: 2px; }
.views .zoomed { cursor: grab; }
.views .panning { cursor: grabbing; }

/* ---- things shown over the picture (always dark) ---- */
.captions { position: absolute; left: 50%; bottom: 100px; z-index: 4; transform: translateX(-50%); width: max-content; max-width: min(88%, 52em);
  text-align: center; pointer-events: none; transition: bottom var(--t) var(--ease); --capscale: 1; }
.captions.empty { display: none; }
.idle .captions { bottom: 28px; }
.captions span { padding: .12em .45em; border-radius: var(--r1); background: var(--cap-bg); color: #fff;
  font-size: calc(clamp(15px, 1.8vw, 30px) * var(--capscale)); line-height: 1.5; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.paused.hidecc-paused .captions { display: none; }
.center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none; }
.spinner { width: 44px; height: 44px; border-radius: 50%; border: 3px solid rgba(255,255,255,.2); border-top-color: #fff;
  animation: spin .9s linear infinite; display: none; }
.waiting .spinner { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
/* Paused: a small label in the title bar instead of a big icon over the picture. */
.pausehint { flex: none; display: none; align-items: center; gap: 6px; padding: var(--sp1) 10px var(--sp1) var(--sp2); margin-right: auto;
  border-radius: var(--r2); background: var(--fill); font-size: 12px; pointer-events: none; }
.pausehint svg { width: 14px; height: 14px; }
.paused:not(.waiting) .pausehint { display: inline-flex; }
.paused:not(.waiting) .title { margin-right: 0; }
/* Session renewal in progress: a small label in the corner, never over the controls. */
.sessionhint { position: absolute; right: var(--sp3); top: 64px; z-index: 5; display: flex; align-items: center; gap: var(--sp2);
  padding: 6px var(--sp3) 6px 10px; border-radius: var(--r2); background: var(--overlay); font-size: 12px; pointer-events: none; }
.sessionhint i { width: 10px; height: 10px; border-radius: 50%; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; animation: spin .9s linear infinite; }
.toast { position: absolute; z-index: 6; left: 50%; bottom: 100px; transform: translateX(-50%); display: flex; align-items: center; gap: var(--sp3);
  padding: var(--sp2) var(--sp2) var(--sp2) var(--sp4); border-radius: var(--r3); background: var(--overlay); font-size: 13px; box-shadow: var(--shadow);
  max-width: calc(100% - 24px); }
.toast button { flex: none; color: var(--accent); font-weight: 600; padding: 6px 10px; border-radius: var(--r2); }
.toast button:hover { background: var(--fill); }
.skipsil { position: absolute; z-index: 5; right: var(--sp4); bottom: 100px; height: 36px; padding: 0 var(--sp4); border-radius: var(--r2); background: var(--overlay);
  font-size: 13px; box-shadow: var(--shadow); transition: opacity var(--t) var(--ease); }
.skipsil:hover { background: var(--s3); }
.skipsil.fade { opacity: 0; pointer-events: none; }
.endnote { position: absolute; z-index: 5; right: var(--sp4); bottom: 100px; display: flex; align-items: center; gap: var(--sp2); padding: 6px var(--sp2) 6px var(--sp4);
  border-radius: var(--r3); background: var(--overlay); box-shadow: var(--shadow); font-size: 13px; }
.endnote button { height: 30px; padding: 0 var(--sp3); border-radius: var(--r2); background: var(--fill); }
.endnote .endclose { width: 30px; padding: 0; background: none; color: var(--text-2); }
.dropzone { position: absolute; inset: var(--sp3); z-index: 6; display: flex; align-items: center; justify-content: center; border: 2px dashed var(--accent);
  border-radius: var(--r3); background: rgba(0,0,0,.75); font-size: 16px; pointer-events: none; }

/* The time above the progress bar makes the bar taller: notices move up with it. */
.stage:has(.bottom.compact) :is(.toast, .skipsil, .endnote) { bottom: 132px; }
.stage:has(.bottom.compact) .captions { bottom: 132px; }

/* ---- dialogs (shortcuts, diagnostics, errors) ---- */
.keyhelp, .diagbox, .error { position: absolute; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center; background: var(--backdrop); }
.dialog { max-width: min(640px, calc(100% - 32px)); max-height: calc(100% - 32px); overflow: auto; padding: 20px var(--sp6); border-radius: var(--r3);
  background: var(--s2); color: var(--text); box-shadow: var(--shadow); }
.dialog h2 { margin: 0 0 var(--sp3); font-size: 16px; font-weight: 600; }
.dialog p { margin: 0 0 var(--sp4); color: var(--text-2); }
.dialog .actions { display: flex; justify-content: flex-end; gap: var(--sp2); flex-wrap: wrap; }
.error .dialog { max-width: 440px; }
.khlist { display: grid; grid-template-columns: max-content 1fr; gap: 6px var(--sp4); font-size: 13px; margin-bottom: var(--sp4); }
.khlist kbd { display: inline-block; min-width: 1.6em; padding: 1px 6px; margin-right: var(--sp1); border-radius: var(--r1); text-align: center;
  background: var(--fill); box-shadow: inset 0 -1px 0 var(--line); font: 600 12px/1.6 inherit; font-family: inherit; }
.diaginfo { margin: 0 0 10px; font-size: 13px; }
.diagtext { max-height: 50vh; overflow: auto; margin: 0 0 var(--sp4); padding: 10px var(--sp3); border-radius: var(--r2); background: var(--s1);
  font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }

/* ---- popovers, menus and the settings menu (see 32-ui-kit.js) ---- */
.layer { position: absolute; inset: 0; z-index: 9; pointer-events: none; }
.layer > * { pointer-events: auto; }
.pop { position: absolute; left: 0; top: 0; min-width: 220px; max-width: min(360px, calc(100% - 16px)); overflow: auto; overscroll-behavior: contain;
  padding: 6px; border-radius: var(--r3); background: var(--s2); color: var(--text); box-shadow: var(--shadow), 0 0 0 1px var(--line);
  transition: opacity var(--t) var(--ease), transform var(--t) var(--ease); }
.pop:focus-visible { outline: none; }
.pop.entering { opacity: 0; transform: translateY(var(--from, 4px)); }
.pop.sheet { left: 0 !important; right: 0; top: auto !important; bottom: 0; max-width: none; width: auto !important; max-height: 75% !important;
  border-radius: var(--r3) var(--r3) 0 0; padding: var(--sp2) var(--sp2) calc(var(--sp4) + env(safe-area-inset-bottom, 0px)); }
.pop.sheet.entering { transform: translateY(24px); }
.mi { display: flex; align-items: center; gap: var(--sp3); width: 100%; min-height: 36px; padding: 6px 10px; border-radius: var(--r2); text-align: left; font-size: 13px; }
@media (pointer: coarse) { .mi { min-height: 44px; } }
.mi:hover:not([aria-disabled=true]), .mi:focus-visible { background: var(--s3); outline-offset: -2px; }
.mi .lbl { flex: 1; min-width: 0; }
.mi .desc { display: block; margin-top: 2px; font-size: 12px; color: var(--text-2); line-height: 1.35; }
.mi .val { color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.mi .key { color: var(--text-2); font-size: 12px; min-width: 1.2em; text-align: right; }
.mi svg { width: 20px; height: 20px; color: var(--text-2); }
.mi .tick { width: 20px; height: 20px; flex: none; color: var(--accent); }
.mi[aria-checked=false] .tick svg { visibility: hidden; }
.mi[aria-disabled=true] { color: var(--text-3); cursor: default; }
.mi[aria-disabled=true] .desc, .mi[aria-disabled=true] .val { color: var(--text-3); }
.mi .sw { position: relative; flex: none; width: 32px; height: 18px; border-radius: 9px; background: var(--fill-2); box-shadow: inset 0 0 0 1px var(--line);
  transition: background-color var(--t-fast) var(--ease); }
.mi .sw::after { content: ""; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--text-2);
  transition: transform var(--t-fast) var(--ease), background-color var(--t-fast) var(--ease); }
.mi[aria-checked=true] .sw { background: var(--accent); box-shadow: none; }
.mi[aria-checked=true] .sw::after { transform: translateX(14px); background: var(--on-accent); }
.mhead { display: flex; align-items: center; gap: var(--sp1); padding: 2px 2px 6px; margin-bottom: var(--sp1); border-bottom: 1px solid var(--line); font-size: 13px; font-weight: 600; }
.mhead .btn { width: 32px; height: 32px; }
.mhead .btn svg { width: 20px; height: 20px; }
@media (pointer: coarse) { .mhead .btn { width: 44px; height: 44px; } }
.mgroup { padding: var(--sp2) 10px var(--sp1); font-size: 12px; color: var(--text-2); }
.mtext { padding: var(--sp1) 10px var(--sp2); font-size: 12px; line-height: 1.4; color: var(--text-2); }
.mtext.warn { color: var(--warn-text); }
.msep { height: 1px; margin: 6px var(--sp1); background: var(--line); }
.mfoot { padding: var(--sp2) 10px 2px; font-size: 12px; color: var(--text-2); }
.mrow { display: flex; align-items: center; gap: var(--sp2); padding: var(--sp1) 10px; font-size: 13px; }
.mrow .grow { color: var(--text-2); }
.tooltip { position: absolute; left: 0; top: 0; max-width: 280px; padding: var(--sp1) var(--sp2); border-radius: var(--r1); background: var(--s3); color: var(--text);
  font-size: 12px; line-height: 1.35; pointer-events: none !important; box-shadow: var(--shadow); }
/* The speed control */
.spd { width: 320px; max-width: 100%; padding: var(--sp2) var(--sp3) var(--sp1); }
.pop.sheet .spd { width: auto; }
.spd-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp3); }
.spd-head span { font-size: 13px; color: var(--text-2); }
.spd-val { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.spd-track { position: relative; height: 44px; margin: 0 var(--sp2); cursor: pointer; touch-action: none; }
.spd-track:focus-visible { outline-offset: 0; }
.spd-rail { position: absolute; left: 0; right: 0; top: 21px; height: 2px; border-radius: 1px; background: var(--fill-2); }
.spd-fill { position: absolute; left: 0; top: 21px; height: 2px; border-radius: 1px; background: var(--accent); width: calc(var(--f) * 100%); }
.spd-stop { position: absolute; top: 16px; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px; background: var(--text-3); }
.spd-stop.on { background: var(--accent); }
.spd-thumb { position: absolute; top: 12px; left: calc(var(--f) * 100%); width: 20px; height: 20px; margin-left: -10px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft); transition: left var(--t-fast) var(--ease); }
.spd-track.dragging .spd-thumb { transition: none; }
.spd-labels { position: relative; height: 32px; margin: 0 var(--sp2); }
.spd-labels button { position: absolute; top: 0; height: 32px; min-width: 32px; padding: 0 var(--sp1); transform: translateX(-50%); border-radius: var(--r2);
  font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.spd-labels button:hover { background: var(--fill); color: var(--text); }
.spd-labels button.on { color: var(--accent); font-weight: 600; }
@media (pointer: coarse) { .spd-labels { height: 44px; } .spd-labels button { height: 44px; min-width: 44px; } }

/* ---- side panel ---- */
.panel { position: absolute; top: 0; right: 0; bottom: 0; width: var(--panelw); z-index: 5; display: flex; flex-direction: column;
  background: var(--s0); color: var(--text); border-left: 1px solid var(--line); }
.presize { position: absolute; left: -5px; top: 0; bottom: 0; width: 10px; cursor: col-resize; touch-action: none; }
.phead { display: flex; align-items: center; gap: 6px; padding: 10px var(--sp2) 6px var(--sp3); }
.tabs { display: flex; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.tabs button { position: relative; height: 32px; padding: 0 10px; border-radius: var(--r2); font-size: 13px; color: var(--text-2); white-space: nowrap; }
.tabs button:hover { background: var(--fill); color: var(--text); }
.tabs button[aria-selected=true] { color: var(--text); font-weight: 600; }
.tabs button[aria-selected=true]::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: 0; height: 2px; border-radius: 1px; background: var(--accent); }
@media (pointer: coarse) { .tabs button { height: 44px; } }
.phead .btn { width: 32px; height: 32px; }
.phead .btn svg, .psearch .btn svg { width: 20px; height: 20px; }
@media (pointer: coarse) { .phead .btn, .psearch .btn { width: 44px; height: 44px; } }
.pane { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pane[data-pane=notes], .pane[data-pane=discussion], .pane[data-pane=slides] { overflow-y: auto; padding: 0 var(--sp3) var(--sp4); overscroll-behavior: contain; }
.psearch { display: flex; align-items: center; gap: 2px; padding: 0 var(--sp2) var(--sp2) var(--sp3); }
.psearch .btn { width: 32px; height: 32px; }
.tsearch { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--r2); background: var(--s1); color: inherit; font: inherit; font-size: 13px; }
.tsearch:focus { border-color: var(--accent); }
.tcount { min-width: 4.5em; padding: 0 var(--sp1); font-size: 12px; text-align: right; white-space: nowrap; color: var(--text-2); font-variant-numeric: tabular-nums; }
.tlist { flex: 1; overflow-y: auto; padding: 2px 6px 56px; overscroll-behavior: contain; }
.trow { display: flex; gap: 10px; padding: 6px var(--sp2); border-radius: var(--r2); cursor: pointer; font-size: 14px; line-height: 1.45;
  content-visibility: auto; contain-intrinsic-size: auto 44px; }
.trow:hover { background: var(--fill); }
.trow .ts { flex: none; width: 4.4em; padding-top: 2px; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--text-2); }
.trow.cur { background: var(--accent-soft); }
.trow.cur .ts { color: var(--accent); }
/* Only the matched characters are marked (a background on the whole text, a block here,
   fell on its last lines whatever line the match was on). */
.trow .tx mark { background: var(--hl); color: inherit; border-radius: 2px; }
.tback { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); height: 32px; padding: 0 14px; border-radius: var(--r2);
  background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 600; box-shadow: var(--shadow); }
.pextras { margin: 0 var(--sp3) var(--sp2); padding: var(--sp2) 10px; border-radius: var(--r2); background: var(--warn-bg); font-size: 12px; line-height: 1.45; }
.pextras button { margin-top: var(--sp1); }
.pinfo { margin: 2px 0 10px; font-size: 12px; line-height: 1.45; color: var(--text-2); }
.pwarn { margin-bottom: var(--sp2); padding: 7px 10px; border-radius: var(--r2); background: var(--warn-bg); color: var(--warn-text); font-size: 12px; line-height: 1.4; }
.perror { margin-bottom: 10px; padding: 7px 10px; border-radius: var(--r2); background: var(--danger-bg); color: var(--danger); font-size: 12px; }
.pempty { padding: var(--sp6) var(--sp2); text-align: center; font-size: 13px; color: var(--text-2); line-height: 1.5; }
.pmuted { font-size: 12px; color: var(--text-2); }
/* Marking a moment for the instructor (Notes tab). */
.flagrow { display: flex; align-items: center; gap: var(--sp2); flex-wrap: wrap; margin: 0 0 var(--sp3); padding: var(--sp2) 10px; border-radius: var(--r2);
  background: var(--s1); font-size: 12px; }
.flagrow .pbtn { display: inline-flex; align-items: center; gap: 6px; }
.flagrow .pbtn svg { width: 18px; height: 18px; color: var(--mk-flag); }
.flagrow .pbtn.armed { background: var(--accent); color: var(--on-accent); }
.flagrow .pbtn.armed svg { color: inherit; }
.flagrow .who { color: var(--text-2); }
.composer { display: flex; flex-direction: column; gap: var(--sp2); margin-bottom: var(--sp3); }
.composer.reply { margin: 10px 0 0; }
.input { width: 100%; padding: var(--sp2) 10px; border: 1px solid var(--line); border-radius: var(--r2); background: var(--s1);
  color: inherit; font: inherit; font-size: 13px; line-height: 1.45; resize: vertical; }
.input:focus { border-color: var(--accent); }
.input.small { width: auto; padding: var(--sp1) var(--sp2); }
select.input option { background: var(--s1); color: var(--text); }
.crow, .ptools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.ptools { margin-bottom: 10px; }
.grow { flex: 1; }
.check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.check input { accent-color: var(--accent); }
.counter { color: var(--text-2); } .counter.over { color: var(--danger); }
.plist { display: flex; flex-direction: column; gap: var(--sp2); }
.card { padding: 10px var(--sp3); border-radius: var(--r2); background: var(--s1); border-left: 3px solid transparent; }
.card.k-note { border-left-color: var(--mk-note); } .card.k-bookmark { border-left-color: var(--mk-bookmark); } .card.k-flag { border-left-color: var(--mk-flag); }
.ihead { display: flex; align-items: center; gap: var(--sp2); flex-wrap: wrap; font-size: 12px; }
.ibody { margin-top: 6px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.iactions, .cactions { display: flex; gap: 14px; flex-wrap: wrap; margin-top: var(--sp2); }
.kind { font-weight: 600; }
.chiptime { height: 22px; padding: 0 var(--sp2); border-radius: var(--r1); background: var(--accent-soft); color: var(--accent); font-size: 12px; font-variant-numeric: tabular-nums; }
.chiptime:hover { background: var(--fill-2); }
.author { font-weight: 600; font-size: 13px; }
.badge { padding: 1px 6px; border-radius: var(--r1); font-size: 11px; }
.badge.inst { background: var(--accent-soft); color: var(--accent); }
.comment + .comment { margin-top: 10px; }
.replies { margin-top: 10px; padding-left: var(--sp3); border-left: 2px solid var(--line); }
.comment.reply .ibody { font-size: 13px; }
/* Tags (local, private) */
.itags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.tagchip, .tagopt { display: inline-flex; align-items: center; gap: 5px; padding: 2px var(--sp2) 2px 6px; border-radius: var(--r1);
  background: var(--fill); color: inherit; font: inherit; font-size: 12px; border: 0; cursor: pointer; }
.tagchip i, .tagopt i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.tagopt { color: var(--text-2); } .tagopt.on { color: var(--text); background: var(--fill-2); box-shadow: inset 0 0 0 1px var(--line); }
.tagopt:hover, .tagchip:hover { background: var(--fill-2); }
.tagpick { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px; padding: var(--sp2); border-radius: var(--r2); background: var(--fill); }
.tagnew { flex-basis: 100%; display: flex; gap: var(--sp2); align-items: center; }
.tagnew input { flex: 1; min-width: 0; }
.addtag { font-size: 12px; }
.tagman { padding: 10px var(--sp3); margin-bottom: 10px; border-radius: var(--r2); background: var(--s1); display: flex; flex-direction: column; gap: var(--sp2); }
.tagrow { display: flex; gap: var(--sp2); align-items: center; }
.tagrow input { flex: 1; min-width: 0; }
.tagswatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--line); cursor: pointer; flex: none; padding: 0; }
/* Slides tab and the PDF reader */
.sstatus { padding: var(--sp1) 2px var(--sp2); font-size: 12px; color: var(--text-2); }
.sscreen { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 2px var(--sp2); font-size: 12px; }
.sscreen:empty { display: none; }
.sscreen > span { color: var(--text-2); }
.sview { padding: 2px var(--sp2); border-radius: var(--r1); border: 1px solid var(--line); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.sview.on { background: var(--fill-2); border-color: var(--accent); }
.slist { display: flex; flex-direction: column; gap: var(--sp2); }
.scard { display: flex; gap: 10px; align-items: flex-start; width: 100%; padding: 6px; border-radius: var(--r2); text-align: left; }
.scard:hover { background: var(--fill); }
.scard.cur { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.scard img, .scard .noimg { flex: none; width: 128px; aspect-ratio: 16 / 9; border-radius: var(--r1); background: var(--s1); object-fit: contain; }
.smeta { min-width: 0; flex: 1; }
.stitle { display: flex; justify-content: space-between; gap: var(--sp2); font-size: 13px; font-weight: 600; }
.stitle .st { font-weight: 400; color: var(--text-2); font-variant-numeric: tabular-nums; }
.ssaid { margin-top: 3px; font-size: 12px; line-height: 1.35; color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.reader { padding: var(--sp1) 0 var(--sp2); }
.rstage { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--r1); overflow: hidden; background: #fff; }
.rpage { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; transition: opacity var(--t) var(--ease); }
.rpage.in { opacity: 1; }
.rstale { position: absolute; inset: 0; z-index: 1; display: none; align-items: center; justify-content: center; padding: var(--sp3); text-align: center;
  font-size: 13px; font-weight: 600; color: #fff; background: rgba(20,20,24,.72); }
.stale > .rstale { display: flex; }
.pstage .rstale { z-index: 2; font-size: 15px; }
.rbar { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.rnav { width: 32px; height: 32px; border-radius: var(--r2); font-size: 20px; line-height: 1; }
.rnav:hover:not(:disabled) { background: var(--fill); }
.rnav:disabled { color: var(--text-3); cursor: default; }
@media (pointer: coarse) { .rnav { width: 44px; height: 44px; } }
.rlabel { flex: 1; text-align: center; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rfollow { margin-top: 6px; text-align: center; font-size: 12px; }
.rfollowing { color: var(--text-2); }
.rback { padding: 5px var(--sp3); border-radius: var(--r2); background: var(--accent); color: var(--on-accent); font-weight: 600; }
.rtimes { display: flex; flex-wrap: wrap; gap: var(--sp1); align-items: center; margin-top: var(--sp2); font-size: 12px; }
.rtl { color: var(--text-2); margin-right: 2px; }
.rtime { padding: 2px var(--sp2); border-radius: var(--r1); background: var(--fill); font-variant-numeric: tabular-nums; }
.rtime:hover { background: var(--fill-2); }
.rfix { margin-top: var(--sp2); font-size: 12px; }
.rfix summary { cursor: pointer; color: var(--text-2); }
.rfix[open] summary { color: var(--text); margin-bottom: var(--sp1); }
.rfixbtn { display: block; width: 100%; text-align: left; padding: 5px var(--sp2); border-radius: var(--r2); }
.rfixbtn:hover { background: var(--fill); }
.rmain { display: block; width: 100%; margin-top: 6px; padding: 6px var(--sp2); border-radius: var(--r2); font-size: 12px; background: var(--fill); }
.rmain:hover { background: var(--fill-2); }
.chaptoggle { display: block; margin: 6px 0; padding: var(--sp1) 0; font-size: 12px; color: var(--accent); }
.sdeck { padding: var(--sp2) 2px var(--sp1); border-bottom: 1px solid var(--line); margin-bottom: 6px; }
.sfiles { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sfile { display: inline-flex; align-items: center; gap: var(--sp1); max-width: 100%; padding: 3px var(--sp1) 3px 10px; border-radius: var(--r2); background: var(--fill); font-size: 12px; }
.sfname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.sfremove { width: 22px; height: 22px; border-radius: var(--r1); font-size: 11px; color: var(--text-2); }
.sfremove:hover { background: var(--fill-2); color: var(--text); }
.sfadd { padding: var(--sp1) 10px; border-radius: var(--r2); font-size: 12px; color: var(--accent); }
.sfadd:hover { background: var(--accent-soft); }
.sdmsg { margin-top: 6px; font-size: 12px; line-height: 1.4; color: var(--text-2); }

/* ---- narrow windows ---- */
@media (max-width: 720px) {
  .app.panel-open .stage { right: 0; }
  .panel { width: 100%; }
  .presize { display: none; }
}
/* The bars follow the video area's width, not the window's: an open panel narrows it. */
@container stage (max-width: 720px) {
  .top .chip .lbl { display: none; }
  .top .chip { padding: 0 var(--sp2); background: none; }
}
@container stage (max-width: 560px) {
  .top { padding: var(--sp1) var(--sp2) 20px; gap: var(--sp1); }
  .paused:not(.waiting) .pausehint { display: none; }
  .paused:not(.waiting) .title { margin-right: auto; }
  .bottom { padding: 20px var(--sp1) var(--sp1); }
}
/* Hidden controls take no clicks or taps at all: children that re-enable pointer events
   for themselves (the title bar's buttons, the loop band's handles) must not stay
   clickable while invisible. (Repeated after every other rule, so it always wins.) */
.stage.idle .top *, .stage.idle .bottom * { pointer-events: none; }
`;

function playerTemplate() {
  return `
<div class="app" data-theme="system">
<div class="stage paused l-single c-br">
  <div class="views">
    <video class="clock" playsinline preload="auto" data-slot="primary"></video>
    <video class="follower" playsinline preload="auto" muted data-slot="secondary"></video>
    <div class="pdfview" data-slot="off">
      <div class="pstage"></div>
      <div class="pbar">
        <button class="btn pprev" aria-label="${tr('prevPage')}" data-tip="${tr('prevPage')}">${svg('back')}</button>
        <span class="plabel"></span>
        <button class="btn pnext" aria-label="${tr('nextPage')}" data-tip="${tr('nextPage')}">${svg('next')}</button>
        <span class="pfollow"></span>
        <button class="btn pswap" aria-label="${tr('pdfSwap')}" data-tip="${tr('pdfSwap')}">${svg('swap')}</button>
        <button class="btn pdfclose" aria-label="${tr('pdfMainClose')}" data-tip="${tr('pdfMainClose')}">${svg('close')}</button>
      </div>
    </div>
    <div class="divider" role="separator" aria-orientation="vertical" aria-label="${tr('resizeViews')}" tabindex="0"></div>
    <button class="swapdot" aria-label="${tr('swapViews')}" data-tip="${tr('swapViewsKey')}">${svg('swap')}</button>
    <div class="pipframe" title="${tr('pipHint')}"><div class="grip" title="${tr('resizePip')}"></div></div>
  </div>
  <div class="captions" hidden><span></span></div>
  <div class="center"><div class="spinner"></div></div>
  <div class="sessionhint" role="status" hidden><i></i><span>${tr('sessionRenewing')}</span></div>
  <div class="top">
    <a class="back" aria-label="${tr('back')}" data-tip="${tr('back')}">${svg('back')}</a>
    <div class="title"></div>
    <span class="pausehint" aria-hidden="true">${svg('pause')}<span>${tr('pausedHint')}</span></span>
    <button class="chip tbtn" data-open="transcript" hidden aria-pressed="false" data-tip="${tr('transcriptKey')}">${svg('transcript')}<span class="lbl">${tr('transcript')}</span></button>
    <button class="chip tbtn" data-open="slides" hidden aria-pressed="false" data-tip="${tr('slides')}">${svg('slides')}<span class="lbl">${tr('slides')}</span></button>
    <button class="chip tbtn" data-open="notes" hidden aria-pressed="false" data-tip="${tr('notes')}">${svg('notes')}<span class="lbl">${tr('notes')}</span></button>
    <button class="chip tbtn" data-open="discussion" hidden aria-pressed="false" data-tip="${tr('discussion')}">${svg('discussion')}<span class="lbl">${tr('discussion')}</span></button>
    <button class="btn morebtn" aria-label="${tr('moreMenu')}" data-tip="${tr('moreMenu')}" aria-haspopup="menu" aria-expanded="false">${svg('more')}</button>
  </div>
  <div class="bottom">
    <div class="seek" role="slider" aria-label="${tr('seek')}" tabindex="0">
      <div class="rail"><div class="wat"></div><div class="bar buf"></div><div class="sils"></div><div class="chaps"></div><div class="bar hov"></div><div class="bar fill"></div></div>
      <div class="imarks"></div>
      <div class="marks"></div>
      <div class="knob-track"><div class="knob"></div></div>
      <div class="tip"><img class="pv" alt="" hidden><span class="tt">0:00</span><span class="tl"></span></div>
    </div>
    <div class="row">
      <button class="btn play" aria-label="${tr('play')}" data-tip="${tr('playKey')}">${svg('play')}</button>
      <button class="btn rew" aria-label="${tr('rewind')}" data-tip="${tr('rewindKey')}">${svg('back10')}</button>
      <button class="btn fwd" aria-label="${tr('forward')}" data-tip="${tr('forwardKey')}">${svg('fwd10')}</button>
      <div class="vol">
        <button class="btn mute" aria-label="${tr('mute')}" data-tip="${tr('muteKey')}">${svg('volume')}</button>
        <input class="volume" type="range" min="0" max="1" step="0.01" aria-label="${tr('volume')}">
      </div>
      <div class="time"><span class="cur">0:00</span><span class="sep"> / </span><span class="dur">0:00</span></div>
      <div class="spacer"></div>
      <button class="speed" aria-haspopup="dialog" aria-expanded="false" aria-label="${tr('speed')}" data-tip="${tr('speedKey')}">1×</button>
      <button class="btn ccbtn" aria-pressed="false" aria-disabled="true" aria-label="${tr('captions')}" data-tip="${tr('captionsLoading')}">${svg('cc')}</button>
      <button class="btn bmbtn" data-bar="bookmark" hidden aria-label="${tr('bookmark')}" data-tip="${tr('bookmarkKey')}">${svg('bookmark')}</button>
      <button class="btn framebtn" data-bar="copyPicture" aria-label="${tr('copyFrame')}" data-tip="${tr('copyFrameKey')}">${svg('copyPicture')}</button>
      <button class="btn textbtn" data-bar="copyText" aria-label="${tr('copyCaptions')}" data-tip="${tr('copyCaptionsKey')}">${svg('copyText')}</button>
      <button class="btn layout" aria-label="${tr('layout')}">${svg('layoutSide')}</button>
      <button class="btn fs" aria-label="${tr('fullscreen')}" data-tip="${tr('fullscreenKey')}">${svg('fullscreen')}</button>
    </div>
  </div>
  <button class="skipsil fade" tabindex="-1"></button>
  <div class="endnote" hidden role="status"><span>${tr('contentEnded')}</span>
    <button class="endskip">${tr('contentEndSkip')}</button><button class="endstop">${tr('contentEndStop')}</button>
    <button class="endclose" aria-label="${tr('close')}">${svg('close')}</button></div>
  <div class="toast" hidden role="status"><span class="msg"></span><button class="act"></button></div>
  <div class="dropzone" hidden>${tr('dropSlides')}</div>
  <div class="error" hidden><div class="dialog" role="alertdialog"><h2></h2><p></p><div class="actions"></div></div></div>
  <div class="keyhelp" hidden><div class="dialog" role="dialog" aria-label="${tr('keysTitle')}"><h2>${tr('keysTitle')}</h2><div class="khlist"></div>
    <div class="actions"><button class="pbtn khclose">${tr('close')}</button></div></div></div>
  <div class="diagbox" hidden><div class="dialog" role="dialog" aria-label="${tr('diagTitle')}"><h2>${tr('diagTitle')}</h2>
    <p class="diaginfo">${tr('diagInfo')}</p><pre class="diagtext"></pre>
    <div class="actions"><button class="pbtn diagcopy">${tr('diagCopy')}</button><button class="pbtn diagclose">${tr('close')}</button></div></div></div>
</div>
<aside class="panel" hidden aria-label="${tr('sidebarTabs')}">
  <div class="presize" title="${tr('resizePanel')}"></div>
  <div class="phead">
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="transcript" hidden>${tr('transcript')}</button>
      <button role="tab" data-tab="slides" hidden>${tr('slides')}</button>
      <button role="tab" data-tab="notes" hidden>${tr('notes')}</button>
      <button role="tab" data-tab="discussion" hidden>${tr('discussion')}</button>
    </div>
    <button class="btn panelclose" aria-label="${tr('closePanel')}" data-tip="${tr('closePanel')}">${svg('close')}</button>
  </div>
  <div class="pextras" hidden><div class="msg"></div><button class="link">${tr('useOriginal')}</button></div>
  <section class="pane" data-pane="transcript" hidden>
    <div class="psearch">
      <input class="tsearch" type="search" placeholder="${tr('searchTranscript')}" aria-label="${tr('searchTranscript')}">
      <span class="tcount" aria-live="polite"></span>
      <button class="btn tprev" aria-label="${tr('prevMatch')}" data-tip="${tr('prevMatch')}">${svg('up')}</button>
      <button class="btn tnext" aria-label="${tr('nextMatch')}" data-tip="${tr('nextMatch')}">${svg('down')}</button>
    </div>
    <div class="tlist" tabindex="0"></div>
    <button class="tback" hidden>${tr('backToCurrent')}</button>
  </section>
  <section class="pane" data-pane="slides" hidden></section>
  <section class="pane" data-pane="notes" hidden></section>
  <section class="pane" data-pane="discussion" hidden></section>
</aside>
<div class="layer"></div>
</div>`;
}
