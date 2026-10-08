// ===================================================================================
// Course page (/section/<id>/home): a small progress bar next to each recording.
//
// It shows two things at once, each only when known:
//   - filled stretches: what was watched on this device (43-watched.js), with the share in
//     words (an empty ending, black screen and silence, does not count);
//   - a tick: where Echo360 says you stopped last time (any device), from the player's
//     properties (one request per opened recording, a few at a time).
// A tooltip says which is which. Light by design: nothing on the page is moved or replaced,
// one small element is added to each lesson row (again if the list is redrawn). Anything
// that fails is skipped without a word.
// ===================================================================================

const courseList = {
  matches() {
    return /(^|\.)echo360\.[a-z.]+$/.test(location.hostname) && /^\/section\/[^/]+\/home/.test(location.pathname);
  },

  start() {
    let section = location.pathname.split('/')[2];
    const known = new Map();   // lessonId -> label info (null while loading)
    let server = null;         // promise of { lessonId: { mediaId, read } } from the syllabus
    const style = document.createElement('style');
    style.textContent = '.e3l-watch{display:inline-flex;align-items:center;gap:6px;margin-left:12px;font-size:12px;line-height:18px;'
      + 'vertical-align:middle;color:#1d6b4f;white-space:nowrap}'
      + '.e3l-bar{position:relative;width:72px;height:6px;border-radius:3px;background:#e2e8f0;overflow:hidden}'
      + '.e3l-bar i{position:absolute;top:0;bottom:0;background:#2f855a}'
      + '.e3l-bar b{position:absolute;top:-1px;bottom:-1px;width:2px;margin-left:-1px;background:#2d3748}'
      + '.e3l-watch.e3l-done{color:#22543d;font-weight:600}.e3l-watch .e3l-last{color:#4a5568}';

    const syllabus = () => {
      if (!server) {
        server = fetch('/section/' + encodeURIComponent(section) + '/syllabus', { credentials: 'include', headers: { Accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            const out = {};
            for (const x of (j && j.data) || []) {
              const l = x.lesson;
              const m = l && l.medias && l.medias[0];
              if (l && l.lesson && m) out[l.lesson.id] = { mediaId: m.id, read: !!m.isRead };
            }
            return out;
          })
          .catch(() => ({}));
      }
      return server;
    };

    const queue = [];
    let running = 0;
    const pump = () => {
      while (running < LIST_CONCURRENT && queue.length) {
        const job = queue.shift();
        running++;
        job().catch(() => {}).finally(() => { running--; setTimeout(pump, LIST_GAP_MS); });
      }
    };

    const label = (row, info) => {
      const host = row.querySelector('.header-details') || row.querySelector('header') || row;
      let el = host.querySelector('.e3l-watch');
      if (!info) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('span'); host.append(el); }
      el.textContent = '';
      const bar = document.createElement('span');
      bar.className = 'e3l-bar';
      const dur = info.dur;
      const tips = [];
      if (info.ranges) {
        for (const [a, b] of info.ranges) {
          const i = document.createElement('i');
          i.style.left = ((Math.max(0, a) / dur) * 100).toFixed(2) + '%';
          i.style.width = (((Math.min(b, dur) - Math.max(0, a)) / dur) * 100).toFixed(2) + '%';
          bar.append(i);
        }
      }
      if (info.last != null) {
        const b = document.createElement('b');
        b.style.left = Math.min(100, (info.last / dur) * 100).toFixed(2) + '%';
        bar.append(b);
      }
      el.append(bar);
      const txt = document.createElement('span');
      if (info.ranges) {
        const pct = Math.max(1, Math.round(info.share * 100)); // never "0%" for something watched
        txt.textContent = t('listWatched', { pct });
        tips.push(t('listWatchedTitle', { pct }));
        el.className = 'e3l-watch' + (pct >= LIST_DONE_PCT ? ' e3l-done' : '');
      } else {
        txt.textContent = t('listLastAt', { time: fmtTime(info.last) });
        txt.className = 'e3l-last';
        el.className = 'e3l-watch';
      }
      if (info.last != null) tips.push(t('listLastAtTitle', { time: fmtTime(info.last) }));
      el.append(txt);
      el.title = tips.join('; ');
    };

    // { dur, ranges, share } from this device and/or { last } from Echo360; null if neither.
    const lookup = async (lid) => {
      const rec = await idbCache.get('watched:' + lid);
      const out = {};
      if (rec && rec.d > 0 && Array.isArray(rec.r) && rec.r.length) {
        out.dur = rec.d;
        out.ranges = rec.r;
        out.share = watchedShare(rec);
      }
      const s = (await syllabus())[lid];
      if (s && s.read) {
        try {
          const r = await fetch('/api/ui/echoplayer/lessons/' + encodeURIComponent(lid) + '/media/' + encodeURIComponent(s.mediaId) + '/player-properties',
            { credentials: 'include', headers: { Accept: 'application/json' } });
          if (r.ok) {
            const d = (await r.json()).data || {};
            const dur = parseIsoDuration(d.playableAudioVideo && d.playableAudioVideo.duration);
            if (dur > 0 && d.lastPlayedToSeconds > 0) { out.last = d.lastPlayedToSeconds; if (!out.dur) out.dur = dur; }
          }
        } catch (e) { /* no tick */ }
      }
      return out.dur ? out : null;
    };

    const scan = () => {
      // The site can move to another course without loading a new page: start over.
      const now = /^\/section\/([^/]+)\/home/.exec(location.pathname);
      if (!now) return;
      if (now[1] !== section) { section = now[1]; known.clear(); server = null; }
      for (const row of document.querySelectorAll('.class-row[data-test-lessonid]')) {
        const lid = row.getAttribute('data-test-lessonid');
        // Rows drawn again lose the label; a row that has it is left alone (labelling is
        // itself a change the observer sees).
        if (known.has(lid)) { if (known.get(lid) && !row.querySelector('.e3l-watch')) label(row, known.get(lid)); continue; }
        known.set(lid, null);
        queue.push(() => lookup(lid).then((info) => {
          known.set(lid, info);
          for (const r of document.querySelectorAll('.class-row[data-test-lessonid="' + lid.replace(/"/g, '') + '"]')) label(r, info);
        }));
      }
      pump();
    };

    let pending = 0;
    const observe = () => {
      document.head.append(style);
      scan();
      // The list is drawn by the page's own script and redrawn on sorting or filtering.
      new MutationObserver(() => {
        if (pending) return;
        pending = setTimeout(() => { pending = 0; scan(); }, LIST_DEBOUNCE_MS);
      }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true }); else observe();
  },
};
