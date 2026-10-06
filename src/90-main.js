// ===================================================================================
// Bootstrap
// ===================================================================================

(function main() {
  if (courseList.matches()) { try { courseList.start(); } catch (e) { /* the page works without it */ } return; }
  const adapter = ADAPTERS.find((a) => { try { return a.matches(); } catch (e) { return false; } });
  if (!adapter) return;

  let booted = false;
  let player = null;

  function startOriginal(callOriginal, arg, why) {
    if (player) { player.destroy(); player = null; }
    callOriginal(arg);
    cpuFix.start();
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
      player = new LitePlayer(lesson, {
        fetchCues: adapter.fetchCues ? (l) => adapter.fetchCues(l) : null,
        api: adapter.api ? (l) => adapter.api(l) : null,
        onFallback(reason) {
          console.info(TAG, 'switching to the original player (' + reason + ')');
          let handoff = arg;
          try { if (player) handoff = adapter.withStartTime(arg, player.video.currentTime); } catch (e) { /* keep original arg */ }
          startOriginal(callOriginal, handoff, null);
        },
      });
      if (store.get('debug', false)) window.__echo360LitePlayer = player; // development only
      // Any unexpected error in our handlers from now on: hand the page to the original player.
      unexpected.handler = () => {
        if (!player) return;
        let handoff = arg;
        try { handoff = adapter.withStartTime(arg, player.video.currentTime); } catch (e) { /* keep original arg */ }
        startOriginal(callOriginal, handoff, t('errorNotice'));
      };
      console.info(TAG, 'v' + VERSION + ' active (' + adapter.id + ', ' + lesson.sources.length + ' sources, reporting '
        + (lesson.analytics ? 'on' : 'off') + ')');
    } catch (e) {
      console.warn(TAG, 'could not start, using the original player:', e);
      startOriginal(callOriginal, arg, t('fallbackNotice'));
    }
    return undefined;
  });

  // If the page never calls the bootstrap we trapped (e.g. Echo360 changed how it starts),
  // the original player runs untouched; still try the CPU fix and say so once.
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (booted) return;
      console.info(TAG, 'player bootstrap not seen; leaving the original player in place');
      cpuFix.start();
      notice(t('fallbackNotice'));
    }, 8000);
  });
})();
