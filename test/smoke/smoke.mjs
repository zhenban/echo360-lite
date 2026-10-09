// Smoke test in a real browser (M8.9 F): opens recordings in a Chrome (or Edge) that is
// signed in to Echo360 and has remote debugging on, with this build injected the way the
// userscript manager loads it, and goes through the regression checklist on each:
// start-up, playback, seeking, layouts and view switching, captions, the analyses, the
// resume position, hand-over to the original player, and the console. Not run in CI
// (it needs a signed-in browser).
//
//   google-chrome --remote-debugging-port=9333 --user-data-dir=<profile>    (sign in once)
//   npm run build
//   node test/smoke/smoke.mjs --port 9333 --lectures test/smoke/lectures.local.json [--out report.md] [--label "Chrome, used profile"]
//   Firefox (WebDriver BiDi): firefox --remote-debugging-port 9336 --profile <dir>, then --port 9336 --protocol bidi
//
// lectures.local.json (not committed: lesson ids show which courses an account takes):
//   [{ "name": "ELEC2134 2026-09-15", "lesson": "G_..._2026-09-15T16:05:00.000_2026-09-15T19:00:00.000", "expect": { "blackEnd": true } }, ...]
// Nothing is written to Echo360 (dry run on for public writes; the test writes nothing
// private either). Viewing is reported as usual, like watching a few seconds.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const port = +arg('port', 9333);
const lectures = JSON.parse(readFileSync(arg('lectures', join(root, 'test', 'smoke', 'lectures.local.json')), 'utf8'));
const label = arg('label', 'Chrome');
// A first visit analyses the whole recording (a 3-hour one can take 15 minutes or more).
const analysisWaitSec = +arg('analysis-wait', 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- browser drivers: navigate, evaluate, key, click, console ----
// Chrome and Edge speak CDP; Firefox speaks WebDriver BiDi. Both are reached on a local
// port; the checklist below only uses this interface.

async function socket(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to ' + url)); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(typeof msg.error === 'string' ? msg.error + ': ' + msg.message : msg.error.message)); else res(msg.result);
    } else if (msg.method) for (const fn of listeners) fn(msg);
  };
  // A browser that stops answering (the computer slept, the tab hung) fails the check
  // instead of stopping the whole run.
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); rej(new Error(method + ': no answer in 120 s')); }, 120000);
    pending.set(i, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

async function cdpDriver(log) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  let tab = tabs.find((t) => t.type === 'page' && /echo360/.test(t.url)) || tabs.find((t) => t.type === 'page');
  if (!tab) tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const c = await socket(tab.webSocketDebuggerUrl);
  c.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') log.push({ level: m.params.type, text: m.params.args.map((x) => x.value ?? x.description ?? '').join(' ') });
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; log.push({ level: 'exception', text: (d.exception && d.exception.description) || d.text }); }
  });
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  const product = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
  return {
    product,
    addInitScript: (source) => c.send('Page.addScriptToEvaluateOnNewDocument', { source }),
    navigate: (url) => c.send('Page.navigate', { url }),
    evaluate: async (expr) => {
      const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
      return r.result.value;
    },
    key: async (k) => {
      const code = k === ' ' ? 'Space' : 'Key' + k.toUpperCase();
      const keyCode = k === ' ' ? 32 : k.toUpperCase().charCodeAt(0);
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, text: k });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
    },
    click: async (x, y) => {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    },
    close: () => c.close(),
  };
}

async function bidiDriver(log) {
  const c = await socket(`ws://127.0.0.1:${port}/session`);
  const ses = await c.send('session.new', { capabilities: {} });
  const tree = await c.send('browsingContext.getTree', {});
  const context = tree.contexts[0].context;
  await c.send('session.subscribe', { events: ['log.entryAdded'] });
  c.on((m) => {
    if (m.method === 'log.entryAdded') log.push({ level: m.params.type === 'javascript' ? 'exception' : m.params.level === 'warn' ? 'warning' : m.params.level, text: m.params.text || '' });
  });
  // Values come back as JSON text (BiDi's remote values are verbose to read).
  const evaluate = async (expr) => {
    const r = await c.send('script.evaluate', { expression: `(async () => JSON.stringify(await (${expr})))()`, target: { context }, awaitPromise: true, resultOwnership: 'none' });
    if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
    return r.result.value === undefined ? undefined : JSON.parse(r.result.value);
  };
  return {
    product: ses.capabilities.browserName + ' ' + ses.capabilities.browserVersion,
    addInitScript: (source) => c.send('script.addPreloadScript', { functionDeclaration: '() => { (0, eval)(' + JSON.stringify(source) + '); }' }),
    navigate: (url) => c.send('browsingContext.navigate', { context, url, wait: 'interactive' }),
    evaluate,
    key: (k) => c.send('input.performActions', { context, actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: k }, { type: 'keyUp', value: k }] }] }),
    click: (x, y) => c.send('input.performActions', { context, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] }),
    close: () => c.send('session.end', {}).catch(() => {}).then(() => c.close()),
  };
}

