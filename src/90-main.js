// ===================================================================================
// Bootstrap
// ===================================================================================

(function main() {
  // Rejections nobody handled: logged when they come from this script (the page's own are
  // not ours to report). Never a fallback.
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    const stack = String((r && r.stack) || '');
    if (/echo360[ -]lite/i.test(stack)) { log.warn('unhandled rejection', r); logEvent('warn', 'unhandled rejection: ' + ((r && r.message) || r)); }
  });
  if (courseList.matches()) { try { courseList.start(); } catch (e) { /* the page works without it */ } return; }
  const adapter = ADAPTERS.find((a) => { try { return a.matches(); } catch (e) { return false; } });
  if (!adapter) return;

  let booted = false;
  let player = null;

  // Hands the page to the original player. Each step is protected: an exception here would
  // otherwise travel into the page's own start-up code.
  function startOriginal(callOriginal, arg, why) {
    if (player) { try { player.destroy(); } catch (e) { log.error('cleanup failed:', e); } player = null; }
    try { callOriginal(arg); } catch (e) { log.error('original player failed to start:', e); }
    try { cpuFix.start(); } catch (e) { log.warn('cpu fix failed:', e); }
    if (why) notice(why);
  }

  adapter.intercept((arg, callOriginal) => {
    booted = true;
    if (store.get('forceOriginal', false)) {
      startOriginal(callOriginal, arg, null);
      return undefined;
    }
    try {
      const lesson = adapter.parse(arg);
      // Checked before anything is built: without a way to play HLS, the original player.
      if (!canPlayHls()) throw new Error('this browser cannot play HLS here (hls.js missing and no native HLS)');
      player = new LitePlayer(lesson, {
        fetchCues: adapter.fetchCues ? (l) => adapter.fetchCues(l) : null,
        api: adapter.api ? (l) => adapter.api(l) : null,
        onFallback(reason) {
          log.info('switching to the original player (' + reason + ')');
          let handoff = arg;
          try { if (player) handoff = adapter.withStartTime(arg, player.video.currentTime); } catch (e) { /* keep original arg */ }
          startOriginal(callOriginal, handoff, null);
        },
      });
      if (store.get('debug', false)) { window.__echo360LitePlayer = player; window.__echo360LiteDev = { HlsVideoReader, frameLuma, thumbChange, learnThreshold }; } // development only
      // Any unexpected error in our handlers from now on: hand the page to the original player.
      unexpected.handler = () => {
        if (!player) return;
        let handoff = arg;
        try { handoff = adapter.withStartTime(arg, player.video.currentTime); } catch (e) { /* keep original arg */ }
        startOriginal(callOriginal, handoff, tr('errorNotice'));
      };
      console.info(TAG, 'v' + VERSION + ' active (' + adapter.id + ', ' + lesson.sources.length + ' sources, reporting '
        + (lesson.analytics ? 'on' : 'off') + ')');
    } catch (e) {
      log.warn('could not start, using the original player:', e);
      startOriginal(callOriginal, arg, tr('fallbackNotice'));
    }
    return undefined;
  });

  // If the page never calls the bootstrap we trapped (Echo360 changed how it starts), the
  // original player runs untouched: apply the CPU fix and say so once. A slow page may still
  // start late, so the notice waits until the original player is visibly there (a video on
  // the page), checking again for up to half a minute.
  window.addEventListener('load', () => {
    let tries = 0;
    const check = () => {
      if (booted) return;
      if (!document.querySelector('video') && ++tries < 4) { setTimeout(check, BOOT_CHECK_MS); return; }
      log.info('player bootstrap not seen; leaving the original player in place');
      cpuFix.start();
      notice(tr('fallbackNotice'));
    };
    setTimeout(check, BOOT_CHECK_MS);
  });
})();
