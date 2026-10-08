// ===================================================================================
// Keeping the video access alive.
//
// Echo360 grants access to the video files with CloudFront signed cookies (HttpOnly, for
// all of the institution's media). They are valid for about two hours and are issued again
// by the lesson page itself: a GET of the page renews them once they are older than the
// renewal interval the page states (cookieRenewalIntervalMillis, one hour). The original
// player reloads the page after a day; we fetch the page in the background instead, which
// needs no new player, video element or page reload.
//
// - Ahead of time: every renewal interval while the page is open, and on returning to the
//   tab or pressing play when the last renewal is older than that (timers stall while a
//   laptop sleeps).
// - On failure: a 401 or 403 from the video files (playlists, segments, background
//   downloads) renews at once and the caller retries.
// - A renewal tries up to three times (two retries). If the school login itself has
//   expired, the page answers with a redirect to the login page: that cannot be fixed in
//   the background, so the keeper gives up and the player asks the user to reload.
//
// mediaSession.renew() is what fetchOk() (53-media-io.js) calls for background downloads.
// ===================================================================================


const mediaSession = { renew: null };

class SessionKeeper {
  // opts: { url (the lesson page), renewMs, disposer, onState(state), retryMs (tests) }
  // state: 'renewing' (after a failure) | 'ok' | 'failed' ({ login: bool })
  constructor(opts) {
    this.url = opts.url;
    this.renewMs = opts.renewMs > 0 ? opts.renewMs : SESSION_DEFAULT_RENEW_MS;
    this.onState = opts.onState || (() => {});
    this.retryMs = opts.retryMs || SESSION_RETRY_MS;
    this.last = Date.now();       // the page load renewed the cookies if they needed it
    this.pending = null;
    this.failed = null;           // { login } once renewal has given up
    this.renewals = 0;
    this.d = opts.disposer;
    this.timer = 0;
    // Once the player is gone (falling back to the original player), nothing may start
    // again: a renewal still on its way must not schedule the next one.
    this.disposed = false;
    this.ac = new AbortController();
    this.d.add(() => { this.disposed = true; this.ac.abort(); clearTimeout(this.timer); });
    this.schedule();
    const wake = () => { if (!document.hidden && Date.now() - this.last > this.renewMs) this.renew(false).catch(() => {}); };
    this.d.listen(document, 'visibilitychange', wake);
    this.wake = wake;
    const hook = () => this.renew(true);
    mediaSession.renew = hook;
    this.d.add(() => { if (mediaSession.renew === hook) mediaSession.renew = null; });
  }

  schedule() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.renew(false).catch(() => {}), Math.max(SESSION_MIN_RENEW_MS, this.renewMs - (Date.now() - this.last)));
  }

  // Renews the cookies. `afterFailure`: something was refused, so the user may notice a
  // pause and is told what is going on. Concurrent calls share one renewal.
  renew(afterFailure) {
    if (this.disposed) return Promise.reject(new Error('stopped'));
    if (this.failed) return Promise.reject(new Error('session expired'));
    if (this.pending) return this.pending;
    if (afterFailure) this.onState('renewing');
    this.pending = this.attempt(0).then(() => {
      if (this.disposed) throw new Error('stopped');
      this.last = Date.now();
      this.renewals++;
      this.onState('ok');
    }, (e) => {
      if (this.disposed) throw e;
      // A routine renewal that could not reach the server is tried again later; the
      // cookies are still valid for a while.
      if ((e && e.login) || afterFailure) {
        this.failed = { login: !!(e && e.login) };
        this.onState('failed', this.failed);
      } else this.onState('ok');
      throw e;
    }).finally(() => {
      this.pending = null;
      if (!this.failed) this.schedule();
    });
    return this.pending;
  }

  async attempt(k) {
    if (this.disposed) throw new Error('stopped');
    let r = null;
    try {
      r = await fetch(this.url, { credentials: 'include', cache: 'no-store', redirect: 'manual', signal: this.ac.signal });
    } catch (e) {
      if (this.disposed) throw new Error('stopped');
      r = null;
    }
    if (r && r.body) r.body.cancel().catch(() => {});
    // A redirect (to the login page) or a refusal: the school login has expired.
    if (r && (r.type === 'opaqueredirect' || r.status === 401 || r.status === 403)) {
      const e = new Error('login expired');
      e.login = true;
      throw e;
    }
    if (r && r.ok) return;
    if (k >= this.retryMs.length) throw new Error('renewal failed' + (r ? ' (HTTP ' + r.status + ')' : ''));
    await new Promise((res) => {
      const id = setTimeout(res, this.retryMs[k]);
      this.ac.signal.addEventListener('abort', () => { clearTimeout(id); res(); }, { once: true });
    });
    return this.attempt(k + 1);
  }
}