const log = [];
const driver = await (arg('protocol', 'cdp') === 'bidi' ? bidiDriver(log) : cdpDriver(log));

const hlsUrl = /@require\s+(\S+hls[^\s]*)/.exec(readFileSync(join(root, 'src', 'meta.txt'), 'utf8'))[1];
const hls = await (await fetch(hlsUrl)).text();
const lite = readFileSync(join(root, 'dist', 'echo360-lite.user.js'), 'utf8');
const version = /@version\s+(\S+)/.exec(lite)[1];
// --no-inject: test the script as installed in the browser's userscript manager (it must
// be this build, and run in the page, as with Violentmonkey's @inject-into page).
const inject = !process.argv.includes('--no-inject');
await driver.addInitScript('if (/^https:\\/\\/echo360\\.net\\.au\\/(lesson\\/|section\\/[^/]+\\/home)/.test(location.href)) {\n'
  + 'try { localStorage.setItem("echo360lite:debug", "true"); localStorage.setItem("echo360lite:dryRun", "\\"public\\""); } catch (e) {}\n'
  + (inject ? hls + '\n;\n' + lite : '') + '\n}\n//# sourceURL=echo360-lite.user.js');

const evalIn = (expr) => driver.evaluate(expr);
const key = (k) => driver.key(k);
const clickAt = (x, y) => driver.click(x, y);
const P = 'window.__echo360LitePlayer';
const until = async (expr, sec) => {
  for (let i = 0; i < sec * 2; i++) { try { const v = await evalIn(expr); if (v) return v; } catch (e) { /* not yet */ } await sleep(500); }
  return null;
};
const open = async (lesson) => {
  log.length = 0;
  await driver.navigate('https://echo360.net.au/lesson/' + lesson + '/classroom');
  await sleep(1500);
  const ok = await until(`!!(${P} && ${P}.video)`, 40);
  if (ok || inject) return ok;
  // An installed script may have started before the debug switch was set: once more.
  await driver.navigate('https://echo360.net.au/lesson/' + lesson + '/classroom');
  await sleep(1500);
  return until(`!!(${P} && ${P}.video)`, 40);
};
const state = () => evalIn(`(() => { const p = ${P}; const v = p.video; return { t: v.currentTime, paused: v.paused, ready: v.readyState, layout: p.layout, dual: p.dual, primary: p.primaryPos, fready: p.fvideo.readyState }; })()`);

// ---- the checklist ----

