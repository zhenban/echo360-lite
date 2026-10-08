// ===================================================================================
// One <video> element fed by one hls.js instance (or native HLS), with retry and
// recovery. The player owns two of these in dual-view layouts.
//
// Quality: slides and code must be readable, so "auto" starts at the highest rendition
// and only steps down when the network cannot keep up (hls.js ABR, started from an
// optimistic bandwidth estimate and quick to step back up). A fixed height locks that
// rendition. A cap (used for the camera in a small picture-in-picture window) limits auto
// without affecting a fixed choice.
// ===================================================================================

// Whether streams can be played at all: hls.js with Media Source Extensions, or native HLS.
function canPlayHls() {
  if (typeof HlsLib !== 'undefined' && HlsLib && HlsLib.isSupported()) return true;
  try { return !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl'); } catch (e) { return false; }
}

class Stream {
  constructor(video, onFatal) {
    this.video = video;
    this.onFatal = onFatal;
    this.onAuth = null;     // a request was refused (401/403), fatal or not yet
    this.hls = null;
    this.uri = null;
    this.netRetries = 0;
    this.mediaRecoveries = 0;
    this.retryTimer = 0;
    this.quality = 'auto'; // 'auto' or a rendition height
    this.capHeight = 0;    // 0 = no cap
    this.onLevel = null;   // called when the playing rendition changes
    this.priority = 'high'; // 'low': steps down first and up last when bandwidth is short
    // While a load is starting: where it is meant to start and whether it should play.
    // The element says 0 and paused until it gets there, so it cannot be asked (a second
    // reload in that window would start at 0).
    this.starting = null;     // { at, play } or null
    this.renewedAt = 0;       // when access was last renewed for this stream (see the player's recoverAccess)
    this.arrived = null;      // listener clearing `starting`
  }

  // Where this stream is (or, while starting, is about to be).
  position() {
    return this.starting ? this.starting.at : this.video.currentTime;
  }

  // Whether it plays (or, while starting, is going to).
  playing() {
    return this.starting ? this.starting.play : !this.video.paused;
  }

  // The user seeked or played/paused before the load arrived: that is the new intent.
  intend(at, play) {
    if (!this.starting) return;
    if (at != null) this.starting.at = at;
    if (play != null) this.starting.play = play;
  }

  // Renditions as [{ height, bitrate }], in hls.js order (lowest first).
  get levels() {
    return this.hls ? this.hls.levels.map((l) => ({ height: l.height, bitrate: l.bitrate })) : [];
  }

  // Height of the rendition being played (0 when unknown).
  get height() {
    const h = this.hls;
    if (!h || !h.levels.length) return this.video.videoHeight || 0;
    const i = h.currentLevel >= 0 ? h.currentLevel : h.loadLevel;
    return i >= 0 && h.levels[i] ? h.levels[i].height : 0;
  }

  // Index of the rendition for a fixed height: the tallest not above it, else the lowest.
  levelFor(height) {
    const ls = this.hls ? this.hls.levels : [];
    let pick = 0;
    ls.forEach((l, i) => { if (l.height <= height && l.height >= ls[pick].height) pick = i; });
    return pick;
  }

  applyQuality(starting) {
    const h = this.hls;
    if (!h || !h.levels.length) return;
    const top = h.levels.length - 1;
    if (this.quality === 'auto') {
      // Smallest rendition at least as tall as the cap; no cap: everything allowed.
      let cap = -1;
      if (this.capHeight) {
        cap = top;
        h.levels.forEach((l, i) => { if (l.height >= this.capHeight && l.height < h.levels[cap].height) cap = i; });
      }
      h.autoLevelCapping = cap;
      if (starting) h.startLevel = cap >= 0 ? cap : top;
      else if (!h.autoLevelEnabled) h.nextLevel = -1;
    } else {
      h.autoLevelCapping = -1;
      const i = this.levelFor(this.quality);
      if (starting) { h.startLevel = i; h.nextLevel = i; } else h.nextLevel = i;
    }
  }

  setQuality(q) {
    this.quality = q;
    this.applyQuality(false);
  }

  setCap(height) {
    if (height === this.capHeight) return;
    this.capHeight = height;
    if (this.quality === 'auto') this.applyQuality(false);
  }

  get level() {
    return this.hls && this.hls.currentLevel >= 0 ? this.hls.currentLevel : -1;
  }

  // Loads `uri` starting at `startAt` seconds. `onReady` runs once the manifest is parsed;
  // `play`: whether it is meant to play (what playing() says until it has arrived).
  load(uri, startAt, onReady, play) {
    this.destroyEngine();
    this.uri = uri;
    this.starting = { at: startAt || 0, play: !!play };
    const v0 = this.video;
    // Arrived: data is there at (about) the intended position.
    this.arrived = () => {
      const s = this.starting;
      if (s && v0.readyState >= 2 && Math.abs(v0.currentTime - s.at) <= 1) this.clearStarting();
    };
    v0.addEventListener('canplay', this.arrived);
    v0.addEventListener('seeked', this.arrived);
    this.netRetries = 0;
    this.mediaRecoveries = 0;
    const v = this.video;
    if (HlsLib && HlsLib.isSupported()) {
      const hls = new HlsLib({
        startPosition: startAt,
        capLevelToPlayerSize: false,
        // Start from the connection the browser reports (hls.js assumes 500 kbps), and step
        // up again as soon as the measured bandwidth allows (hls.js: 0.7 up factor).
        abrEwmaDefaultEstimate: STREAM_START_BPS(),
        abrBandWidthFactor: STREAM_BW_FACTOR[this.priority === 'low' ? 'low' : 'main'][0],
        abrBandWidthUpFactor: STREAM_BW_FACTOR[this.priority === 'low' ? 'low' : 'main'][1],
        backBufferLength: STREAM_BACK_BUFFER_SEC,
        maxBufferLength: STREAM_MAX_BUFFER_SEC,
        xhrSetup: (xhr) => { xhr.withCredentials = true; },
      });
      this.hls = hls;
      hls.on(HlsLib.Events.ERROR, guardCore((e, data) => this.onError(data)));
      hls.once(HlsLib.Events.MANIFEST_PARSED, guardCore(() => {
        this.applyQuality(true);
        if (onReady) onReady();
      }));
      hls.on(HlsLib.Events.LEVEL_SWITCHED, guardCore(() => { if (this.onLevel) this.onLevel(); }));
      // hls.js resets the MediaSource after some failed appends (refused segments can cause
      // them) and then starts over at startPosition: keep the position and play state.
      hls.on(HlsLib.Events.MEDIA_DETACHING, guardCore(() => {
        if (this.hls === hls && v.readyState > 0) this.restore = { t: v.currentTime, play: !v.paused };
      }));
      hls.on(HlsLib.Events.MEDIA_ATTACHED, guardCore(() => {
        const r = this.restore;
        this.restore = null;
        if (!r || this.hls !== hls) return;
        // Only for this hls instance: if the view is swapped before the metadata arrives,
        // the new source must not jump to the old position.
        const onMeta = () => {
          this.pendingRestore = null;
          if (this.hls !== hls) return;
          if (Math.abs(v.currentTime - r.t) > 1) v.currentTime = r.t;
          if (r.play && v.paused) v.play().catch(() => {});
        };
        this.pendingRestore = onMeta;
        v.addEventListener('loadedmetadata', onMeta, { once: true });
      }));
      hls.loadSource(uri);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari): the CDN answers credentialed CORS requests, so frames and audio
      // stay readable for later Web Audio / canvas features.
      v.crossOrigin = 'use-credentials';
      v.src = uri;
      v.addEventListener('loadedmetadata', () => { if (startAt) v.currentTime = startAt; if (onReady) onReady(); }, { once: true });
    } else {
      throw new Error('neither MSE (hls.js) nor native HLS is available');
    }
  }

  onError(data) {
    if (!data || !this.hls) return;
    const code = data.response && data.response.code;
    // Refused: hls.js would keep retrying for half a minute; renew the access now so that
    // one of its retries succeeds.
    if ((code === 401 || code === 403) && !data.fatal && this.onAuth) { this.onAuth(); return; }
    if (!data.fatal) return;
    if (code !== 401 && code !== 403) {
      if (data.type === HlsLib.ErrorTypes.NETWORK_ERROR && this.netRetries < STREAM_NET_RETRIES) {
        this.netRetries++;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(guardCore(() => this.hls && this.hls.startLoad()), 1000 * this.netRetries);
        return;
      }
      if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries < STREAM_MEDIA_RECOVERIES) {
        this.mediaRecoveries++;
        this.hls.recoverMediaError();
        return;
      }
    }
    log.warn('fatal hls error', data.type, data.details, code || '');
    this.onFatal({ auth: code === 401 || code === 403, details: data.details });
  }

  kick(at) {
    if (this.hls) this.hls.startLoad(at);
  }

  // After the access was renewed: carry on loading from `at`, keeping the element (and so
  // any Web Audio graph on it) and everything already buffered. A failure before the
  // playlists were read loads the source again.
  resume(at) {
    const h = this.hls;
    if (!h) return;
    this.netRetries = 0;
    if (!h.levels || !h.levels.length) { h.loadSource(this.uri); return; }
    h.startLoad(at);
  }

  clearStarting() {
    this.starting = null;
    if (this.arrived) {
      this.video.removeEventListener('canplay', this.arrived);
      this.video.removeEventListener('seeked', this.arrived);
      this.arrived = null;
    }
  }

  destroyEngine() {
    clearTimeout(this.retryTimer);
    this.clearStarting();
    if (this.pendingRestore) { this.video.removeEventListener('loadedmetadata', this.pendingRestore); this.pendingRestore = null; }
    if (this.hls) { this.hls.destroy(); this.hls = null; }
  }

  // Stops loading and releases the element's media resource.
  destroy() {
    this.destroyEngine();
    const v = this.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
    this.uri = null;
  }
}
