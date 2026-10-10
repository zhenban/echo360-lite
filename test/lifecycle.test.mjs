// Regression tests for the device and lifecycle audit of 2026-10-09 (cancelled and
// concurrent touches, several tabs, files replaced or closed while work is running, the
// floating window). Each test fails on 0.15.2 and passes after the fix.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Window } from 'happy-dom';

const src = new URL('../src/', import.meta.url);
const code = readdirSync(src).filter((f) => f.endsWith('.js') && f !== '90-main.js').sort().map((f) => readFileSync(new URL(f, src), 'utf8')).join('\n');
const names = 'Disposer,Popovers,BAR_OVERFLOW,SPEED_STOPS,VolumeControl,KeyboardShortcuts,VOLUME_STEP,VOLUME_WHEEL_PX,VOLUME_OSD_MS,SettingsMenu,Tooltips,SpeedControl,MenuBar,setUnavailable,nextSpeed,snapSpeed,TranscriptPanel,Stream,TagStore,idbCache,SlideReader,DiscussionPane,NotesPane,LayoutControls,CaptionsView,FrameTask,SlideAnalyzer,HlsVideoReader,SeekBar,SlideDeckController,ABLoop,Zoomer,playerTemplate,PLAYER_CSS,'
  + 'setPdfLib: (lib) => { pdfjsPromise = Promise.resolve(lib); }';

