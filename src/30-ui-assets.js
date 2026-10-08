// ===================================================================================
// UI assets: inline SVG icons, the stylesheet (injected once into the shadow root) and
// the DOM template.
// ===================================================================================

const ICON = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
  back10: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><text x="12.2" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif">10</text>',
  fwd10: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><text x="11.8" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif">10</text>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  muted: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M16 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  popout: '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="11" y="11" width="8" height="6" rx="1" fill="currentColor"/>',
  fullscreen: '<path d="M4 9V4.5h4.5M20 9V4.5h-4.5M4 15v4.5h4.5M20 15v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  exitFullscreen: '<path d="M8.5 4v4.5H4M15.5 4v4.5H20M8.5 20v-4.5H4M15.5 20v-4.5H20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  back: '<path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  swap: '<path d="M5 8h13l-3.5-3.5M19 16H6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  layoutSide: '<rect x="3" y="6" width="8" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="6" width="8" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  layoutPip: '<rect x="3" y="5" width="18" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="12.5" y="11.5" width="6" height="5" rx="1" fill="currentColor"/>',
  cc: '<rect x="3" y="5.5" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M16.5 10.2a2.2 2.2 0 1 0 0 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  slides: '<rect x="3.5" y="5" width="17" height="11.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 16.5v3M8.5 20h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  transcript: '<path d="M5 6.5h14M5 10.5h14M5 14.5h9M5 18.5h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  bookmarkOn: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  flag: '<path d="M6 21V4.5M6 5h11l-2.5 4 2.5 4H6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  flagOn: '<path d="M6 21V4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6 5h11l-2.5 4 2.5 4H6z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  notes: '<path d="M6 3.5h9l3 3V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 10h6M9 13.5h6M9 17h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  discussion: '<path d="M4.5 5.5h15v10h-9l-4 3.5v-3.5h-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  audio: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 5.5v-.5a1.5 1.5 0 0 0-1.5-1.5H6a1.5 1.5 0 0 0-1.5 1.5v8a1.5 1.5 0 0 0 1.5 1.5h.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  more: '<circle cx="5.5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="18.5" cy="12" r="1.8" fill="currentColor"/>',
  close: '<path d="M6.5 6.5l11 11m0-11l-11 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  up: '<path d="M6.5 14.5l5.5-5.5 5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  layoutSingle: '<rect x="3" y="5" width="18" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
};
const svg = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[name] + '</svg>';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483000; display: block; background: #000;
  color: #f1f1f3; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  --accent: #4f8cff; --panel: rgba(18,18,22,.92); -webkit-font-smoothing: antialiased; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
svg { width: 24px; height: 24px; display: block; }
.app { position: absolute; inset: 0; --panelw: 360px; }
.stage { position: absolute; inset: 0; overflow: hidden; --ratio: .5; --pipw: .26; }
.app.panel-open .stage { right: var(--panelw); }
.captions { position: absolute; left: 50%; bottom: 96px; z-index: 4; transform: translateX(-50%); width: max-content; max-width: min(88%, 52em);
  text-align: center; pointer-events: none; transition: bottom .2s ease; --capscale: 1; }
