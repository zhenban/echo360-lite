// ===================================================================================
// Audio processing for the clock <video>: loudness levelling, voice enhancement, mono.
//
// createMediaElementSource() is irreversible and an AudioContext created without a user
// gesture starts suspended (which would silence the video), so the graph is only built
// from a user action. Settings remembered from an earlier visit are applied on the first
// click or key press.
//
// Only the enabled stages are connected: Chrome's DynamicsCompressor adds its own makeup
// gain even at ratio 1, so "neutral parameters" would still change the sound. With every
// feature off the graph is source -> destination. Rewiring only happens on user toggles.
//
//   source -> [mono] -> [highpass -> presence] -> [leveller -> makeup -> limiter -> trim] -> out
//
// The settings are in 02-tuning.js (VOICE_FILTERS, LEVELLER, LIMITER, LEVEL_*). The voice
// stage lowers 50 Hz hum by about 10 dB.
// ===================================================================================

const AUDIO_FEATURES = ['level', 'voice', 'mono'];

class AudioChain {
  constructor(video) {
    this.video = video;
    this.ctx = null;
    this.settings = { level: false, voice: false, mono: false };
    this.timer = 0;
    this.makeupDb = 0;
    this.avgPow = 0;
    this.buf = null;
    this.reason = AudioChain.unsupportedReason();
  }

  // Web Audio is only used with hls.js (MSE). With native HLS a cross-origin source could
  // make the graph output silence, so the features stay off there.
  static unsupportedReason() {
    if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return 'noWebAudio';
    if (!(HlsLib && HlsLib.isSupported())) return 'nativeHls';
    return null;
  }

  get built() { return !!this.ctx; }

  anyOn() { return AUDIO_FEATURES.some((k) => this.settings[k]); }

  build() {
    if (this.ctx || this.reason) return !!this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // Lecture playback does not need interactive latency. Android's default interactive
    // route can use game/speaker processing that changes the sound even with all stages
    // bypassed; prefer the media playback route and its power-efficient buffering.
    const ctx = new Ctx({ latencyHint: 'playback' });
    const n = {};
    n.src = ctx.createMediaElementSource(this.video);
    n.mono = ctx.createGain();
    n.mono.channelCount = 1;
    n.mono.channelCountMode = 'explicit';
    n.mono.channelInterpretation = 'speakers';
    n.highpass = ctx.createBiquadFilter();
    n.highpass.type = 'highpass';
    n.highpass.frequency.value = VOICE_FILTERS.highpassHz;
    n.highpass.Q.value = VOICE_FILTERS.highpassQ;
    n.presence = ctx.createBiquadFilter();
    n.presence.type = 'peaking';
    n.presence.frequency.value = VOICE_FILTERS.presenceHz;
    n.presence.Q.value = VOICE_FILTERS.presenceQ;
    n.presence.gain.value = VOICE_FILTERS.presenceDb;
    n.leveller = ctx.createDynamicsCompressor();
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n.leveller[k].value = LEVELLER[k];
    n.makeup = ctx.createGain();
    n.limiter = ctx.createDynamicsCompressor();
    n.limiter.threshold.value = LIMIT_THRESHOLD_DB;
    for (const k of ['knee', 'ratio', 'attack', 'release']) n.limiter[k].value = LIMITER[k];
    n.trim = ctx.createGain();
    n.trim.gain.value = Math.pow(10, LIMIT_TRIM_DB / 20);
    n.analyser = ctx.createAnalyser();
    n.analyser.fftSize = 2048;
    // The level stage is internally always wired; only its entry and exit move.
    n.leveller.connect(n.makeup).connect(n.limiter).connect(n.trim);
    n.leveller.connect(n.analyser);
    n.highpass.connect(n.presence);
    this.ctx = ctx;
    this.n = n;
    this.buf = new Float32Array(n.analyser.fftSize);
    this.apply();
    return true;
  }

  // Call from a user event handler.
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  set(settings) {
    Object.assign(this.settings, settings);
    if (this.ctx) this.apply();
  }

  apply() {
    const s = this.settings;
    const n = this.n;
    for (const node of [n.src, n.mono, n.presence, n.trim]) node.disconnect();
    // Entry/exit pairs of the enabled stages, chained in order.
    const stages = [];
    if (s.mono) stages.push([n.mono, n.mono]);
    if (s.voice) stages.push([n.highpass, n.presence]);
    if (s.level) stages.push([n.leveller, n.trim]);
    /** @type {AudioNode} */
    let tail = n.src;
    for (const [entry, exit] of stages) { tail.connect(entry); tail = exit; }
    tail.connect(this.ctx.destination);
    if (!s.level) { this.makeupDb = 0; this.avgPow = 0; }
    n.makeup.gain.value = Math.pow(10, this.makeupDb / 20);
    this.syncTimer();
  }

  // The makeup-gain loop runs only while levelling is on and the video is playing.
  syncTimer() {
    const want = this.ctx && this.settings.level && !this.video.paused;
    if (want && !this.timer) this.timer = setInterval(guard(() => this.levelTick()), LEVEL_TICK_MS);
    else if (!want && this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  // Measures the level after compression (before the makeup gain), keeps a ~3 s running
  // average of speech power, and moves the makeup gain a little towards the target.
  levelTick() {
    const b = this.buf;
    this.n.analyser.getFloatTimeDomainData(b);
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
    const pow = sum / b.length;
    if (pow < LEVEL_SILENT_POW) return; // silence: leave the gain alone
    this.avgPow = this.avgPow ? this.avgPow * LEVEL_SMOOTHING + pow * (1 - LEVEL_SMOOTHING) : pow;
    const levelDb = 10 * Math.log10(this.avgPow);
    const wanted = clamp(LEVEL_TARGET_DB - levelDb, 0, LEVEL_MAX_GAIN_DB);
    this.makeupDb += clamp(wanted - this.makeupDb, LEVEL_STEP_DB[0], LEVEL_STEP_DB[1]);
    this.n.makeup.gain.setTargetAtTime(Math.pow(10, this.makeupDb / 20), this.ctx.currentTime, 0.3);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    if (this.ctx) this.ctx.close().catch(() => {});
  }
}