// The sources in a page of their own; nothing reaches the network.
async function withPage(run) {
  const w = new Window({ url: 'https://example.test/', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  w.fetch = () => { throw new Error('network forbidden in tests'); };
  w.Hls = { isSupported: () => false };
  const m = w.eval('(function () { const VERSION = "test";\n' + code + '\nreturn {' + names + '}; })()');
  try { return await run(w, m); } finally { await w.happyDOM.abort(); w.close(); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const pointer = (w, type, init) => new w.PointerEvent(type, Object.assign({ bubbles: true, button: 0, pointerType: 'touch' }, init));

test('audit 1: controls hidden with the title bar and bottom bar take no taps', async () => withPage(async (w, m) => {
  // One player shown, one hidden (happy-dom keeps a computed style after a class change).
  const player = (idle) => {
    const host = w.document.createElement('div');
    w.document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + m.PLAYER_CSS + '</style>' + m.playerTemplate();
    root.querySelector('.seek').insertAdjacentHTML('beforeend', '<div class="loopband"><i class="lh"></i></div>');   // where ABLoop puts it
    if (idle) root.querySelector('.stage').classList.add('idle');
    return (sel) => w.getComputedStyle(root.querySelector(sel)).pointerEvents;
  };
  const shown = player(false);
  const hidden = player(true);
  assert.equal(shown('.morebtn'), 'auto', 'clickable while shown');
  assert.equal(shown('.loopband .lh'), 'auto', 'loop handles draggable while shown');
  assert.equal(hidden('.morebtn'), 'none', 'the settings button while hidden');
  assert.equal(hidden('.loopband .lh'), 'none', 'the loop handles while hidden');
}));

test('audit 2: two tabs of one course both keep their new tags', async () => withPage(async (w, m) => {
  const db = new Map();
  m.idbCache.get = async (k) => structuredClone(db.get(k));
  m.idbCache.put = async (k, v) => { db.set(k, structuredClone(v)); };
  m.idbCache.update = async (k, fn) => { const next = fn(structuredClone(db.get(k))); if (next === undefined) db.delete(k); else db.set(k, structuredClone(next)); return structuredClone(next); };
  const a = new m.TagStore({ sectionId: 'course', mediaId: 'one' });
  const b = new m.TagStore({ sectionId: 'course', mediaId: 'two' });
  await a.load();
  await b.load();
  a.create('from A');
  await tick();
  b.create('from B');
  await tick();
  const saved = db.get('tags:course').tags.map((t) => t.name);
  assert.ok(saved.includes('from A') && saved.includes('from B'), saved.join(','));
  // A deletion in one tab is not undone by the other tab's next change.
  a.remove(b.tags.find((t) => t.name === 'from B').id);
  await tick();
  b.create('again B');
  await tick();
  const after = db.get('tags:course').tags.map((t) => t.name);
  assert.equal(after.includes('from B'), false, after.join(','));
  assert.ok(b.tags.some((t) => t.name === 'from A'), 'the other tab sees the stored list');
}));

test('audit 3: a shorter PDF while browsing a later page: the reader stays on a valid page', async () => withPage(async (w, m) => {
  const page = (k) => ({ key: 'f:' + k, num: k + 1, ar: 0.5625, file: 'f.pdf' });
  const deck = { pages: Array.from({ length: 20 }, (v, k) => page(k)), files: [{}], sampleAt: () => 0, unrecognisedFor: () => 0, pageAt: () => -1, render: async () => w.document.createElement('canvas') };
  const r = new m.SlideReader({ deck, video: { currentTime: 0 } });
  r.addTarget('main', w.document.createElement('div'));
  r.targets.get('main').active = true;
  r.follow = false;
  r.showPage(19, true);
  deck.pages = deck.pages.slice(0, 2);
  r.update(0, true);
  assert.equal(r.currentView(), 1);
  assert.equal(r.label().length > 0, true);
  // The same page, moved: found by its key.
  deck.pages = [page(5), page(0), page(1)];
  r.showPage(2, true);
  deck.pages = [page(1), page(5)];
  assert.equal(r.currentView(), 0);
}));

test('audit 4: a reply that fails keeps the draft and the error after the list reloads', async () => withPage(async (w, m) => {
  const q = { id: 'q', body: 'question', author: 'author', replies: [] };
  const api = { discussions: async () => ({ threads: [q], hiddenCount: 0 }) };
  const d = new m.Disposer();
  const pane = w.document.createElement('div');
  const r = new m.DiscussionPane({ video: { currentTime: 1 }, duration: () => 100, updateMarkers() {}, opts: {} }, pane, api, d);
  r.visible = true;
  r.threads = [q];
  r.replyOpen = 'q';
  r.render();
  const area = pane.querySelector('.composer.reply textarea');
  area.value = 'important unsent draft';
  area.dispatchEvent(new w.Event('input'));
  const ok = await r.write({}, async () => { throw new Error('HTTP 500'); });
  assert.equal(ok, false);
  r.render();
  assert.equal(pane.querySelector('.composer.reply textarea').value, 'important unsent draft');
  assert.equal(r.errorEl.hidden, false);
  d.dispose();
}));

test('audit 4b: a note being edited survives a redraw of the list', async () => withPage(async (w, m) => {
  const d = new m.Disposer();
  const pane = w.document.createElement('div');
  const p = { video: { currentTime: 0 }, duration: () => 100, updateMarkers() {}, tags: { tags: [], byId: () => null, of: () => [] }, lesson: {}, sidebar: { has: () => false } };
  const notes = new m.NotesPane(p, pane, {}, false, d);
  notes.items = [{ id: 'n1', type: 'note', time: 5, text: 'old text', createdAt: '' }];
  notes.visible = true;
  notes.render();
  const card = pane.querySelector('.card[data-id="n1"]');
  notes.startEdit(notes.items[0], card);
  const area = card.querySelector('textarea');
  area.value = 'half-typed change';
  area.dispatchEvent(new w.Event('input'));
  notes.render();   // e.g. a tag was added to another note
  assert.equal(pane.querySelector('.card[data-id="n1"] textarea').value, 'half-typed change');
  d.dispose();
}));

test('audit 5: a cancelled touch on the picture-in-picture window does not swap the pictures', async () => withPage(async (w, m) => {
  const stage = w.document.createElement('div');
  stage.innerHTML = '<div class="divider"></div><div class="pipframe"><div class="grip"></div></div>';
  const frame = stage.querySelector('.pipframe');
  frame.setPointerCapture = () => {};
  let swaps = 0;
  const d = new m.Disposer();
  new m.LayoutControls({ $: (s) => stage.querySelector(s), stage, prefs: { ratio: 0.5, pipw: 0.26, corner: 'br' }, ui: {}, onPipClick: () => swaps++, savePrefs() {}, redrawPdf() {}, armIdle() {} }, d);
  frame.dispatchEvent(pointer(w, 'pointerdown', { pointerId: 1 }));
  frame.dispatchEvent(pointer(w, 'pointercancel', { pointerId: 1 }));
  assert.equal(swaps, 0);
  frame.dispatchEvent(pointer(w, 'pointerdown', { pointerId: 2 }));
  frame.dispatchEvent(pointer(w, 'pointerup', { pointerId: 2 }));
  assert.equal(swaps, 1, 'a real tap still swaps');
  d.dispose();
}));

test('audit 6: a second finger cannot end the first one\'s seek; a cancelled seek goes back', async () => withPage(async (w, m) => {
  const root = w.document.createElement('div');
  root.innerHTML = m.playerTemplate();
  const seek = root.querySelector('.seek');
  seek.setPointerCapture = () => {};
  seek.getBoundingClientRect = () => ({ left: 0, width: 100 });
  const jumps = [];
  const d = new m.Disposer();
  const ui = { dragging: false };
  const video = { currentTime: 30, buffered: { length: 0 } };
  new m.SeekBar({ $: (s) => root.querySelector(s), video, clock: { position: () => 30 }, duration: () => 100, ui, isIdle: () => false, markers: { nearest: () => null }, skipAt: () => null, previewAt: () => '', seek: (t) => jumps.push(t), armIdle() {} }, d);
  seek.dispatchEvent(pointer(w, 'pointerdown', { pointerId: 1, clientX: 20 }));
  seek.dispatchEvent(pointer(w, 'pointerup', { pointerId: 2, clientX: 90 }));
  assert.deepEqual(jumps, []);
  assert.equal(ui.dragging, true, 'still the first finger\'s drag');
  seek.dispatchEvent(pointer(w, 'pointerup', { pointerId: 1, clientX: 20 }));
  assert.deepEqual(jumps, [20]);
  // Cancelled after moving: back to where playback was.
  seek.dispatchEvent(pointer(w, 'pointerdown', { pointerId: 3, clientX: 50 }));
  await new Promise((r) => setTimeout(r, 250));
  seek.dispatchEvent(pointer(w, 'pointermove', { pointerId: 3, clientX: 70 }));
  seek.dispatchEvent(pointer(w, 'pointercancel', { pointerId: 3 }));
  assert.equal(jumps.at(-1), 30);
  assert.equal(ui.dragging, false);
  d.dispose();
}));

test('audit 7: native HLS: a replaced or ended load leaves no handler, and a seek while loading wins', async () => withPage(async (w, m) => {
  const v = w.document.createElement('video');
  v.canPlayType = () => 'probably';
  const s = new m.Stream(v, () => {});
  const calls = [];
  s.load('https://example.test/a.m3u8', 10, () => calls.push('old'));
  s.load('https://example.test/b.m3u8', 20, () => calls.push('new'));
  v.dispatchEvent(new w.Event('loadedmetadata'));
  assert.deepEqual(calls, ['new']);
  s.load('https://example.test/c.m3u8', 30, () => calls.push('destroyed'));
  s.destroy();
  v.dispatchEvent(new w.Event('loadedmetadata'));
  assert.equal(calls.includes('destroyed'), false);
  s.load('https://example.test/d.m3u8', 10, () => {});
  s.intend(70, null);
  v.dispatchEvent(new w.Event('loadedmetadata'));
  assert.equal(v.currentTime, 70);
  s.destroy();
}));

test('audit 8: with Data Saver on, finding the screen view downloads nothing', async () => withPage(async (w, m) => {
  Object.defineProperty(w.navigator, 'connection', { value: { saveData: true } });
  let frames = 0;
  m.HlsVideoReader.supported = () => true;
  m.HlsVideoReader.prototype.open = async function () { return this; };
  m.HlsVideoReader.prototype.sampleSegments = () => [0, 1];
  m.HlsVideoReader.prototype.keyframe = async () => { frames++; throw new Error('no network in tests'); };
  m.idbCache.get = async () => undefined;
  const d = new m.Disposer();
  const a = new m.SlideAnalyzer({ lesson: { mediaId: 'x', sources: [{ index: 0, av: 'a' }, { index: 1, av: 'b' }], thumbnails: [] }, video: {}, disposer: d });
  await a.run(a.ac.signal, a.gate);
  assert.equal(frames, 0);
  assert.equal(a.state, 'unavailable');
  assert.equal(a.reason, 'saveData');
  d.dispose();
}));

test('audit 9: a render still running for a removed PDF is not kept for the new one', async () => withPage(async (w, m) => {
  const d = new m.Disposer();
  const deck = new m.SlideDeckController({ lesson: { mediaId: 'test' }, video: {}, disposer: d });
  let release;
  const oldPage = new Promise((r) => { release = r; });
  deck.pages = [{ key: 'old:1', num: 1, doc: { getPage: () => oldPage } }];
  const pending = deck.render(0, 400);
  deck.closeDocs(true);
  let newReads = 0;
  deck.pages = [{ key: 'new:1', num: 1, doc: { getPage: async () => { newReads++; return { getViewport: ({ scale }) => ({ width: 400 * scale, height: 300 * scale }), render: () => ({ promise: Promise.resolve() }) }; } } }];
  release({ getViewport: ({ scale }) => ({ width: 400 * scale, height: 300 * scale }), render: () => ({ promise: Promise.resolve() }) });
  const oldCanvas = await pending;
  const got = await deck.render(0, 400);
  assert.notEqual(got, oldCanvas);
  assert.equal(newReads, 1);
  d.dispose();
}));

test('audit 10: closing while a slide file is being read makes no PDF Worker', async () => withPage(async (w, m) => {
  let created = 0;
  w.Worker = class { constructor() { created++; } terminate() {} };
  m.setPdfLib({ PDFWorker: class { destroy() {} }, getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }), destroy: async () => {} }) });
  let release;
  const disk = new Promise((r) => { release = r; });
  m.idbCache.get = () => disk;
  const d = new m.Disposer();
  const deck = new m.SlideDeckController({ lesson: { mediaId: 'test' }, video: {}, disposer: d });
  deck.files = [{ hash: 'abc', name: 'test.pdf' }];
  const pending = deck.reload();
  await tick();
  d.dispose();
  release({ arrayBuffer: async () => new ArrayBuffer(8) });
  await pending;
  assert.equal(created, 0);
  assert.equal(deck.pdfWorker, null);
}));

