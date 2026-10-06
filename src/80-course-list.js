// ===================================================================================
// Course page (/section/<id>/home): a small "watched" mark next to each recording.
//
// Light by design: nothing on the page is moved or replaced, one small label is added to
// each lesson row (and again if the list is redrawn). The share comes from this device's
// record (43-watched.js); for recordings opened elsewhere, Echo360's last position is shown
// instead (one request per such recording, a few at a time, after the page has settled).
// Anything that fails is skipped without a word.
// ===================================================================================

const courseList = {
  matches() {
    return /(^|\.)echo360\.[a-z.]+$/.test(location.hostname) && /^\/section\/[^/]+\/home/.test(location.pathname);
  },

  start() {
    const section = location.pathname.split('/')[2];
    const known = new Map();   // lessonId -> label info (null while loading)
    let server = null;         // promise of { lessonId: { mediaId, read } } from the syllabus
    const style = document.createElement('style');
    style.textContent = '.e3l-watch{display:inline-block;margin-left:10px;padding:1px 7px;border-radius:9px;font-size:12px;line-height:18px;'
      + 'vertical-align:middle;background:#e8f3ee;color:#1d6b4f;white-space:nowrap}.e3l-watch.e3l-last{background:#eef1f6;color:#4a5568}'
      + '.e3l-watch.e3l-done{background:#1d6b4f;color:#fff}';

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
      while (running < 2 && queue.length) {
        const job = queue.shift();
        running++;
        job().catch(() => {}).finally(() => { running--; setTimeout(pump, 150); });
      }
    };

    const label = (row, info) => {
      const host = row.querySelector('.header-details') || row.querySelector('header') || row;
      let el = host.querySelector('.e3l-watch');
      if (!info) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('span'); host.append(el); }
      const pct = Math.max(1, Math.round(info.share * 100));  // never "0%" for something watched
      el.className = 'e3l-watch' + (info.last ? ' e3l-last' : pct >= 95 ? ' e3l-done' : '');
      el.textContent = info.last ? t('listLastAt', { pct }) : t('listWatched', { pct });
      el.title = info.last ? t('listLastAtTitle') : t('listWatchedTitle');
    };

    const lookup = async (lid) => {
      const rec = await idbCache.get('watched:' + lid);
      const share = watchedShare(rec);
      if (share > 0) return { share, last: false };
      const s = (await syllabus())[lid];
      if (!s || !s.read) return null;
      const r = await fetch('/api/ui/echoplayer/lessons/' + encodeURIComponent(lid) + '/media/' + encodeURIComponent(s.mediaId) + '/player-properties',
        { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const d = (await r.json()).data || {};
      const dur = parseIsoDuration(d.playableAudioVideo && d.playableAudioVideo.duration);
      const pos = d.lastPlayedToSeconds;
      return dur > 0 && pos > 0 ? { share: Math.min(1, pos / dur), last: true } : null;
    };

    const scan = () => {
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
        pending = setTimeout(() => { pending = 0; scan(); }, 300);
      }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true }); else observe();
  },
};