async function smoke(lec) {
  const r = { name: lec.name, checks: [], notes: [] };
  const check = (name, ok, detail) => { r.checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) }); };
  const t0 = Date.now();
  if (!(await open(lec.lesson))) { check('starts', false, 'no player within 40 s'); return r; }
  const info = await evalIn(`(() => { const p = ${P}; return { title: p.lesson.title, views: p.sources.length, version: VERSION_PLACEHOLDER }; })()`.replace('VERSION_PLACEHOLDER', JSON.stringify(version)));
  r.title = info.title;
  r.views = info.views;
  check('starts', true, ((Date.now() - t0) / 1000).toFixed(1) + ' s, ' + info.views + ' view(s)');

  // Playback, with a real key press (playback needs a user action).
  // Focus the page by clicking the title (a click on a picture would play or pause it).
  const stage = await evalIn(`(() => { const b = ${P}.$('.title').getBoundingClientRect(); return { x: b.left + Math.min(20, b.width / 2), y: b.top + b.height / 2 }; })()`);
  await clickAt(stage.x, stage.y);
  await sleep(400);
  const before = await state();
  if (!before.paused) await key(' ');
  await evalIn(`${P}.seek(${P}.duration() * 0.3)`);
  await sleep(1500);
  const start = (await state()).t;
  await key(' ');
  const moved = await until(`${P}.video.currentTime > ${start + 2}`, 20);
  const s1 = await state();
  check('plays', moved, 'from ' + start.toFixed(1) + ' to ' + s1.t.toFixed(1));
  await key(' ');
  await sleep(500);

  // Seeking.
  const target = await evalIn(`${P}.duration() * 0.6`);
  await evalIn(`${P}.seek(${target})`);
  const seeked = await until(`Math.abs(${P}.video.currentTime - ${target}) < 1.5 && ${P}.video.readyState >= 2`, 15);
  check('seeks', seeked, 'to ' + target.toFixed(1));

  // Layouts and switching views (the position must stay, also when switching quickly).
  if (info.views > 1) {
    const pos = (await state()).t;
    for (const l of ['pip', 'single', 'side']) {
      await evalIn(`${P}.setLayout(${JSON.stringify(l)})`);
      const ok = await until(`${P}.layout === ${JSON.stringify(l)} && ${P}.video.readyState >= 2 && Math.abs(${P}.video.currentTime - ${pos}) < 2`, 15);
      check('layout ' + l, ok, (await state()).t.toFixed(1));
    }
    await evalIn(`${P}.setLayout('single')`);
    await until(`${P}.video.readyState >= 2`, 10);
    await key('s');
    await key('s');
    const kept = await until(`${P}.video.readyState >= 2 && Math.abs(${P}.video.currentTime - ${pos}) < 2`, 15);
    check('quick view switch keeps position', kept, (await state()).t.toFixed(1) + ' (was ' + pos.toFixed(1) + ')');
    await evalIn(`${P}.setLayout('side')`);
    await until(`${P}.video.readyState >= 2 && ${P}.fvideo.readyState >= 2`, 15);
  } else check('single view: no layout switching offered', await evalIn(`${P}.root.querySelector('.layout').style.display === 'none'`));

  // Captions.
  const cues = await until(`${P}.cues ? ${P}.cues.length : 0`, 15);
  if (cues) {
    const was = await evalIn(`${P}.cc.on`);
    await key('c');
    const toggled = await until(`${P}.cc.on === ${!was}`, 3);
    await key('c');
    check('captions', toggled, cues + ' cues');
  } else r.notes.push('no transcript');

  // The analyses finish (or say why not).
  const done = await until(`(() => { const p = ${P}; const sl = p.slides; const si = p.silence && p.silence.analyzer;
    return sl && (sl.state === 'done' || sl.state === 'unavailable') && si && si.source !== 'pending' && (si.source !== 'audio' || si.progress >= 1); })()`, analysisWaitSec);
  const an = await evalIn(`(() => { const p = ${P}; const sl = p.slides; const si = p.silence && p.silence.analyzer;
    return { slides: sl.state, chapters: sl.chapters.length, screen: sl.screenIndex, sure: sl.screenSure, uniform: sl.uniform.length,
      silence: si.source, silences: si.silences.length, end: p.silence.contentEnd, dur: p.duration(),
      deck: p.deck ? p.deck.state : null }; })()`);
  check('analyses finish', done, `chapters ${an.slides} (${an.chapters}, screen ${an.screen}${an.sure === false ? ' guessed' : ''}), silence ${an.silence} (${an.silences})`);
  if (lec.expect && lec.expect.blackEnd) check('empty ending found', an.end && an.end < an.dur - 30, an.end ? 'content ends ' + Math.round(an.end) + ' of ' + Math.round(an.dur) : 'none');
  if (an.slides === 'unavailable') r.notes.push('slide chapters unavailable');

  // Resume: the position is kept across a reload. Played a little first, as a viewer
  // would: Echo360's own record (the last position played) wins over this device's, as
  // in the original player.
  await key(' ');
  await until(`!${P}.video.paused && ${P}.video.currentTime > ${target + 2}`, 15);
  await key(' ');
  await sleep(1500);
  const here = (await state()).t;
  if (!(await open(lec.lesson))) { check('resumes', false, 'no player after reload'); return r; }
  const back = await until(`${P}.video.readyState >= 1 && ${P}.clock.position()`, 20);
  check('resumes', back && Math.abs(back - here) < 15, (back || 0).toFixed(1) + ' (left at ' + here.toFixed(1) + ')');

  // Hand-over to the original player at the same place.
  const at = (await state()).t;
  const orig = await evalIn(`(() => { const b = ${P}.$('.orig').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await clickAt(orig.x, orig.y);
  const handed = await until(`!document.querySelector('#echo360-lite') && [...document.querySelectorAll('video')].some((v) => Math.abs(v.currentTime - ${at}) < 5)`, 25);
  check('hands over to the original player', handed, 'at ' + at.toFixed(1));

  // Console: nothing from this script above info, no exceptions from it.
  const ours = log.filter((x) => /echo360 ?lite/i.test(x.text) && (x.level === 'error' || x.level === 'warning' || x.level === 'exception'));
  check('console clean', !ours.length, ours.map((x) => x.text.slice(0, 120)).join(' | '));
  r.seconds = Math.round((Date.now() - t0) / 1000);
  return r;
}

const results = [];
for (const lec of lectures) {
  process.stderr.write('smoke: ' + lec.name + '...\n');
  try { results.push(await smoke(lec)); } catch (e) { results.push({ name: lec.name, checks: [{ name: 'runs', ok: false, detail: e.message }], notes: [] }); }
}
await driver.close();

const lines = [`Smoke test, ${label} (${driver.product}), Echo360 Lite ${version}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, ''];
for (const r of results) {
  const failed = r.checks.filter((x) => !x.ok);
  lines.push(`${failed.length ? 'FAIL' : 'ok  '} ${r.name}${r.views ? ` (${r.views} view${r.views > 1 ? 's' : ''})` : ''}${r.seconds ? `, ${r.seconds} s` : ''}${r.notes.length ? ' [' + r.notes.join('; ') + ']' : ''}`);
  for (const ch of r.checks) lines.push(`     ${ch.ok ? '✓' : '✗'} ${ch.name}${ch.detail ? ': ' + ch.detail : ''}`);
}
const text = lines.join('\n');
console.log(text);
if (arg('out')) writeFileSync(arg('out'), text + '\n');
process.exit(results.every((r) => r.checks.every((x) => x.ok)) ? 0 : 1);