test('audit 11: in the floating window, captions follow that window\'s visibility, not the page behind', async () => withPage(async (w, m) => {
  const other = new Window();
  try {
    const elem = w.document.createElement('div');
    elem.append(w.document.createElement('span'));
    other.document.body.append(elem);   // the player moved into the floating window
    const cc = new m.CaptionsView(elem, { paused: true });
    cc.setCues([{ start: 0, end: 5, text: 'first' }, { start: 5, end: 10, text: 'second' }]);
    cc.setOn(true);
    cc.update(1);
    Object.defineProperty(w.document, 'hidden', { configurable: true, value: true });   // the page behind: another tab
    cc.update(6);
    assert.equal(elem.firstChild.textContent, 'second');
    cc.dispose();
  } finally { await other.happyDOM.abort(); other.close(); }
}));

test('audit 6b: other drags (zoom pan, loop handle) ignore a second finger and undo when cancelled', async () => withPage(async (w, m) => {
  // Loop handle: cancelled drag leaves the loop as it was.
  const root = w.document.createElement('div');
  root.innerHTML = '<div class="m"></div><div class="seek"></div>';
  const rail = root.querySelector('.seek');
  rail.getBoundingClientRect = () => ({ left: 0, width: 100 });
  const d = new m.Disposer();
  w.document.body.append(root);
  const loop = new m.ABLoop({ pops: new m.Popovers(root.querySelector('.m'), d), rail, video: { currentTime: 0 }, duration: () => 100, seek() {}, toast() {} }, d);
  loop.a = 10;
  loop.b = 40;
  loop.render();
  const hd = loop.band.querySelector('.la');
  hd.setPointerCapture = () => {};
  hd.dispatchEvent(pointer(w, 'pointerdown', { pointerId: 1, clientX: 10 }));
  hd.dispatchEvent(pointer(w, 'pointermove', { pointerId: 1, clientX: 25 }));
  hd.dispatchEvent(pointer(w, 'pointermove', { pointerId: 2, clientX: 2 }));
  assert.equal(loop.a, 25, 'a second finger does not move it');
  hd.dispatchEvent(pointer(w, 'pointercancel', { pointerId: 1 }));
  assert.equal(loop.a, 10, 'cancelled: back to where it was');
  d.dispose();
}));

