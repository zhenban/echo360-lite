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

class Stream {
  constructor(video, onFatal) {
    this.video = video;
    this.onFatal = onFatal;
    this.hls = null;
    this.uri = null;
    this.netRetries = 0;
    this.mediaRecoveries = 0;
    this.retryTimer = 0;
    this.quality = 'auto'; // 'auto' or a rendition height
    this.capHeight = 0;    // 0 = no cap
    this.onLevel = null;   // called when the playing rendition changes
    this.priority = 'high'; // 'low': steps down first and up last when bandwidth is short
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

  // Loads `uri` starting at `startAt` seconds. `onReady` runs once the manifest is parsed.
  load(uri, startAt, onReady) {
    this.destroyEngine();
    this.uri = uri;
    this.netRetries = 0;
    this.mediaRecoveries = 0;
    const v = this.video;
    if (HlsLib && HlsLib.isSupported()) {
      const hls = new HlsLib({
        startPosition: startAt,
        capLevelToPlayerSize: false,
        // Assume a good connection until measured, and step up again as soon as the
        // measured bandwidth allows (defaults: 500 kbps estimate, 0.7 up factor).
        abrEwmaDefaultEstimate: 5e6,
        abrBandWidthFactor: this.priority === 'low' ? 0.7 : 0.95,
        abrBandWidthUpFactor: this.priority === 'low' ? 0.6 : 0.85,
        backBufferLength: 60,
        maxBufferLength: 30,
        xhrSetup: (xhr) => { xhr.withCredentials = true; },
      });
      this.hls = hls;
      hls.on(HlsLib.Events.ERROR, guard((e, data) => this.onError(data)));
      hls.once(HlsLib.Events.MANIFEST_PARSED, guard(() => {
        this.applyQuality(true);
        if (onReady) onReady();
      }));
      hls.on(HlsLib.Events.LEVEL_SWITCHED, guard(() => { if (this.onLevel) this.onLevel(); }));
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
    if (!data || !data.fatal || !this.hls) return;
    const code = data.response && data.response.code;
    if (code !== 401 && code !== 403) {
      if (data.type === HlsLib.ErrorTypes.NETWORK_ERROR && this.netRetries < 4) {
        this.netRetries++;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(guard(() => this.hls && this.hls.startLoad()), 1000 * this.netRetries);
        return;
      }
      if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries < 2) {
        this.mediaRecoveries++;
        this.hls.recoverMediaError();
        return;
      }
    }
    console.warn(TAG, 'fatal hls error', data.type, data.details, code || '');
    this.onFatal({ auth: code === 401 || code === 403, details: data.details });
  }

  kick(at) {
    if (this.hls) this.hls.startLoad(at);
  }

  destroyEngine() {
    clearTimeout(this.retryTimer);
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
