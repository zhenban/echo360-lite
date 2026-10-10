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
const names = 'Disposer,Stream,TagStore,idbCache,SlideReader,DiscussionPane,NotesPane,LayoutControls,CaptionsView,FrameTask,SlideAnalyzer,HlsVideoReader,SeekBar,SlideDeckController,ABLoop,Zoomer,playerTemplate,PLAYER_CSS,'
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
  assert.equal(shown('.orig'), 'auto', 'clickable while shown');
  assert.equal(shown('.loopband .lh'), 'auto', 'loop handles draggable while shown');
  assert.equal(hidden('.orig'), 'none', 'the Original player button while hidden');
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
  const loop = new m.ABLoop({ mount: root.querySelector('.m'), rail, video: { currentTime: 0 }, duration: () => 100, seek() {}, toast() {} }, d);
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
