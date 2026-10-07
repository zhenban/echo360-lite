// ===================================================================================
// Watch reporting. Mirrors what the original player sends: a session record when playback
// first starts / the page unloads, and a heartbeat every 30 s while playing (plus one on
// pause). Position, rate, volume and the played ranges are read from the real <video>.
// ===================================================================================

class PlayedRanges {
  constructor() { this.ranges = []; }

  add(start, end) {
    if (!(end > start)) return;
    const out = [];
    let s = start;
    let e = end;
    for (const r of this.ranges) {
      if (r[1] < s || r[0] > e) out.push(r);
      else { s = Math.min(s, r[0]); e = Math.max(e, r[1]); }
    }
    out.push([s, e]);
    out.sort((a, b) => a[0] - b[0]);
    this.ranges = out;
  }

  absorb(timeRanges) {
    for (let i = 0; i < timeRanges.length; i++) this.add(timeRanges.start(i), timeRanges.end(i));
  }

  merged(timeRanges) {
    const copy = new PlayedRanges();
    copy.ranges = this.ranges.slice();
    if (timeRanges) copy.absorb(timeRanges);
    return copy.ranges;
  }
}

class Reporter {
  constructor(info, video, played, disposer) {
    this.info = info;
    this.video = video;
    this.played = played;
    this.begun = false;
    this.ended = false;
    this.lastSessionAt = 0;
    this.timer = 0;
    this.captionsAvailable = undefined;
    this.d = disposer;
    const onUnload = () => this.end();
    this.d.listen(window, 'pagehide', onUnload);
    this.d.add(() => this.detach());
    // The original player validates the session on load; the response may carry a fresh token.
    fetch(info.appUrl + '/api/ui/sessions/' + encodeURIComponent(info.sessionId), { credentials: 'include', headers: this.headers(false) })
      .then((r) => this.saveToken(r))
      .catch((e) => log.info('watch report (session) failed:', e));
  }

  headers(withBody) {
    const h = { Accept: 'application/json' };
    if (withBody) h['Content-Type'] = 'application/json';
    let jwt = null;
    try { jwt = localStorage.getItem('authn-jwt'); } catch (e) { /* ignore */ }
    if (jwt) h.Authorization = 'Bearer ' + jwt;
    return h;
  }

  saveToken(response) {
    const tok = response && response.headers && response.headers.get('token');
    if (tok) { try { localStorage.setItem('authn-jwt', tok); } catch (e) { /* ignore */ } }
    return response;
  }

  post(path, body, retried) {
    return fetch(this.info.gatewayUrl + path, {
      method: 'POST', credentials: 'include', keepalive: true, headers: this.headers(true), body: JSON.stringify(body),
    }).then((r) => {
      if (r.status === 401 && !retried) {
        return fetch(this.info.gatewayUrl + '/authn/token/refresh-header', { method: 'POST', credentials: 'include', headers: this.headers(false) })
          .then((rr) => this.saveToken(rr))
          .then(() => this.post(path, body, true));
      }
      return r;
    }).catch((e) => log.info('watch report failed:', e));
  }

  mediaState() {
    const v = this.video;
    const ms = (x) => Math.round(1000 * x);
    return {
      playback_rate: Math.round(100 * v.playbackRate),
      played: this.played.merged(v.played).map((r) => ({ start: ms(r[0]), end: ms(r[1]) })),
      position: ms(v.currentTime),
      volume: Math.round(100 * v.volume),
    };
  }

  // Reported as the user actually has them: captions shown, transcript panel open.
  playerState() {
    const s = this.stateFn ? this.stateFn() : {};
    return { caption_active: !!s.captions, caption_available: this.captionsAvailable, transcription_active: !!s.transcript };
  }

  sendSession(lifecycle) {
    const i = this.info;
    this.lastSessionAt = Date.now();
    return this.post('/a/player/session', {
      browser: { referrer: document.referrer, url: location.href },
      context: i.context,
      lifecycle,
      link: i.link,
      media_id: i.mediaId,
      media_state: this.mediaState(),
      player_state: this.playerState(),
      session_id: i.sessionId,
      user: i.user,
    });
  }

  heartbeat() {
    if (!this.begun || this.ended) return;
    if (Date.now() - this.lastSessionAt > 172800000) this.sendSession('SESSION_STALE');
    this.post('/a/player/beacon', {
      media_id: this.info.mediaId, media_state: this.mediaState(), player_state: this.playerState(), session_id: this.info.sessionId,
    });
  }

  onPlay() {
    if (this.ended) return;
    if (!this.begun) { this.begun = true; this.sendSession('SESSION_BEGIN'); }
    clearInterval(this.timer);
    this.timer = setInterval(() => this.heartbeat(), 30000);
  }

  onPause() {
    clearInterval(this.timer);
    this.timer = 0;
    this.heartbeat();
  }

  end() {
    if (!this.begun || this.ended) return;
    clearInterval(this.timer);
    this.sendSession('SESSION_END');
    this.ended = true;
  }

  // Called on dispose (handing over to the original player, which starts its own reporting).
  detach() {
    if (this.begun && !this.ended) this.onPause();
    this.ended = true;
    clearInterval(this.timer);
  }
}
