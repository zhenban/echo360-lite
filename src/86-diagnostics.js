// ===================================================================================
// "Copy diagnostics": a plain-text summary to paste into a bug report. It names versions,
// the state of each feature and recent warnings and errors. It never contains credentials,
// cookies, addresses (all URLs are masked), user names, notes or discussion text; the user
// sees the exact text before copying it.
// ===================================================================================

function browserName() {
  const ua = navigator.userAgent;
  const m = /(Edg|OPR|Firefox|Chrome|Version)\/(\d+)/.exec(ua);
  const name = !m ? 'unknown' : m[1] === 'Edg' ? 'Edge' : m[1] === 'OPR' ? 'Opera' : m[1] === 'Version' ? 'Safari' : m[1];
  return name + (m ? ' ' + m[2] : '') + ' on ' + (/(Windows|Mac OS X|Linux|Android|iPhone|iPad|CrOS)/.exec(ua) || ['', 'unknown'])[1];
}

function scriptManager() {
  try {
    if (typeof GM_info !== 'undefined' && GM_info) return (GM_info.scriptHandler || 'userscript manager') + ' ' + (GM_info.version || '');
  } catch (e) { /* not available */ }
  return 'unknown (or development)';
}

function maskUrls(s) {
  return String(s).replace(/(https?:)?\/\/[^\s'")]+/g, '<address>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => id.slice(0, 8) + '…');
}

function diagnosticsText(p) {
  const v = p.video;
  const q = (st) => (st && st.hls && st.hls.levels && st.hls.levels.length ? st.height + 'p of ' + Math.max(...st.hls.levels.map((l) => l.height)) + 'p' : '-');
  const lines = [];
  const add = (k, val) => lines.push(k + ': ' + val);
  add('Echo360 Lite', VERSION);
  add('Browser', browserName());
  add('Script manager', scriptManager());
  add('Page', location.hostname + ' (lesson page)');
  add('Recording', (p.lesson.mediaId ? String(p.lesson.mediaId).slice(0, 8) + '…' : '-') + ', ' + p.sources.length + ' view(s), ' + fmtTime(p.duration(), true));
  add('Playback', (v.paused ? 'paused' : 'playing') + ' at ' + fmtTime(v.currentTime, true) + ', speed ' + v.playbackRate + ', layout ' + p.layout
    + (p.pdfMode ? ' (PDF view)' : '') + ', quality ' + q(p.clock) + ' / ' + q(p.follower)
    + (p.fvideo && !p.fvideo.paused ? ', sync ' + Math.round((p.fvideo.currentTime - v.currentTime) * 1000) + ' ms' : ''));
  const s = p.silence;
  if (s) add('Silence detection', (s.source || '-') + (s.reason ? ' (' + s.reason + ')' : '') + ', ' + (s.silences ? s.silences.length : 0) + ' found');
  const a = p.slides;
  if (a) add('Slide chapters', a.state + ', ' + a.chapters.length + ' chapters, screen view ' + (a.screenIndex == null ? 'unknown' : a.screenIndex));
  const d = p.deck;
  if (d) {
    const r = d.ocr;
    add('Slide reader', d.state + ', ' + d.files.length + ' file(s), ' + d.pages.length + ' pages'
      + (r ? ', text on screen: ' + r.state + ', ' + Math.round(r.progress() * 100) + '% (read ' + r.stats.read + ', same ' + r.stats.same + ', failed ' + r.stats.failed + ')' : ''));
  }
  if (p.session) add('Session renewal', p.session.failed ? 'gave up (' + (p.session.failed.login ? 'sign-in expired' : 'failed') + ')' : 'ok, ' + p.session.renewals + ' renewal(s)');
  add('Notes', p.notesReady ? 'loaded' : 'not available');
  add('Audio tools', p.audio ? Object.entries(p.audio.settings || {}).filter(([, on]) => on).map(([k]) => k).join(', ') || 'off' : '-');
  add('Features turned off after an error', [...featureErrors.seen].join(', ') || 'none');
  lines.push('', 'Recent warnings and errors:');
  if (!eventLog.length) lines.push('  none');
  for (const e of eventLog) lines.push('  ' + e.t + ' ' + e.level + ' ' + maskUrls(e.text));
  return lines.join('\n');
}
