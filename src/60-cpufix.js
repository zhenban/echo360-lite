// ===================================================================================
// Fallback: CPU fix for the original player (styled-components 4.x). Same logic as the
// standalone "Echo360 player CPU fix" script; only started when the original player runs.
//   1. Static global styles are injected once instead of on every render.
//   2. Components that churn through class names (the progress bar bakes the current
//      percentage into its CSS) get their rules in a small sheet of ours, where unused
//      classes are deleted, so the main stylesheet stops growing.
//   3. timeupdate events reach the page at most once per second during normal playback.
// ===================================================================================

const cpuFix = (function () {
  const CHURN_THRESHOLD = 20;
  const KEEP_NEWEST = 4;
  const TIMEUPDATE_MIN_INTERVAL_MS = 1000;
  const state = { gs: false, cs: false, throttleOn: false, disabled: { gs: false, cs: false } };
  let started = false;

  function disable(part, err) {
    if (state.disabled[part]) return;
    state.disabled[part] = true;
    log.warn('cpu-fix part "' + part + '" disabled after an error', err);
  }

  function patchGlobalStyle(proto) {
    const origRender = proto.renderStyles;
    const origRemove = proto.removeStyles;
    const rendered = new WeakMap();
    proto.renderStyles = function (ctx, ss) {
      let skip = false;
      let mark = false;
      if (!state.disabled.gs) {
        try {
          if (this.isStatic === true && ss && typeof ss.hasId === 'function') {
            const set = rendered.get(ss);
            skip = !!set && set.has(this) && ss.hasId(this.componentId);
            mark = !skip;
          }
        } catch (e) { disable('gs', e); skip = mark = false; }
      }
      if (skip) return undefined;
      const result = origRender.apply(this, arguments);
      if (mark) {
        let set = rendered.get(ss);
        if (!set) rendered.set(ss, (set = new WeakSet()));
        set.add(this);
      }
      return result;
    };
    proto.removeStyles = function (ss) {
      try { const set = rendered.get(ss); if (set) set.delete(this); } catch (e) { /* ignore */ }
      return origRemove.apply(this, arguments);
    };
  }

  const own = { sheet: null, namesById: new Map(), names: new Set() };
  function ownSheet() {
    if (own.sheet && own.sheet.ownerNode && own.sheet.ownerNode.isConnected) return own.sheet;
    const elem = document.createElement('style');
    elem.setAttribute('data-echo360-lite-cpu-fix', '');
    document.head.appendChild(elem);
    own.sheet = elem.sheet;
    own.names.clear();
    own.namesById.clear();
    return own.sheet;
  }
  function isLocalSheet(ss) {
    const tags = ss && ss.tags;
    if (!Array.isArray(tags) || tags.length === 0) return false;
    return tags.every((tg) => tg && tg.styleTag && tg.styleTag.ownerDocument === document);
  }
  function classRegex(name) { return new RegExp('\\.' + name.replace(/[^\w-]/g, '\\$&') + '(?![\\w-])'); }
  function evict(list) {
    const sheet = own.sheet;
    const keep = [];
    const drop = [];
    list.forEach((name, i) => {
      if (i >= list.length - KEEP_NEWEST || document.getElementsByClassName(name).length > 0) keep.push(name);
      else drop.push(name);
    });
    if (!drop.length) return;
    const res = drop.map(classRegex);
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      if (res.some((re) => re.test(sheet.cssRules[i].cssText))) sheet.deleteRule(i);
    }
    drop.forEach((n) => own.names.delete(n));
    list.length = 0;
    list.push(...keep);
  }
  function addRules(id, name, rules) {
    const sheet = ownSheet();
    for (const r of rules) { try { sheet.insertRule(r, sheet.cssRules.length); } catch (e) { /* ignore */ } }
    own.names.add(name);
    let list = own.namesById.get(id);
    if (!list) own.namesById.set(id, (list = []));
    list.push(name);
    if (list.length > KEEP_NEWEST) evict(list);
  }
  function patchComponentStyle(proto) {
    const origGen = proto.generateAndInjectStyles;
    const churn = new Map();
    proto.generateAndInjectStyles = function (ctx, ss) {
      if (state.disabled.cs) return origGen.apply(this, arguments);
      const id = this.componentId;
      let st;
      try {
        st = churn.get(id);
        if (!st) churn.set(id, (st = { seen: new Set(), active: false }));
        if (st.active && isLocalSheet(ss)) {
          let captured = null;
          const proxy = new Proxy(ss, {
            get(target, key) {
              if (key === 'hasNameForId') return (cid, name) => (cid === id ? own.names.has(name) : target.hasNameForId(cid, name));
              if (key === 'inject') {
                return (cid, rules, name) => {
                  if (cid === id && typeof name === 'string' && Array.isArray(rules)) captured = { rules, name };
                  else target.inject(cid, rules, name);
                };
              }
              const val = target[key];
              return typeof val === 'function' ? val.bind(target) : val;
            },
          });
          const name = origGen.call(this, ctx, proxy);
          if (captured) addRules(id, captured.name, captured.rules);
          return name;
        }
      } catch (e) { disable('cs', e); return origGen.apply(this, arguments); }
      const name = origGen.apply(this, arguments);
      try {
        if (!st.active && this.isStatic === false && typeof name === 'string') {
          st.seen.add(name);
          if (st.seen.size > CHURN_THRESHOLD) { st.active = true; st.seen = null; }
        }
      } catch (e) { /* ignore */ }
      return name;
    };
  }

  function installThrottle() {
    const last = new WeakMap();
    window.addEventListener('timeupdate', (e) => {
      const v = e.target;
      if (!state.throttleOn || !e.isTrusted || !(v instanceof HTMLMediaElement)) return;
      const now = performance.now();
      const ct = v.currentTime;
      const prev = last.get(v);
      const expected = prev ? prev.media + ((now - prev.wall) / 1000) * (v.playbackRate || 1) : NaN;
      if (!prev || v.paused || v.seeking || v.ended || !(Math.abs(ct - expected) < 1) || now - prev.wall >= TIMEUPDATE_MIN_INTERVAL_MS) {
        last.set(v, { wall: now, media: ct });
        return;
      }
      e.stopImmediatePropagation();
    }, true);
  }

  function scan() {
    let gsProto = null;
    let csProto = null;
    for (const elem of document.querySelectorAll('body, body *')) {
      const c = elem._reactRootContainer;
      const root = c && (c._internalRoot || c);
      if (!root || !root.current) continue;
      const stack = [root.current];
      while (stack.length && !(gsProto && csProto)) {
        const f = stack.pop();
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
        const gs = f.stateNode && f.stateNode.state && f.stateNode.state.globalStyle;
        if (!gsProto && gs && typeof gs.componentId === 'string' && typeof gs.isStatic === 'boolean') {
          const p = Object.getPrototypeOf(gs);
          if (p && ['renderStyles', 'removeStyles', 'createStyles'].every((k) => typeof p[k] === 'function')) gsProto = p;
        }
        const cs = f.memoizedProps && f.memoizedProps.forwardedComponent && f.memoizedProps.forwardedComponent.componentStyle;
        if (!csProto && cs && typeof cs.componentId === 'string' && typeof cs.isStatic === 'boolean' && Array.isArray(cs.rules)) {
          const p = Object.getPrototypeOf(cs);
          if (p && typeof p.generateAndInjectStyles === 'function' && p.generateAndInjectStyles.length === 2) csProto = p;
        }
      }
    }
    return { gsProto, csProto };
  }

  // Polls once a second (at most 60 s) until the original player's styled-components
  // internals are found and patched, then stops.
  function start() {
    if (started) return;
    started = true;
    installThrottle();
    const t0 = Date.now();
    const timer = setInterval(() => {
      const elem = document.querySelector('style[data-styled-version]');
      const ver = elem && elem.getAttribute('data-styled-version');
      if (ver && !/^4\./.test(ver)) { clearInterval(timer); log.info('cpu-fix inactive: styled-components ' + ver); return; }
      if (ver) {
        try {
          const { gsProto, csProto } = scan();
          if (gsProto && !state.gs) { patchGlobalStyle(gsProto); state.gs = true; }
          if (csProto && !state.cs) { patchComponentStyle(csProto); state.cs = true; }
        } catch (e) { clearInterval(timer); log.warn('cpu-fix scan failed', e); return; }
      }
      if (state.gs && state.cs) {
        state.throttleOn = true;
        clearInterval(timer);
        log.info('cpu-fix active on the original player');
      } else if (Date.now() - t0 > 60000) {
        clearInterval(timer);
        log.info('cpu-fix inactive: player internals not found');
      }
    }, 1000);
  }

  return { start, state };
})();
