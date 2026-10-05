// ===================================================================================
// Utilities
// ===================================================================================

const TAG = '[Echo360 Lite]';
const NS = 'echo360lite:';
const HlsLib = typeof Hls !== 'undefined' ? Hls : window.Hls;

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

// Unexpected errors in our own handlers end up here. The bootstrap installs a handler that
// hands the page back to the original player (it runs at most once).
const unexpected = { handler: null };

function reportUnexpected(err) {
  console.error(TAG, 'unexpected error', err);
  const h = unexpected.handler;
  unexpected.handler = null;
  if (h) { try { h(err); } catch (e) { /* ignore */ } }
}

function guard(fn) {
  return function guarded() {
    try {
      return fn.apply(this, arguments);
    } catch (e) {
      reportUnexpected(e);
      return undefined;
    }
  };
}

// Owns every timer, listener, observer and child resource of a component so that one
// dispose() call releases all of them (used when switching recordings and when handing
// over to the original player). Listener and timer callbacks are wrapped with guard().
class Disposer {
  constructor() {
    this.fns = [];
    this.disposed = false;
  }

  add(fn) {
    if (this.disposed) { try { fn(); } catch (e) { /* ignore */ } return fn; }
    this.fns.push(fn);
    return fn;
  }

  listen(target, type, fn, opts) {
    const g = guard(fn);
    target.addEventListener(type, g, opts);
    this.add(() => target.removeEventListener(type, g, opts));
    return g;
  }

  interval(fn, ms) {
    const id = setInterval(guard(fn), ms);
    this.add(() => clearInterval(id));
    return id;
  }

  timeout(fn, ms) {
    const id = setTimeout(guard(fn), ms);
    this.add(() => clearTimeout(id));
    return id;
  }

  observe(observer) {
    this.add(() => observer.disconnect());
    return observer;
  }

  child() {
    const d = new Disposer();
    this.add(() => d.dispose());
    return d;
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
