// ===================================================================================
// Utilities
// ===================================================================================

const TAG = '[Echo360 Lite]';
const NS = 'echo360lite:';
const HlsLib = typeof Hls !== 'undefined' ? Hls : window.Hls;

// After a backup has been restored, this page must not write its older data back over
// it (it reloads right away; until then writes are dropped).
const storageLock = { frozen: false };

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(NS + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    if (storageLock.frozen) return;
    try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  },
};

function fmtTime(sec, withHours) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0 || withHours) return h + ':' + String(m).padStart(2, '0') + ':' + ss;
  return m + ':' + ss;
}

function parseIsoDuration(s) {
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s || '');
  if (!m) return NaN;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Errors in our own code come in two kinds.
//  - Core playback (the streams, the clock video's events, the layout): the page is handed
//    back to the original player (`unexpected.handler`, installed by the bootstrap, runs at
//    most once). Code reports these with reportUnexpected / guardCore.
//  - Everything else (menus, panels, tags, zoom, analyses, ...): logged, the user gets one
//    unobtrusive notice per feature, and the feature's own resources may be released
//    (Disposer.feature). Playback goes on. This is what guard() does by default.
// guard() also catches rejections of the Promise an async callback returns.
const unexpected = { handler: null };
const featureErrors = { notify: null, seen: new Set() };

function reportUnexpected(err) {
  console.error(TAG, 'unexpected error', err);
  const h = unexpected.handler;
  unexpected.handler = null;
  if (h) { try { h(err); } catch (e) { /* ignore */ } }
}

function reportFeatureError(name, err) {
  const what = name || 'player';
  console.error(TAG, 'error in ' + what + ':', err);
  logEvent('error', what + ': ' + ((err && err.message) || err));
  if (featureErrors.seen.has(what)) return;
  featureErrors.seen.add(what);
  if (featureErrors.notify) { try { featureErrors.notify(what, err); } catch (e) { /* ignore */ } }
}

// fn wrapped so that an exception (or the rejection of the Promise it returns) goes to
// onError, by default a non-fatal feature error.
function guard(fn, onError) {
  const report = onError || ((e) => reportFeatureError(null, e));
  return function guarded() {
    try {
      const r = fn.apply(this, arguments);
      if (r && typeof r.then === 'function' && typeof r.catch === 'function') r.catch(report);
      return r;
    } catch (e) {
      report(e);
      return undefined;
    }
  };
}

// Core playback: an error hands the page back to the original player.
function guardCore(fn) {
  return guard(fn, reportUnexpected);
}

// Runs fn (a feature's setup) and turns the feature off instead of failing the player.
function featureGuard(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((e) => reportFeatureError(name, e));
    return r;
  } catch (e) {
    reportFeatureError(name, e);
    return undefined;
  }
}

// One log format: "[Echo360 Lite] ..." in the console. Warnings and errors always (and kept
// for diagnostics); information only with localStorage["echo360lite:debug"] = true.
const log = {
  info(...a) { if (store.get('debug', false)) console.info(TAG, ...a); },
  warn(...a) { console.warn(TAG, ...a); logEvent('warn', a.map(logText).join(' ')); },
  error(...a) { console.error(TAG, ...a); logEvent('error', a.map(logText).join(' ')); },
};
function logText(x) { return x && x.message ? x.message : typeof x === 'string' ? x : String(x); }

// Recent warnings and errors (no content, no addresses), for "copy diagnostics".
const LOG_KEEP = 40;
const eventLog = [];
function logEvent(level, text) {
  eventLog.push({ t: new Date().toISOString().slice(11, 19), level, text: String(text).slice(0, 300) });
  if (eventLog.length > LOG_KEEP) eventLog.shift();
}

// Owns every timer, listener, observer and child resource of a component so that one
// dispose() call releases all of them (used when switching recordings and when handing
// over to the original player). Listener and timer callbacks are wrapped with guard().
class Disposer {
  // opts: { onError } (where errors of its listeners and timers go; inherited by children)
  constructor(opts) {
    this.fns = [];
    this.disposed = false;
    this.onError = (opts && opts.onError) || null;
  }

  guarded(fn) {
    return guard(fn, this.onError);
  }

  add(fn) {
    if (this.disposed) { try { fn(); } catch (e) { /* ignore */ } return fn; }
    this.fns.push(fn);
    return fn;
  }

  listen(target, type, fn, opts) {
    const g = this.guarded(fn);
    target.addEventListener(type, g, opts);
    this.add(() => target.removeEventListener(type, g, opts));
    return g;
  }

  interval(fn, ms) {
    const id = setInterval(this.guarded(fn), ms);
    this.add(() => clearInterval(id));
    return id;
  }

  timeout(fn, ms) {
    const id = setTimeout(this.guarded(fn), ms);
    this.add(() => clearTimeout(id));
    return id;
  }

  observe(observer) {
    this.add(() => observer.disconnect());
    return observer;
  }

  child(opts) {
    const d = new Disposer(Object.assign({ onError: this.onError }, opts));
    this.add(() => d.dispose());
    return d;
  }

  // Resources of one optional feature: an error in its listeners or timers is reported
  // once, and the feature's resources are released (the feature stops; playback goes on).
  feature(name) {
    let d = null;
    d = this.child({ onError: (e) => { reportFeatureError(name, e); if (d) d.dispose(); } });
    return d;
  }

  // Resources of core playback: an error hands over to the original player.
  core() {
    return this.child({ onError: reportUnexpected });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const fns = this.fns.splice(0);
    for (let i = fns.length - 1; i >= 0; i--) {
      try { fns[i](); } catch (e) { console.warn(TAG, 'dispose failed', e); }
    }
  }
}

// Coalesces repeated render requests into at most one call per animation frame.
// Nothing is scheduled while the page is hidden; callers re-render on visibility change.
class FrameTask {
  constructor(fn) {
    this.fn = fn;
    this.id = 0;
    this.run = () => { this.id = 0; this.fn(); };
  }

  request() {
    if (this.id || document.hidden) return;
    this.id = requestAnimationFrame(this.run);
  }

  cancel() {
    if (this.id) cancelAnimationFrame(this.id);
    this.id = 0;
  }
}