test('transcript search marks exactly the matched characters, in every line of a cue', async () => withPage(async (w, m) => {
  const pane = w.document.createElement('div');
  pane.innerHTML = '<input class="tsearch"><span class="tcount"></span><button class="tback"></button><button class="tprev"></button><button class="tnext"></button><div class="tlist"></div>';
  const cues = [
    { start: 1, end: 5, text: 'so for example, this is the thing we need but kind of let it go and like, essentially, move on' },
    { start: 6, end: 9, text: 'İstanbul EXAM tips: C++ and exams' },   // a dotted capital I is 2 characters lower-cased
    { start: 10, end: 12, text: 'nothing here' },
  ];
  const d = new m.Disposer();
  const t = new m.TranscriptPanel({ duration: () => 100, video: { currentTime: 0 }, seek() {} }, pane, w.document.createElement('div'), d);
  t.setCues(cues);
  t.build();
  const marks = (i) => [...t.rows[i].querySelectorAll('mark')].map((x) => x.textContent);
  t.search.value = 'exam';
  t.runSearch();
  assert.deepEqual([...t.hits], [0, 1]);
  assert.deepEqual(marks(0), ['exam'], 'inside "example", not a later line');
  assert.equal(t.rows[0].querySelector('.tx').textContent, cues[0].text, 'the text itself is unchanged');
  assert.deepEqual(marks(1), ['EXAM', 'exam'], 'positions stay right after a character whose lower case is longer');
  t.search.value = 'c++';
  t.runSearch();
  assert.deepEqual(marks(1), ['C++'], 'typed characters are not a pattern');
  t.search.value = '';
  t.runSearch();
  assert.equal(pane.querySelectorAll('mark').length, 0);
  assert.equal(t.rows[1].querySelector('.tx').textContent, cues[1].text);
  d.dispose();
}));