.captions[hidden], .captions.empty { display: none; }
.idle .captions { bottom: 28px; }
.captions span { padding: .12em .45em; border-radius: 4px; background: rgba(0,0,0,.74); color: #fff;
  font-size: calc(clamp(15px, 1.8vw, 30px) * var(--capscale)); line-height: 1.5;
  -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.panel { position: absolute; top: 0; right: 0; bottom: 0; width: var(--panelw); z-index: 5; display: flex; flex-direction: column;
  background: #131317; border-left: 1px solid rgba(255,255,255,.08); }
.panel[hidden] { display: none; }
.presize { position: absolute; left: -5px; top: 0; bottom: 0; width: 10px; cursor: col-resize; touch-action: none; }
.phead { display: flex; align-items: center; gap: 6px; padding: 10px 8px 6px 16px; font-size: 15px; font-weight: 600; }
.phead .ptitle { flex: 1; }
.psearch { display: flex; align-items: center; gap: 2px; padding: 0 8px 8px 12px; }
.tsearch { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
  background: rgba(255,255,255,.06); color: inherit; font: inherit; font-size: 13px; }
.tsearch:focus { outline: none; border-color: var(--accent); }
.tcount { min-width: 4.5em; padding: 0 4px; font-size: 12px; text-align: right; white-space: nowrap; opacity: .7; }
.psearch .btn { width: 30px; height: 30px; }
.psearch .btn svg, .phead .btn svg { width: 20px; height: 20px; }
.phead .btn { width: 32px; height: 32px; }
.tlist { flex: 1; overflow-y: auto; padding: 2px 6px 56px; overscroll-behavior: contain; }
.trow { display: flex; gap: 10px; padding: 6px 8px; border-radius: 8px; cursor: pointer; font-size: 14px; line-height: 1.45;
  content-visibility: auto; contain-intrinsic-size: auto 44px; }
.trow:hover { background: rgba(255,255,255,.06); }
.trow .ts { flex: none; width: 4.4em; padding-top: 2px; font-size: 12px; font-variant-numeric: tabular-nums; opacity: .5; }
.trow.cur { background: rgba(79,140,255,.16); }
.trow.cur .ts { color: var(--accent); opacity: 1; }
.trow.hit .tx { background: linear-gradient(transparent 62%, rgba(255,196,0,.45) 62%); }
.tback { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); height: 32px; padding: 0 14px; border-radius: 16px;
  background: var(--accent); color: #fff; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
.tback[hidden] { display: none; }
.marks { position: absolute; left: 0; right: 0; top: 3px; height: 12px; pointer-events: none; }
.marks i { position: absolute; top: 0; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px; background: #ffc400; }
.tabs { display: flex; gap: 2px; flex: 1; min-width: 0; }
.tabs button { height: 32px; padding: 0 10px; border-radius: 8px; font-size: 13px; opacity: .7; white-space: nowrap; }
.tabs button:hover { background: rgba(255,255,255,.08); opacity: 1; }
.tabs button[aria-selected=true] { background: rgba(255,255,255,.12); opacity: 1; font-weight: 600; }
.pane { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pane[data-pane=notes], .pane[data-pane=discussion] { overflow-y: auto; padding: 0 12px 16px; overscroll-behavior: contain; }
.pextras { margin: 0 12px 8px; padding: 8px 10px; border-radius: 8px; background: rgba(255,196,0,.1); font-size: 12px; line-height: 1.45; }
.pextras button { margin-top: 4px; }
.pinfo { margin: 2px 0 10px; font-size: 12px; line-height: 1.45; opacity: .6; }
.pwarn { margin-bottom: 8px; padding: 7px 10px; border-radius: 8px; background: rgba(255,170,0,.14); color: #ffd38a; font-size: 12px; line-height: 1.4; }
.composer { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.composer.reply { margin: 10px 0 0; }
.input { width: 100%; padding: 8px 10px; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; background: rgba(255,255,255,.06);
  color: inherit; font: inherit; font-size: 13px; line-height: 1.45; resize: vertical; }
.input:focus { outline: none; border-color: var(--accent); }
.input.small { width: auto; padding: 4px 8px; }
select.input option { background: #1b1b20; }
.crow, .ptools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.ptools { margin-bottom: 10px; }
.grow { flex: 1; }
.check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; opacity: .85; }
.check input { accent-color: var(--accent); }
.counter { opacity: .6; } .counter.over { color: #ff8a80; opacity: 1; }
.pbtn { height: 30px; padding: 0 12px; border-radius: 8px; background: rgba(255,255,255,.1); font-size: 13px; }
.pbtn:hover { background: rgba(255,255,255,.16); }
.pbtn.primary { background: var(--accent); color: #fff; font-weight: 600; }
.pbtn:disabled { opacity: .45; cursor: default; }
.link { font-size: 12px; opacity: .75; padding: 2px 0; }
.link:hover { opacity: 1; text-decoration: underline; }
.link.on { color: var(--accent); opacity: 1; }
.link.danger:hover { color: #ff8a80; }
.perror { margin-bottom: 10px; padding: 7px 10px; border-radius: 8px; background: rgba(255,82,82,.14); color: #ffb4ab; font-size: 12px; }
.pempty { padding: 24px 8px; text-align: center; font-size: 13px; opacity: .55; line-height: 1.5; }
.pmuted { font-size: 12px; opacity: .55; }
.plist { display: flex; flex-direction: column; gap: 8px; }
.card { padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.045); border-left: 3px solid transparent; }
.card.k-note { border-left-color: #6ea8ff; } .card.k-bookmark { border-left-color: #4fd1a5; } .card.k-flag { border-left-color: #ff6b6b; }
.ihead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.ibody { margin-top: 6px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.iactions, .cactions { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; }
/* Tags (local, private) */
.itags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.tagchip, .tagopt { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 6px; border-radius: 10px;
  background: rgba(255,255,255,.08); color: inherit; font: inherit; font-size: 12px; border: 0; cursor: pointer; }
.tagchip i, .tagopt i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.tagopt { opacity: .6; } .tagopt.on { opacity: 1; background: rgba(255,255,255,.18); }
.tagopt:hover, .tagchip:hover { background: rgba(255,255,255,.16); }
.tagpick { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; border-radius: 8px; background: rgba(0,0,0,.25); }
.tagnew { flex-basis: 100%; display: flex; gap: 8px; align-items: center; }
.tagnew input { flex: 1; min-width: 0; }
.addtag { font-size: 12px; }
.tagman { padding: 10px 12px; margin-bottom: 10px; border-radius: 10px; background: rgba(255,255,255,.045); display: flex; flex-direction: column; gap: 8px; }
.tagrow { display: flex; gap: 8px; align-items: center; }
.tagrow input { flex: 1; min-width: 0; }
.tagswatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4); cursor: pointer; flex: none; padding: 0; }
.kind { font-weight: 600; } .kind.k-note { color: #9cc3ff; } .kind.k-bookmark { color: #7ee2bf; } .kind.k-flag { color: #ff9a9a; }
.chiptime { height: 22px; padding: 0 8px; border-radius: 11px; background: rgba(79,140,255,.18); color: #b9d2ff; font-size: 12px; font-variant-numeric: tabular-nums; }
.chiptime:hover { background: rgba(79,140,255,.32); }
.author { font-weight: 600; font-size: 13px; }
.badge { padding: 1px 6px; border-radius: 6px; font-size: 11px; }
.badge.inst { background: rgba(126,226,191,.16); color: #7ee2bf; }
.comment + .comment { margin-top: 10px; }
.replies { margin-top: 10px; padding-left: 12px; border-left: 2px solid rgba(255,255,255,.08); }
.comment.reply .ibody { font-size: 13px; }
.imarks { position: absolute; left: 0; right: 0; top: 0; height: 18px; pointer-events: none; }
.mk { position: absolute; top: 2px; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; box-shadow: 0 0 0 1.5px rgba(0,0,0,.6); }
.mk-note { background: #6ea8ff; }
.mk-laststop { top: -1px; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px; background: rgba(255,255,255,.75); box-shadow: none; }
.mk-bookmark { background: #4fd1a5; border-radius: 1px; }
.mk-flag { background: #ff6b6b; top: 1px; width: 4px; height: 8px; margin-left: -2px; border-radius: 1px; }
.mk-comment { background: #f3c969; transform: rotate(45deg); border-radius: 1px; }
.btn.flagbtn.active { color: #ff6b6b; }
.btn.bmbtn.active { color: #4fd1a5; }
.audiomenu { min-width: 260px; max-width: 320px; }
.audiomenu .opt { display: flex; flex-direction: column; align-items: stretch; gap: 2px; white-space: normal; }
.audiomenu .opt .row1 { display: flex; justify-content: space-between; gap: 16px; }
.audiomenu .opt .desc { font-size: 12px; opacity: .55; line-height: 1.35; }
.audiomenu .opt[aria-disabled=true] { opacity: .45; cursor: default; }
.audiomenu { max-height: calc(100% - 80px); overflow-y: auto; }
.qualitymenu { min-width: 200px; }
.copymenu { min-width: 260px; max-width: 320px; }
.copymenu .opt { display: flex; flex-direction: column; align-items: stretch; gap: 2px; white-space: normal; }
.copymenu .opt .row1 { display: flex; justify-content: space-between; gap: 16px; }
.copymenu .opt .key { opacity: .5; font-size: 12px; }
.copymenu .opt .desc { font-size: 12px; opacity: .55; line-height: 1.35; }
.copymenu .sub { padding: 6px 10px 0; font-size: 12px; opacity: .6; }
.copymenu .choices { display: flex; gap: 4px; padding: 4px 6px 2px; }
.copymenu .choices button { width: auto; flex: 1; text-align: center; padding: 6px 0; }
.qualitymenu .sub { padding: 8px 10px 2px; font-size: 12px; opacity: .6; }
.audiomenu .sep { height: 1px; margin: 6px 4px; background: rgba(255,255,255,.1); }
.audiomenu .silstatus { padding: 0 10px 6px; font-size: 12px; line-height: 1.4; opacity: .75; }
.audiomenu .sub { padding: 6px 10px 0; font-size: 12px; opacity: .6; }
.audiomenu .choices { display: flex; gap: 4px; padding: 4px 6px 2px; }
.audiomenu .choices button { width: auto; flex: 1; text-align: center; padding: 6px 0; }
.sils { position: absolute; inset: 0; }
.chaps { position: absolute; inset: 0; }
.chaps i { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: rgba(0,0,0,.75); }
.tip .pv { display: block; width: 176px; aspect-ratio: 16 / 9; object-fit: contain; margin: 2px 0 4px; border-radius: 4px; background: #000; }
.tip .pv[hidden] { display: none; }
.pane[data-pane=slides] { overflow-y: auto; padding: 0 12px 16px; overscroll-behavior: contain; }
.sstatus { padding: 4px 2px 8px; font-size: 12px; opacity: .65; }
.sscreen { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 2px 8px; font-size: 12px; }
.sscreen:empty { display: none; }
.sscreen > span { opacity: .65; }
.sview { padding: 2px 8px; border-radius: 10px; border: 1px solid rgba(255,255,255,.25); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.sview.on { background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.5); }
.slist { display: flex; flex-direction: column; gap: 8px; }
.scard { display: flex; gap: 10px; align-items: flex-start; width: 100%; padding: 6px; border-radius: 10px; text-align: left; }
.scard:hover { background: rgba(255,255,255,.07); }
.scard.cur { background: rgba(79,140,255,.18); box-shadow: inset 0 0 0 1px rgba(79,140,255,.6); }
.scard img, .scard .noimg { flex: none; width: 128px; aspect-ratio: 16 / 9; border-radius: 6px; background: #222; object-fit: contain; }
.slist[hidden], .sstatus[hidden], .reader[hidden], .chaptoggle[hidden] { display: none; }
.reader { padding: 4px 0 8px; }
.rstage { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background: #fff; }
.rpage { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; transition: opacity .18s ease; }
.rpage.in { opacity: 1; }
.rstale { position: absolute; inset: 0; z-index: 1; display: none; align-items: center; justify-content: center; padding: 12px; text-align: center;
  font-size: 13px; font-weight: 600; color: #fff; background: rgba(20,20,24,.72); }
.stale > .rstale { display: flex; }
.pstage .rstale { z-index: 2; font-size: 15px; }
.rbar { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.rnav { width: 32px; height: 28px; border-radius: 8px; font-size: 20px; line-height: 1; }
.rnav:hover:not(:disabled) { background: rgba(255,255,255,.1); }
.rnav:disabled { opacity: .3; cursor: default; }
.rlabel { flex: 1; text-align: center; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rfollow { margin-top: 6px; text-align: center; font-size: 12px; }
.rfollowing { opacity: .55; }
.rback { padding: 5px 12px; border-radius: 14px; background: var(--accent); color: #fff; font-weight: 600; }
.rtimes { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 8px; font-size: 12px; }
.rtl { opacity: .6; margin-right: 2px; }
.rtime { padding: 2px 8px; border-radius: 10px; background: rgba(255,255,255,.1); font-variant-numeric: tabular-nums; }
.rtime:hover { background: rgba(255,255,255,.18); }
.rfix { margin-top: 8px; font-size: 12px; }
.rfix summary { cursor: pointer; opacity: .6; }
.rfix[open] summary { opacity: .9; margin-bottom: 4px; }
.rfixbtn { display: block; width: 100%; text-align: left; padding: 5px 8px; border-radius: 6px; }
.rfixbtn:hover { background: rgba(255,255,255,.08); }
.rmain { display: block; width: 100%; margin-top: 6px; padding: 5px 8px; border-radius: 8px; font-size: 12px; background: rgba(255,255,255,.08); }
.rmain:hover { background: rgba(255,255,255,.14); }
.chaptoggle { display: block; margin: 6px 0; padding: 4px 0; font-size: 12px; color: var(--accent); }
.sdeck { padding: 8px 2px 4px; border-bottom: 1px solid rgba(255,255,255,.08); margin-bottom: 6px; }
.sfiles { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sfile { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 3px 4px 3px 10px; border-radius: 14px; background: rgba(255,255,255,.1); font-size: 12px; }
.sfname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.sfremove { width: 20px; height: 20px; border-radius: 50%; font-size: 11px; opacity: .7; }
.sfremove:hover { background: rgba(255,255,255,.15); opacity: 1; }
.sfadd { padding: 4px 10px; border-radius: 14px; font-size: 12px; color: var(--accent); }
.sfadd:hover { background: rgba(79,140,255,.12); }
.sdmsg { margin-top: 6px; font-size: 12px; line-height: 1.4; opacity: .65; }
.dropzone { position: absolute; inset: 12px; z-index: 6; display: flex; align-items: center; justify-content: center; border: 2px dashed var(--accent);
  border-radius: 16px; background: rgba(10,12,20,.75); font-size: 16px; pointer-events: none; }
.dropzone[hidden] { display: none; }
.smeta { min-width: 0; flex: 1; }
.stitle { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 600; }
.stitle .st { font-weight: 400; opacity: .65; font-variant-numeric: tabular-nums; }
.ssaid { margin-top: 3px; font-size: 12px; line-height: 1.35; opacity: .7; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sils i { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(135deg, rgba(255,255,255,.55) 0 1.5px, transparent 1.5px 4px); opacity: .8; }
.skipsil { position: absolute; z-index: 5; right: 14px; bottom: 96px; height: 34px; padding: 0 14px; border-radius: 17px; background: var(--panel);
  font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.4); transition: opacity .4s ease; }
.skipsil:hover { background: #2a2a31; }
.skipsil.fade { opacity: 0; pointer-events: none; }
.endnote { position: absolute; z-index: 5; right: 14px; bottom: 96px; display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 14px;
  border-radius: 18px; background: var(--panel); box-shadow: 0 4px 16px rgba(0,0,0,.4); font-size: 13px; }
.endnote[hidden] { display: none; }
.endnote button { height: 28px; padding: 0 12px; border-radius: 14px; background: rgba(255,255,255,.12); }
.endnote .endclose { width: 28px; padding: 0; background: none; opacity: .7; }
.sils i.empty { opacity: 1; filter: brightness(1.4); }
.audiomenu .why { padding: 4px 10px 6px; font-size: 12px; line-height: 1.4; color: #ffd38a; }
.ccmenu .opt { display: flex; justify-content: space-between; gap: 16px; }
.ccmenu .sizes { display: flex; gap: 4px; padding: 4px 6px 2px; }
.ccmenu .sizes button { width: auto; flex: 1; text-align: center; padding: 6px 0; }
.top .tbtn { display: inline-flex; align-items: center; gap: 6px; }
.top .tbtn svg { width: 18px; height: 18px; }
@media (max-width: 720px) {
  .top .chip .lbl { display: none; }
  .app.panel-open .stage { right: 0; }
  .panel { width: 100%; }
  .presize { display: none; }
}
.views { position: absolute; inset: 0; }
video, .pdfview { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
[data-slot=off] { display: none !important; }
.l-single :is(video, .pdfview)[data-slot=secondary] { display: none; }
.l-side :is(video, .pdfview)[data-slot=primary] { width: calc(var(--ratio) * 100%); }
.l-side :is(video, .pdfview)[data-slot=secondary] { left: auto; right: 0; width: calc((1 - var(--ratio)) * 100%); }
/* The lecturer's PDF as a picture of its own (see SlideReader). */
.pdfview { background: #1a1a1d; overflow: hidden; }
.pstage { position: absolute; inset: 0; }
.rpages { position: absolute; inset: 0; }
.pstage .rpage { position: absolute; left: 50%; top: 50%; width: auto; height: auto; max-width: 100%; max-height: 100%; transform: translate(-50%, -50%); }
.pbar { position: absolute; left: 50%; top: 58px; z-index: 3; display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-radius: 16px;
  max-width: calc(100% - 16px); overflow: hidden; transform: translateX(-50%); background: rgba(18,18,22,.82); font-size: 12px; white-space: nowrap;
  transition: opacity .2s ease; }
.pfollow { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.idle .pbar { opacity: 0; pointer-events: none; }
.pnav { width: 26px; height: 24px; border-radius: 8px; font-size: 15px; line-height: 1; }
.pnav:hover:not(:disabled) { background: rgba(255,255,255,.12); }
.pnav:disabled { opacity: .3; }
.plabel { padding: 0 4px; font-variant-numeric: tabular-nums; }
.pfollow .rback { padding: 3px 10px; font-size: 12px; }
.pfollow .rfollowing { opacity: .6; padding: 0 6px; }
.l-pip .pdfview[data-slot=secondary] .pbar { display: none; }
.divider { position: absolute; top: 0; bottom: 0; left: calc(var(--ratio) * 100%); width: 16px; margin-left: -8px; cursor: col-resize; z-index: 3; display: none; touch-action: none; }
.divider::after { content: ""; position: absolute; left: 7px; top: 50%; width: 2px; height: 48px; margin-top: -24px; border-radius: 1px; background: rgba(255,255,255,.35); transition: background .15s ease; }
.divider:hover::after, .divider.dragging::after { background: var(--accent); }
.l-side .divider { display: block; }
.l-pip :is(video, .pdfview)[data-slot=secondary], .pipframe { left: auto; top: auto; width: calc(var(--pipw) * 100%); height: auto; aspect-ratio: 16 / 9; }
.l-pip :is(video, .pdfview)[data-slot=secondary] { z-index: 2; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.55); }
.pipframe { position: absolute; z-index: 3; display: none; border-radius: 10px; cursor: grab; touch-action: none; }
.pipframe.dragging { cursor: grabbing; }
.l-pip .pipframe { display: block; }
.pipframe:hover { box-shadow: inset 0 0 0 2px rgba(255,255,255,.5); }
.grip { position: absolute; width: 18px; height: 18px; opacity: 0; transition: opacity .15s ease; touch-action: none; }
.grip::before { content: ""; position: absolute; inset: 4px; border: 2px solid #fff; border-radius: 2px; }
.pipframe:hover .grip { opacity: .9; }
.l-pip.c-br :is(video, .pdfview)[data-slot=secondary], .l-pip.c-br .pipframe { right: 16px; bottom: 84px; }
.l-pip.c-bl :is(video, .pdfview)[data-slot=secondary], .l-pip.c-bl .pipframe { left: 16px; bottom: 84px; }
.l-pip.c-tr :is(video, .pdfview)[data-slot=secondary], .l-pip.c-tr .pipframe { right: 16px; top: 64px; }
.l-pip.c-tl :is(video, .pdfview)[data-slot=secondary], .l-pip.c-tl .pipframe { left: 16px; top: 64px; }
.c-br .grip { left: 0; top: 0; cursor: nwse-resize; }
.c-bl .grip { right: 0; top: 0; cursor: nesw-resize; }
.c-tr .grip { left: 0; bottom: 0; cursor: nesw-resize; }
.c-tl .grip { right: 0; bottom: 0; cursor: nwse-resize; }
.layoutmenu button { display: flex; align-items: center; gap: 10px; }
.layoutmenu svg { width: 20px; height: 20px; }
.top, .bottom { position: absolute; left: 0; right: 0; transition: opacity .2s ease; }
.top { top: 0; z-index: 4; display: flex; align-items: center; gap: 8px; padding: 10px 14px 28px;
  background: linear-gradient(rgba(0,0,0,.72), rgba(0,0,0,0)); }
/* The bar's background (a gradient over the picture) lets clicks through: only its buttons
   and title take them, so toolbars and windows near the top stay usable. */
.top { pointer-events: none; }
.top > * { pointer-events: auto; }
.bottom { bottom: 0; z-index: 4; padding: 28px 14px 8px; background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,.78)); }
.idle .top, .idle .bottom { opacity: 0; pointer-events: none; }
.idle { cursor: none; }
.back { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; color: inherit; text-decoration: none; flex: none; }
.back:hover { background: rgba(255,255,255,.12); }
.title { flex: 0 1 auto; margin-right: auto; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { flex: none; height: 30px; padding: 0 12px; border-radius: 15px; background: rgba(255,255,255,.12); font-size: 13px; }
.chip:hover { background: rgba(255,255,255,.2); }
.seek { position: relative; height: 18px; margin: 0 2px 2px; cursor: pointer; touch-action: none; --p: 0; --b: 0; --h: 0; }
.rail { position: absolute; left: 0; right: 0; top: 7px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.22); overflow: hidden; transition: transform .12s ease; }
.seek:hover .rail, .seek.dragging .rail { transform: scaleY(1.5); }
.bar { position: absolute; inset: 0; transform-origin: 0 50%; }
.buf { background: rgba(255,255,255,.32); transform: scaleX(var(--b)); }
.hov { background: rgba(255,255,255,.28); transform: scaleX(var(--h)); opacity: 0; }
.seek:hover .hov { opacity: 1; }
.fill { background: var(--accent); transform: scaleX(var(--p)); }
.knob-track { position: absolute; inset: 0; transform: translateX(calc(var(--p) * 100%)); pointer-events: none; }
.knob { position: absolute; left: -7px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 3px rgba(79,140,255,.25); transform: scale(0); transition: transform .12s ease; }
.seek:hover .knob, .seek.dragging .knob { transform: scale(1); }
.tip { position: absolute; bottom: 22px; left: 0; padding: 3px 7px; border-radius: 6px; background: var(--panel); font-size: 12px;
  font-variant-numeric: tabular-nums; white-space: nowrap; transform: translateX(-50%); pointer-events: none; opacity: 0; }
.seek:hover .tip, .seek.dragging .tip { opacity: 1; }
.row { display: flex; align-items: center; gap: 2px; height: 44px; }
.btn { width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; flex: none; }
.btn:hover { background: rgba(255,255,255,.12); }
.btn.active { color: var(--accent); }
.time { margin: 0 10px; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; opacity: .92; }
.spacer { flex: 1; }
.vol { display: flex; align-items: center; }
.vol input { width: 0; opacity: 0; transition: width .15s ease, opacity .15s ease; }
.vol:hover input, .vol input:focus-visible { width: 84px; opacity: 1; margin: 0 6px 0 2px; }
input[type=range] { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; cursor: pointer;
  background: linear-gradient(to right, #fff var(--v, 100%), rgba(255,255,255,.3) var(--v, 100%)); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #fff; }
input[type=range]::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: #fff; }
.qbtn { min-width: 52px; height: 32px; padding: 0 8px; border-radius: 16px; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.qbtn:hover { background: rgba(255,255,255,.12); }
.speed { min-width: 52px; height: 32px; padding: 0 8px; border-radius: 16px; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.speed:hover { background: rgba(255,255,255,.12); }
.src { height: 32px; padding: 0 10px; border-radius: 16px; display: inline-flex; align-items: center; gap: 4px; font-size: 13px; }
.src svg { width: 18px; height: 18px; }
.src:hover { background: rgba(255,255,255,.12); }
.menu { position: absolute; z-index: 5; right: 14px; bottom: 64px; min-width: 120px; padding: 6px; border-radius: 12px; background: var(--panel);
  box-shadow: 0 8px 30px rgba(0,0,0,.45); backdrop-filter: blur(8px); }
.menu[hidden] { display: none; }
.menu .head { padding: 4px 10px 6px; font-size: 12px; opacity: .6; }
.menu button { display: block; width: 100%; text-align: left; padding: 7px 10px; border-radius: 8px; font-variant-numeric: tabular-nums; }
.menu button:hover { background: rgba(255,255,255,.1); }
.menu button[aria-checked=true] { color: var(--accent); font-weight: 600; }
.center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none; }
.spinner { width: 46px; height: 46px; border-radius: 50%; border: 3px solid rgba(255,255,255,.2); border-top-color: #fff;
  animation: spin .9s linear infinite; display: none; }
.waiting .spinner { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
/* Paused: a small label in the title bar instead of a big icon over the picture. */
.pausehint { flex: none; display: none; align-items: center; gap: 6px; padding: 4px 10px 4px 8px; margin-right: auto;
  border-radius: 14px; background: rgba(255,255,255,.12); font-size: 12px; pointer-events: none; }
.pausehint svg { width: 14px; height: 14px; }
.paused:not(.waiting) .pausehint { display: inline-flex; }
.paused:not(.waiting) .title { margin-right: 0; }
.paused.hidecc-paused .captions { display: none; }
/* Session renewal in progress: a small label in the corner, never over the controls. */
.sessionhint { position: absolute; right: 12px; top: 60px; z-index: 5; display: flex; align-items: center; gap: 8px;
  padding: 5px 12px 5px 9px; border-radius: 14px; background: rgba(20,20,24,.82); color: #eee; font-size: 12px;
  pointer-events: none; }
.sessionhint[hidden] { display: none; }
.sessionhint i { width: 10px; height: 10px; border-radius: 50%; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff;
  animation: spin .9s linear infinite; }
.toast { position: absolute; z-index: 5; left: 50%; bottom: 96px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px;
  padding: 9px 10px 9px 16px; border-radius: 12px; background: var(--panel); font-size: 13px; box-shadow: 0 8px 30px rgba(0,0,0,.4); max-width: calc(100% - 28px); }
.toast[hidden] { display: none; }
.toast button { color: var(--accent); font-weight: 600; padding: 4px 8px; border-radius: 6px; }
.toast button:hover { background: rgba(255,255,255,.08); }
.error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.7); }
.error[hidden] { display: none; }
.error .card { max-width: 420px; margin: 16px; padding: 20px 22px; border-radius: 14px; background: #1b1b20; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
.error .card h2 { margin: 0 0 8px; font-size: 16px; }
.error .card p { margin: 0 0 16px; opacity: .8; }
.error .card .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
/* Watched before (this device): faint, under the buffer and the other marks */
.wat { position: absolute; inset: 0; pointer-events: none; }
.wat i { position: absolute; top: 0; bottom: 0; background: rgba(255,255,255,.16); }
/* A-B loop band on the progress bar */
.loopband { position: absolute; top: 2px; height: 14px; z-index: 2; border-radius: 4px; pointer-events: none;
  background: rgba(246,195,67,.22); box-shadow: inset 0 0 0 1.5px rgba(246,195,67,.9); min-width: 2px; }
.loopband[hidden] { display: none; }
.loopband.open { background: none; }
.loopband .lh { position: absolute; top: -3px; width: 8px; height: 20px; margin-left: -4px; border-radius: 3px; background: #f6c343;
  pointer-events: auto; cursor: ew-resize; touch-action: none; }
.loopband .la { left: 0; } .loopband .lb { left: 100%; }
.loopband.open .lb { display: none; }
.loopband .lx { position: absolute; right: -6px; top: -22px; width: 18px; height: 18px; padding: 0; border-radius: 50%; font-size: 11px; line-height: 18px;
  text-align: center; background: #f6c343; color: #111; pointer-events: auto; }
.loopmenu { right: auto; min-width: 180px; }
/* Zoom: overview of the visible part, and the hand while dragging. */
.zmap { position: absolute; z-index: 3; border: 1px solid rgba(255,255,255,.75); border-radius: 4px; background: rgba(0,0,0,.4);
  pointer-events: none; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
.zmap[hidden] { display: none; }
.zmap i { position: absolute; border: 1.5px solid #fff; background: rgba(255,255,255,.2); border-radius: 2px; }
.views .zoomed { cursor: grab; }
.views .panning { cursor: grabbing; }
.keyhelp, .diagbox { position: absolute; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.6); }
.keyhelp[hidden], .diagbox[hidden] { display: none; }
.khcard { max-width: min(640px, calc(100% - 32px)); max-height: calc(100% - 32px); overflow: auto; padding: 18px 22px; border-radius: 14px;
  background: #1b1b20; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
.khcard h2 { margin: 0 0 12px; font-size: 16px; }
.khlist { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 13px; margin-bottom: 14px; }
.khlist kbd { display: inline-block; min-width: 1.4em; padding: 1px 6px; margin-right: 3px; border-radius: 5px; text-align: center;
  background: rgba(255,255,255,.12); font: 12px/1.6 ui-monospace, monospace; }
.khcard .actions { display: flex; justify-content: flex-end; gap: 8px; }
.diaginfo { margin: 0 0 10px; font-size: 13px; opacity: .75; }
.diagtext { max-height: 50vh; overflow: auto; margin: 0 0 14px; padding: 10px 12px; border-radius: 8px; background: rgba(255,255,255,.06);
  font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }
.moremenu { min-width: 260px; }
.moremenu .row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; font-size: 13px; }
.moremenu .row .grow { flex: 1; opacity: .8; }
.moremenu .row button { width: auto; padding: 4px 10px; background: rgba(255,255,255,.1); }
.kbtn { font-weight: 700; min-width: 32px; justify-content: center; }
.error .card button { height: 34px; padding: 0 14px; border-radius: 8px; background: rgba(255,255,255,.1); }
.error .card button.primary { background: var(--accent); color: #fff; }
@media (max-width: 560px) {
  .hide-sm { display: none !important; }
  .top { padding: 6px 8px 22px; }
  .bottom { padding: 22px 6px 4px; }
  .time { margin: 0 6px; font-size: 12px; }
  .btn { width: 36px; height: 36px; }
}
`;

function playerTemplate() {
  return `
<div class="app">
<div class="stage paused l-single c-br">
  <div class="views">
    <video class="clock" playsinline preload="auto" data-slot="primary"></video>
    <video class="follower" playsinline preload="auto" muted data-slot="secondary"></video>
    <div class="pdfview" data-slot="off">
      <div class="pstage"></div>
      <div class="pbar">
        <button class="pnav pprev" title="${t('prevPage')}" aria-label="${t('prevPage')}">‹</button>
        <span class="plabel"></span>
        <button class="pnav pnext" title="${t('nextPage')}" aria-label="${t('nextPage')}">›</button>
        <span class="pfollow"></span>
        <button class="pnav pswap" title="${t('pdfSwap')}" aria-label="${t('pdfSwap')}">⇄</button>
        <button class="pnav pdfclose" title="${t('pdfMainClose')}" aria-label="${t('pdfMainClose')}">✕</button>
      </div>
    </div>
    <div class="divider" role="separator" aria-orientation="vertical" aria-label="${t('resizeViews')}" tabindex="0"></div>
    <div class="pipframe" title="${t('pipHint')}"><div class="grip" title="${t('resizePip')}"></div></div>
  </div>
  <div class="captions" hidden><span></span></div>
  <div class="center"><div class="spinner"></div></div>
  <div class="sessionhint" role="status" hidden><i></i><span>${t('sessionRenewing')}</span></div>
  <div class="top">
    <a class="back" title="${t('back')}" aria-label="${t('back')}">${svg('back')}</a>
    <div class="title"></div>
    <span class="pausehint" aria-hidden="true">${svg('pause')}<span>${t('pausedHint')}</span></span>
 <button class="chip tbtn" data-open="transcript" hidden aria-pressed="false" title="${t('transcriptKey')}">${svg('transcript')}<span class="lbl">${t('transcript')}</span></button>
    <button class="chip tbtn" data-open="slides" hidden aria-pressed="false" title="${t('slidesKey')}">${svg('slides')}<span class="lbl">${t('slides')}</span></button>
    <button class="chip tbtn" data-open="notes" hidden aria-pressed="false" title="${t('notes')}">${svg('notes')}<span class="lbl">${t('notes')}</span></button>
    <button class="chip tbtn" data-open="discussion" hidden aria-pressed="false" title="${t('discussion')}">${svg('discussion')}<span class="lbl">${t('discussion')}</span></button>
    <button class="chip kbtn" title="${t('keysTitle')} (?)" aria-label="${t('keysTitle')}">?</button>
    <button class="chip orig" title="${t('originalPlayerTitle')}">${t('originalPlayer')}</button>
  </div>
  <div class="bottom">
    <div class="seek" role="slider" aria-label="${t('seek')}" tabindex="0">
      <div class="rail"><div class="wat"></div><div class="bar buf"></div><div class="sils"></div><div class="chaps"></div><div class="bar hov"></div><div class="bar fill"></div></div>
      <div class="imarks"></div>
      <div class="marks"></div>
      <div class="knob-track"><div class="knob"></div></div>
      <div class="tip"><img class="pv" alt="" hidden><span class="tt">0:00</span></div>
    </div>
    <div class="row">
      <button class="btn play" title="${t('play')}" aria-label="${t('play')}">${svg('play')}</button>
      <button class="btn rew hide-sm" title="${t('rewind')}" aria-label="${t('rewind')}">${svg('back10')}</button>
      <button class="btn fwd hide-sm" title="${t('forward')}" aria-label="${t('forward')}">${svg('fwd10')}</button>
      <div class="vol">
        <button class="btn mute" title="${t('mute')}" aria-label="${t('mute')}">${svg('volume')}</button>
        <input class="volume hide-sm" type="range" min="0" max="1" step="0.01" aria-label="${t('volume')}">
      </div>
      <div class="time"><span class="cur">0:00</span> / <span class="dur">0:00</span></div>
      <div class="spacer"></div>
      <button class="btn bmbtn hide-sm" hidden title="${t('bookmarkKey')}" aria-label="${t('bookmark')}">${svg('bookmark')}</button>
      <button class="btn flagbtn hide-sm" hidden title="${t('flagKey')}" aria-label="${t('flag')}" aria-pressed="false">${svg('flag')}</button>
      <button class="btn copybtn" title="${t('copy')}" aria-label="${t('copy')}" aria-haspopup="menu">${svg('copy')}</button>
      <button class="btn audiobtn hide-sm" title="${t('audio')}" aria-label="${t('audio')}" aria-haspopup="menu">${svg('audio')}</button>
      <button class="btn ccbtn" hidden title="${t('captionsKey')}" aria-label="${t('captions')}" aria-haspopup="menu">${svg('cc')}</button>
      <button class="btn swap" title="${t('swapViews')}" aria-label="${t('swapViews')}">${svg('swap')}</button>
      <button class="btn layout" title="${t('layout')}" aria-label="${t('layout')}" aria-haspopup="menu">${svg('layoutSide')}</button>
      <button class="qbtn hide-sm" title="${t('quality')}" aria-label="${t('quality')}" aria-haspopup="menu"></button>
      <button class="speed" title="${t('speed')}" aria-label="${t('speed')}">1x</button>
      <button class="btn popbtn" hidden aria-pressed="false" title="${t('popout')} (W)" aria-label="${t('popout')}">${svg('popout')}</button>
      <button class="btn fs" title="${t('fullscreen')}" aria-label="${t('fullscreen')}">${svg('fullscreen')}</button>
      <button class="btn morebtn" title="${t('moreMenu')}" aria-label="${t('moreMenu')}" aria-haspopup="menu">${svg('more')}</button>
    </div>
  </div>
  <div class="menu qualitymenu" hidden role="menu"></div>
  <div class="menu speedmenu" hidden role="menu"><div class="head">${t('speed')}</div></div>
  <div class="menu layoutmenu" hidden role="menu"><div class="head">${t('layout')}</div>
    <button role="menuitemradio" data-layout="side">${svg('layoutSide')}${t('layoutSide')}</button>
    <button role="menuitemradio" data-layout="pip">${svg('layoutPip')}${t('layoutPip')}</button>
    <button role="menuitemradio" data-layout="single">${svg('layoutSingle')}${t('layoutSingle')}</button>
  </div>
  <div class="menu ccmenu" hidden role="menu"><div class="head">${t('captions')}</div>
    <button class="opt cctoggle" role="menuitemcheckbox" aria-checked="false"><span>${t('showCaptions')}</span><span class="state"></span></button>
    <button class="opt cchidepaused" role="menuitemcheckbox" aria-checked="true"><span>${t('hideCaptionsPaused')}</span><span class="state"></span></button>
    <div class="head">${t('captionSize')}</div>
    <div class="sizes">
      <button role="menuitemradio" data-size="s">S</button><button role="menuitemradio" data-size="m">M</button><button role="menuitemradio" data-size="l">L</button><button role="menuitemradio" data-size="xl">XL</button>
    </div>
  </div>
  <div class="menu copymenu" hidden role="menu"><div class="head">${t('copy')}</div>
    <button class="opt" role="menuitem" data-copy="frame"><span class="row1"><span>${t('copyFrame')}</span><span class="key">P</span></span><span class="desc">${t('copyFrameDesc')}</span></button>
    <button class="opt" role="menuitem" data-copy="captions"><span class="row1"><span>${t('copyCaptions')}</span><span class="key">A</span></span><span class="desc">${t('copyCaptionsDesc')}</span></button>
    <div class="sub">${t('copyCaptionsSpan')}</div>
    <div class="choices copyspan">${[30, 60, 120, 300].map((s) => `<button role="menuitemradio" data-span="${s}">${s < 60 ? s + 's' : s / 60 + 'm'}</button>`).join('')}</div>
  </div>
  <div class="menu moremenu" hidden role="menu"></div>
  <div class="diagbox" hidden role="dialog" aria-label="${t('diagTitle')}"><div class="khcard"><h2>${t('diagTitle')}</h2>
    <p class="diaginfo">${t('diagInfo')}</p><pre class="diagtext"></pre>
    <div class="actions"><button class="pbtn diagcopy">${t('diagCopy')}</button><button class="pbtn diagclose">${t('close')}</button></div></div></div>
  <div class="menu audiomenu" hidden role="menu"><div class="head">${t('audio')}</div>
    <div class="why" hidden></div>
    <button class="opt" role="menuitemcheckbox" data-audio="level" aria-checked="false"><span class="row1"><span>${t('audioLevel')}</span><span class="state"></span></span><span class="desc">${t('audioLevelDesc')}</span></button>
    <button class="opt" role="menuitemcheckbox" data-audio="voice" aria-checked="false"><span class="row1"><span>${t('audioVoice')}</span><span class="state"></span></span><span class="desc">${t('audioVoiceDesc')}</span></button>
    <button class="opt" role="menuitemcheckbox" data-audio="mono" aria-checked="false"><span class="row1"><span>${t('audioMono')}</span><span class="state"></span></span><span class="desc">${t('audioMonoDesc')}</span></button>
    <div class="sep"></div>
    <div class="head">${t('silence')}</div>
    <div class="silstatus"></div>
    <button class="opt" role="menuitemcheckbox" data-sil="auto" aria-checked="false"><span class="row1"><span>${t('silenceAuto')}</span><span class="state"></span></span><span class="desc">${t('silenceAutoDesc')}</span></button>
    <div class="sub">${t('silenceMin')}</div>
    <div class="choices silmin">${SILENCE_MIN_CHOICES.map((s) => `<button role="menuitemradio" data-min="${s}">${s < 60 ? s + 's' : s / 60 + 'm'}</button>`).join('')}</div>
    <div class="sens"><div class="sub">${t('silenceSensitivity')}</div>
    <div class="choices silsens"><button role="menuitemradio" data-sens="low">${t('low')}</button><button role="menuitemradio" data-sens="normal">${t('normal')}</button><button role="menuitemradio" data-sens="high">${t('high')}</button></div></div>
  </div>
  <button class="skipsil fade" tabindex="-1"></button>
  <div class="endnote" hidden role="status"><span>${t('contentEnded')}</span>
    <button class="endskip">${t('contentEndSkip')}</button><button class="endstop">${t('contentEndStop')}</button>
    <button class="endclose" aria-label="${t('close')}">✕</button></div>
  <div class="toast" hidden><span class="msg"></span><button class="act"></button></div>
  <div class="dropzone" hidden>${t('dropSlides')}</div>
  <div class="error" hidden><div class="card"><h2></h2><p></p><div class="actions"></div></div></div>
  <div class="keyhelp" hidden role="dialog" aria-label="${t('keysTitle')}"><div class="khcard"><h2>${t('keysTitle')}</h2><div class="khlist"></div>
    <div class="actions"><button class="pbtn khclose">${t('close')}</button></div></div></div>
</div>
<aside class="panel" hidden aria-label="${t('sidebarTabs')}">
  <div class="presize" title="${t('resizePanel')}"></div>
  <div class="phead">
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="transcript" hidden>${t('transcript')}</button>
      <button role="tab" data-tab="slides" hidden>${t('slides')}</button>
      <button role="tab" data-tab="notes" hidden>${t('notes')}</button>
      <button role="tab" data-tab="discussion" hidden>${t('discussion')}</button>
    </div>
    <button class="btn panelclose" title="${t('closePanel')}" aria-label="${t('closePanel')}">${svg('close')}</button>
  </div>
  <div class="pextras" hidden><div class="msg"></div><button class="link">${t('openInOriginal')}</button></div>
  <section class="pane" data-pane="transcript" hidden>
    <div class="psearch">
      <input class="tsearch" type="search" placeholder="${t('searchTranscript')}" aria-label="${t('searchTranscript')}">
      <span class="tcount" aria-live="polite"></span>
      <button class="btn tprev" title="${t('prevMatch')}" aria-label="${t('prevMatch')}">${svg('up')}</button>
      <button class="btn tnext" title="${t('nextMatch')}" aria-label="${t('nextMatch')}">${svg('down')}</button>
    </div>
    <div class="tlist" tabindex="0"></div>
    <button class="tback" hidden>${t('backToCurrent')}</button>
  </section>
  <section class="pane" data-pane="slides" hidden></section>
  <section class="pane" data-pane="notes" hidden></section>
  <section class="pane" data-pane="discussion" hidden></section>
</aside>
</div>`;
}
