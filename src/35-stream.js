// ===================================================================================
// One <video> element fed by one hls.js instance (or native HLS), with retry and
// recovery. The player owns two of these in dual-view layouts.
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
  }

  get level() {
    return this.hls && this.hls.currentLevel >= 0 ? this.hls.currentLevel : -1;
  }

  // Loads `uri` starting at `startAt` seconds. `onReady` runs once the manifest is parsed.
  load(uri, startAt, startLevel, onReady) {
    this.destroyEngine();
    this.uri = uri;
    this.netRetries = 0;
    this.mediaRecoveries = 0;
    const v = this.video;
    if (HlsLib && HlsLib.isSupported()) {
      const hls = new HlsLib({
        startPosition: startAt,
        startLevel: startLevel == null ? -1 : startLevel,
        // Never fetch a rendition larger than the element is shown at (small PiP windows
        // and side-by-side halves stay on the low rendition).
        capLevelToPlayerSize: true,
        backBufferLength: 60,
        maxBufferLength: 30,
        xhrSetup: (xhr) => { xhr.withCredentials = true; },
      });
      this.hls = hls;
      hls.on(HlsLib.Events.ERROR, guard((e, data) => this.onError(data)));
      if (onReady) hls.once(HlsLib.Events.MANIFEST_PARSED, guard(onReady));
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