// ---- shared UI components (src/32-ui-kit.js, 48-speed.js, 45-menus.js) ----

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });

function popoverStage(w, m, width, height) {
  const box = w.document.createElement('div');
  box.getBoundingClientRect = () => rect(0, 0, width, height);
  const btn = w.document.createElement('button');
  w.document.body.append(box, btn);
  const d = new m.Disposer();
  const pops = new m.Popovers(box, d);
  const pop = pops.create('t', 'dialog', 'Test');
  pop.el.append(w.document.createElement('button'));
  Object.defineProperty(pop.el, 'offsetWidth', { get: () => 200 });
  Object.defineProperty(pop.el, 'offsetHeight', { get: () => 100 });
  return { box, btn, d, pops, pop };
}

test('popover: anchored above its button, moved inward at the edge, below when there is no room above', async () => withPage(async (w, m) => {
  const { btn, d, pops, pop } = popoverStage(w, m, 1000, 600);
  btn.getBoundingClientRect = () => rect(970, 550, 40, 40);   // bottom-right corner
  pops.open(pop, btn, 'above');
  assert.equal(pop.el.style.left, (1000 - 200 - 8) + 'px', 'kept inside the right edge');
  assert.equal(pop.el.style.top, (550 - 8 - 100) + 'px', 'just above the button');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  pops.close(false);
  btn.getBoundingClientRect = () => rect(10, 20, 40, 40);   // top-left, a bottom-bar placement
  pops.open(pop, btn, 'above');
  assert.equal(pop.el.style.top, (60 + 8) + 'px', 'flipped below: no room above');
  assert.equal(pop.el.style.left, '8px', 'kept inside the left edge');
  d.dispose();
}));

test('popover: a bottom sheet when narrow; Esc and an outside press close it, Esc gives the focus back', async () => withPage(async (w, m) => {
  const { btn, d, pops, pop } = popoverStage(w, m, 390, 800);
  btn.getBoundingClientRect = () => rect(300, 700, 44, 44);
  pops.open(pop, btn, 'above');
  assert.ok(pop.el.classList.contains('sheet'));
  pop.el.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(pops.isOpen(), false);
  assert.equal(pop.el.hidden, true);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(w.document.activeElement, btn, 'focus back on the button');
  pops.open(pop, btn, 'above');
  w.document.body.dispatchEvent(pointer(w, 'pointerdown', { pointerId: 1 }));
  assert.equal(pops.isOpen(), false, 'outside press closes');
  pops.open(pop, btn, 'above');
  pop.el.firstChild.dispatchEvent(pointer(w, 'pointerdown', { pointerId: 1 }));
  assert.equal(pops.isOpen(), true, 'a press inside keeps it open');
  d.dispose();
  assert.equal(pops.isOpen(), false, 'disposed: closed');
}));

test('settings menu: pages open with a back button, values show, toggles and radios redraw', async () => withPage(async (w, m) => {
  const { btn, d, pops } = popoverStage(w, m, 1000, 600);
  btn.getBoundingClientRect = () => rect(900, 10, 40, 40);
  let q = 'auto';
  let on = false;
  let ran = 0;
  const menu = new m.SettingsMenu(pops, 'sm', 'Settings', () => [
    { kind: 'action', label: 'Go', run: () => ran++ },
    { kind: 'action', label: 'Not now', reason: () => 'No captions', run: () => ran++ },
    { kind: 'page', label: 'Quality', value: () => q, items: () => [
      { kind: 'radio', label: 'auto', checked: () => q === 'auto', select: () => { q = 'auto'; } },
      { kind: 'radio', label: '720p', checked: () => q === '720p', select: () => { q = '720p'; } },
    ] },
    { kind: 'toggle', label: 'Loud', on: () => on, set: (v) => { on = v; } },
    { kind: 'action', label: 'Gone', hidden: () => true, run() {} },
  ], d);
  const el = menu.pop.el;
  const item = (label) => [...el.querySelectorAll('.mi')].find((x) => x.querySelector('.lbl').firstChild.textContent === label);
  menu.open(btn, 'below');
  assert.equal(el.querySelectorAll('.mi').length, 4, 'hidden items left out');
  assert.equal(item('Quality').querySelector('.val').textContent, 'auto');
  assert.equal(item('Not now').getAttribute('aria-disabled'), 'true');
  item('Not now').click();
  assert.equal(ran, 0, 'an unavailable action does nothing');
  item('Loud').click();
  assert.equal(on, true);
  assert.equal(item('Loud').getAttribute('aria-checked'), 'true', 'redrawn');
  item('Quality').click();
  assert.ok(el.querySelector('.mback'), 'second-level page has a back button');
  assert.equal(el.querySelector('.mhead span').textContent, 'Quality');
  item('720p').click();
  assert.equal(item('720p').getAttribute('aria-checked'), 'true');
  el.querySelector('.mback').click();
  assert.equal(item('Quality').querySelector('.val').textContent, '720p', 'back on the first page, with the new value');
  item('Go').click();
  assert.equal(ran, 1);
  assert.equal(menu.isOpen, false, 'an action closes the menu');
  menu.open(btn, 'below');
  assert.ok(!el.querySelector('.mback'), 'opens on the first page again');
  d.dispose();
}));

test('speed: stops snap, [ and ] step between stops, values stay in range', async () => withPage(async (w, m) => {
  assert.equal(m.snapSpeed(1.47), 1.5, 'near a stop: the stop');
  assert.equal(+m.snapSpeed(1.38).toFixed(2), 1.4, 'between stops: 0.05 steps');
  assert.equal(m.snapSpeed(9), 3);
  assert.equal(m.snapSpeed(0.1), 0.5);
  assert.equal(m.nextSpeed(1, 1), 1.25);
  assert.equal(m.nextSpeed(1.3, -1), 1.25, 'off a stop: the stop below');
  assert.equal(m.nextSpeed(1.3, 1), 1.5);
  assert.equal(m.nextSpeed(3, 1), 3, 'no stop above the last');
  assert.equal(m.nextSpeed(m.SPEED_STOPS[0], -1), m.SPEED_STOPS[0]);
}));

test('control bar: buttons move into the menu in BAR_OVERFLOW order, then the time moves up', async () => withPage(async (w, m) => {
  const root = w.document.createElement('div');
  root.innerHTML = '<div class="bottom"><div class="row"><button class="a"></button>'
    + m.BAR_OVERFLOW.slice().reverse().map((k) => '<button data-bar="' + k + '"></button>').join('') + '</div></div>';
  const row = root.querySelector('.row');
  const bottom = root.querySelector('.bottom');
  // Each button is 40 px wide; a compact bar (time above the seek bar) saves 100 px.
  Object.defineProperty(row, 'scrollWidth', { get: () => 40 * row.querySelectorAll('button:not(.out)').length + 200 - (bottom.classList.contains('compact') ? 100 : 0) });
  let width = 0;
  Object.defineProperty(row, 'clientWidth', { get: () => width });
  const bar = { x: { $: (s) => root.querySelector(s), root }, refresh() {} };
  const fit = (wd) => { width = wd; m.MenuBar.prototype.fitBar.call(bar); return bar.out.join(','); };
  assert.equal(fit(400), '');
  assert.equal(fit(320), m.BAR_OVERFLOW.slice(0, 1).join(','), 'first in the list goes first');
  assert.equal(fit(280), m.BAR_OVERFLOW.slice(0, 2).join(','));
  assert.equal(fit(240), m.BAR_OVERFLOW.join(','));
  assert.equal(bottom.classList.contains('compact'), false);
  assert.equal(fit(200), m.BAR_OVERFLOW.join(','));
  assert.equal(bottom.classList.contains('compact'), true, 'still too wide: time moves up');
  assert.equal(fit(400), '', 'all come back when there is room');
  assert.equal(bottom.classList.contains('compact'), false);
}));

test('unavailable control: dimmed with a reason, which is also its tooltip; usable again with its own tip', async () => withPage(async (w, m) => {
  const b = w.document.createElement('button');
  m.setUnavailable(b, 'This recording has no captions', 'Captions (C)');
  assert.equal(b.getAttribute('aria-disabled'), 'true');
  assert.equal(b.dataset.tip, 'This recording has no captions');
  m.setUnavailable(b, '', 'Captions (C)');
  assert.equal(b.getAttribute('aria-disabled'), 'false');
  assert.equal(b.dataset.tip, 'Captions (C)');
  assert.equal(b.dataset.reason, '');
}));

function volumeStage(w, m, volume, muted) {
  const root = w.document.createElement('div');
  root.innerHTML = '<div class="vol"><button class="mute"></button><input class="volume" type="range" min="0" max="1" step="0.01"></div><div class="volosd"></div>'
    + '<div class="keyhelp" hidden><button class="khclose"></button><div class="khlist"></div></div>';
  w.document.body.append(root);
  const video = new w.EventTarget();
  Object.assign(video, { volume, muted });
  const d = new m.Disposer();
  const $ = (s) => root.querySelector(s);
  const vol = new m.VolumeControl({ $, video }, d);
  return { root, video, d, $, vol };
}

test('volume: the speaker mutes and unmutes; its icon and name follow the level', async () => withPage(async (w, m) => {
  const { video, d, $, vol } = volumeStage(w, m, 0.8, false);
  const icon = () => $('.mute svg').innerHTML;
  const high = icon();
  assert.equal($('.mute').getAttribute('aria-label'), 'Mute');
  $('.mute').click();
  assert.equal(video.muted, true);
  vol.render();
  assert.notEqual(icon(), high);
  assert.equal($('.mute').getAttribute('aria-label'), 'Unmute');
  const mutedIcon = icon();
  $('.mute').click();
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0.8, 'comes back at the old level');
  video.volume = 0.3;
  vol.render();
  assert.ok(icon() !== high && icon() !== mutedIcon, 'a low level has its own icon');
  video.volume = 0;
  vol.render();
  assert.equal(icon(), mutedIcon, 'zero looks muted');
  $('.mute').click();
  assert.equal(video.volume, 0.5, 'unmuting from zero gives half');
  d.dispose();
}));

test('volume: wheel steps add up, up is louder; key and wheel changes show the level for a moment', async () => withPage(async (w, m) => {
  const { video, d, $ } = volumeStage(w, m, 0.5, false);
  const wheel = (deltaY, deltaMode = 0) => {
    const e = new w.WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true });
    $('.mute').dispatchEvent(e);
    return e;
  };
  const e = wheel(-m.VOLUME_WHEEL_PX / 2);
  assert.equal(e.defaultPrevented, true, 'the page does not scroll');
  assert.equal(video.volume, 0.5, 'half a notch: nothing yet');
  wheel(-m.VOLUME_WHEEL_PX / 2);
  assert.equal(video.volume, 0.5 + m.VOLUME_STEP, 'a full notch: one step up');
  assert.ok($('.volosd').classList.contains('on'));
  assert.equal($('.volosd').textContent, 'Volume 55%');
  wheel(3, 1);   // Firefox: one notch is three lines
  assert.equal(video.volume, 0.5, 'line-based wheels count too');
  wheel(120);   // a large notch (Windows) is still one step
  assert.equal(video.volume, 0.45);
  wheel(-120);
  await new Promise((r) => setTimeout(r, m.VOLUME_OSD_MS + 50));
  assert.equal($('.volosd').classList.contains('on'), false, 'fades after about a second');
  for (let i = 0; i < 30; i++) wheel(m.VOLUME_WHEEL_PX);
  assert.equal(video.volume, 0, 'never below zero');
  assert.equal($('.volosd').textContent, 'Muted');
  d.dispose();
}));

test('volume: arrow keys change it with the level shown; on the slider left and right do not seek', async () => withPage(async (w, m) => {
  const { root, video, d, $, vol } = volumeStage(w, m, 0.5, true);
  const seeks = [];
  new m.KeyboardShortcuts({ $, isDestroyed: () => false, wake() {}, actions: { volumeBy: (dv) => vol.by(dv, true), seekBy: (s) => seeks.push(s) } }, d);
  const key = (target, k) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true }));
  key(w.document.body, 'ArrowUp');
  assert.equal(video.muted, false, 'louder unmutes');
  assert.equal(video.volume, 0.5 + m.VOLUME_STEP);
  assert.ok($('.volosd').classList.contains('on'));
  key(root.querySelector('.volume'), 'ArrowLeft');
  assert.equal(video.volume, 0.5, 'on the slider: quieter');
  assert.deepEqual(seeks, []);
  key(w.document.body, 'ArrowLeft');
  assert.equal(seeks.length, 1, 'elsewhere left still seeks');
  d.dispose();
}));

test('volume slider: shown only for a mouse or the keyboard, never on touch screens', async () => withPage(async (w, m) => {
  const css = m.PLAYER_CSS;
  const at = css.indexOf('.vol:hover input');
  assert.ok(at > 0);
  assert.ok(css.lastIndexOf('@media (hover: hover)', at) > css.lastIndexOf('}\n}', at), 'the open state is inside (hover: hover)');
  assert.match(css, /\.vol input \{ width: 0;[^}]*visibility: hidden/);
}));
