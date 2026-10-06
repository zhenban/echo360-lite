// ===================================================================================
// The player
//
// Streams: the "clock" <video> plays an audio+video rendition and drives everything
// (reporting, time display, seeking). In dual layouts a muted "follower" <video> plays the
// other view's video-only rendition and is kept in step by FollowerSync, so audio is never
// downloaded twice.
//
// Layout: which source is shown big ("primary") is independent of which one is the clock.
// Swapping views in the side-by-side and picture-in-picture layouts only moves the two
// elements (CSS); in the single layout the clock is reloaded with the shown source.
// ===================================================================================

const LAYOUTS = ['side', 'pip', 'single'];
const CORNERS = ['br', 'bl', 'tr', 'tl'];

// Keyboard shortcuts, as listed in the help panel (`?`): [keys, string key].
const KEY_HELP = [
  [['Space', 'K'], 'keyPlay'], [['←', '→'], 'keySeek5'], [['J', 'L'], 'keySeek10'], [['↑', '↓'], 'keyVolume'],
  [['M'], 'keyMute'], [['F'], 'keyFullscreen'], [['S'], 'keySwap'], [['[', ']'], 'keySpeed'],
  [['C'], 'keyCaptions'], [['T'], 'keyTranscript'], [['B'], 'keyBookmark'], [['G'], 'keyTag'], [['U'], 'keyFlag'],
  [['Shift+←', 'Shift+→'], 'keySlide'], [['P'], 'keyCopyFrame'], [['A'], 'keyCopyCaptions'],
  [['W'], 'keyPopout'], [['E'], 'keyExport'], [['+', '-'], 'keyZoom'], [['0'], 'keyZoomReset'], [['I', 'O'], 'keyLoop'], [['X'], 'keyLoopClear'],
  [['?'], 'keyHelp'], [['Esc'], 'keyEscape'],
];

class LitePlayer {
  constructor(lesson, opts) {
    this.lesson = lesson;
    this.opts = opts;
    this.d = new Disposer();
    this.prefs = Object.assign(
      {
        primary: null, layout: 'side', ratio: 0.5, pipw: 0.26, corner: 'br', rate: 1, volume: 1, muted: false,
        captions: false, capSize: 'm', capHidePaused: true, panel: false, tab: 'transcript', panelw: 360,
        audio: { level: false, voice: false, mono: false },
        silence: { auto: false, min: 30, sens: 'normal' },
        copySpan: 60,
        pdfMain: false, pdfFirst: false,
        quality: { screen: 'auto', camera: 'auto' },
      },
      store.get('prefs', {}),
    );
    if (!LAYOUTS.includes(this.prefs.layout)) this.prefs.layout = 'side';
    if (!CORNERS.includes(this.prefs.corner)) this.prefs.corner = 'br';
    if (!(this.prefs.capSize in CAPTION_SIZES)) this.prefs.capSize = 'm';
    const sp = Object.assign({ auto: false, min: 30, sens: 'normal' }, this.prefs.silence);
    if (!SILENCE_MIN_CHOICES.includes(sp.min)) sp.min = 30;
    if (!(sp.sens in SILENCE_SENSITIVITY)) sp.sens = 'normal';
    this.prefs.silence = sp;
    const qp = Object.assign({ screen: 'auto', camera: 'auto' }, this.prefs.quality);
    for (const k of ['screen', 'camera']) if (qp[k] !== 'auto' && !(qp[k] > 0)) qp[k] = 'auto';
    this.prefs.quality = qp;
    this.levelsByRole = {};
    this.played = new PlayedRanges();
    this.lastSecond = -1;
    this.lastP = -1;
    this.lastB = -1;
    this.dragging = false;
    this.destroyed = false;
    this.sync = null;
    this.followerFailed = false;
    this.frame = new FrameTask(() => this.render());
    this.d.add(() => this.frame.cancel());

    this.sources = lesson.sources;
    this.dual = this.sources.length >= 2;
    const savedPrimary = this.sources.findIndex((s) => s.index === this.prefs.primary);
    this.primaryPos = savedPrimary >= 0 ? savedPrimary : 0;
    this.clockPos = this.sources[this.primaryPos].av ? this.primaryPos : this.sources.findIndex((s) => s.av);

    this.buildDom();
    this.session = new SessionKeeper({
      url: location.href, renewMs: lesson.sessionRenewMs, disposer: this.d,
      onState: (st) => { if (!this.destroyed) this.$('.sessionhint').hidden = st !== 'renewing'; },
    });
    this.clock = new Stream(this.video, (f) => this.onClockFatal(f));
    this.follower = new Stream(this.fvideo, (f) => (f.auth ? this.recoverAccess(this.follower, () => this.onFollowerFatal()) : this.onFollowerFatal()));
    this.followerPos = -1;
    for (const st of [this.clock, this.follower]) {
      st.onLevel = () => { if (!this.destroyed) this.onLevelChange(); };
      // Refused but still retrying: renew in the background (once at a time).
      st.onAuth = () => {
        if (this.destroyed) return;
        if (!this.session.failed) { this.session.renew(true).catch(() => {}); return; }
        // Renewal has already given up: say so now rather than after hls.js's retries.
        if (st === this.clock) this.showAuthError(); else this.onFollowerFatal();
      };
    }
    this.d.add(() => { this.dropFollower(); this.clock.destroy(); });
    this.bindVideo();
    this.bindControls();
    this.bindLayoutControls();
    this.bindKeys();
    this.watched = new WatchedStore(lesson, this.video, this.played);
    this.watched.load().then(() => { if (!this.destroyed) this.renderWatched(); }).catch(() => {});
    this.d.listen(window, 'pagehide', () => this.watched.save(this.duration()));
    this.reporter = lesson.analytics ? new Reporter(lesson.analytics, this.video, this.played, this.d.child()) : null;
    if (this.reporter) this.reporter.stateFn = () => ({ captions: this.cc.on, transcript: this.sidebar.visible('transcript') });
    this.setupSilence();
    this.setupSlides();
    this.setupDeck();
    this.loadCues();
    this.loadInteractions();
    this.setupAudio();

    const start = this.pickStart();
    this.startAt = start;
    this.loadClock(this.clockPos, start, false);
    this.applyLayout();
    if (start > 1) this.toast(t('resumedAt', { time: fmtTime(start) }), t('startOver'), () => this.seek(0));
  }

  $(sel) { return this.root.querySelector(sel); }

  get secondaryPos() {
    return this.dual ? (this.primaryPos + 1) % this.sources.length : -1;
  }

  get layout() {
    if (this.pdfMode) return this.prefs.layout;
    return this.dual && !this.followerFailed ? this.prefs.layout : 'single';
  }

  // The lecturer's PDF shown in the picture area, next to one video (see SlideReader).
  get pdfMode() {
    return !!(this.prefs.pdfMain && this.deck && this.deck.pages.length);
  }

  buildDom() {
    const host = document.createElement('div');
    host.id = 'echo360-lite';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + CSS + '</style>' + playerTemplate();
    this.host = host;
    this.root = root;
    this.stage = this.$('.stage');
    this.video = this.$('video.clock');
    this.fvideo = this.$('video.follower');
    this.seekEl = this.$('.seek');
    this.app = this.$('.app');
    this.timeCur = this.$('.cur');
    this.timeDur = this.$('.dur');
    this.$('.title').textContent = this.lesson.title;
    document.title = this.lesson.title;
    const back = this.$('.back');
    if (this.lesson.backUrl) back.href = this.lesson.backUrl; else back.style.display = 'none';
    if (!this.dual) { this.$('.swap').style.display = 'none'; this.$('.layout').style.display = 'none'; }
    this.stage.style.setProperty('--ratio', String(clamp(this.prefs.ratio, 0.2, 0.8)));
    this.stage.style.setProperty('--pipw', String(clamp(this.prefs.pipw, 0.15, 0.6)));
    this.app.style.setProperty('--panelw', clamp(this.prefs.panelw, 260, 640) + 'px');
    this.cc = new CaptionsView(this.$('.captions'), this.video);
    this.d.add(() => this.cc.dispose());
    this.cc.setSize(this.prefs.capSize);
    this.sidebar = new Sidebar(this, this.$('.panel'));
    this.transcript = new TranscriptPanel(this, this.$('.pane[data-pane=transcript]'), this.$('.marks'));
    this.markers = new MarkersLayer(this.$('.imarks'));
    this.notes = null;
    this.discussion = null;
    this.d.add(() => { this.sidebar.dispose(); this.transcript.dispose(); if (this.notes) this.notes.dispose(); if (this.discussion) this.discussion.dispose(); });
    this.renderExtras();
    const menu = this.$('.speedmenu');
    for (const s of SPEEDS) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitemradio');
      b.dataset.rate = String(s);
      b.textContent = s + 'x';
      menu.appendChild(b);
    }
    (document.body || document.documentElement).appendChild(host);
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    this.d.add(() => {
      if (document.fullscreenElement === host) document.exitFullscreen().catch(() => {});
      host.remove();
      document.documentElement.style.overflow = prevOverflow;
    });
  }

  // A link to a moment (#t=<seconds>, as in exported notes) wins over the resume position.
  linkTime() {
    const m = /(?:^#|&)t=(\d+(?:\.\d+)?)/.exec(location.hash);
    return m ? +m[1] : null;
  }

  pickStart() {
    const link = this.linkTime();
    if (link != null) return link;
    const dur = this.lesson.duration;
    let t0 = this.lesson.resumeAt;
    if (t0 == null) {
      const local = store.get('pos:' + this.lesson.id, null);
      t0 = local && typeof local.t === 'number' ? local.t : 0;
    }
    if (!(t0 > 0) || (isFinite(dur) && t0 > dur - 10)) t0 = 0;
    return t0;
  }

  // ---- streams and layout ----

  loadClock(pos, startAt, autoplay) {
    const v = this.video;
    const source = this.sources[pos];
    this.played.absorb(v.played);
    this.clockPos = pos;
    if (source.poster && startAt < 1) v.poster = source.poster; else v.removeAttribute('poster');
    v.defaultPlaybackRate = this.prefs.rate;
    v.volume = clamp(this.prefs.volume, 0, 1);
    v.muted = !!this.prefs.muted;
    this.renderVolume();
    this.clock.quality = this.qualityFor(pos);
    this.clock.priority = this.roleOf(pos) === 'camera' ? 'low' : 'high';
    this.clock.load(source.av, startAt, () => {
      v.playbackRate = this.prefs.rate;
      if (autoplay) v.play().catch(() => {});
    });
  }

  ensureFollower() {
    const pos = this.sources.findIndex((s, i) => i !== this.clockPos);
    if (pos < 0) return;
    const source = this.sources[pos];
    const uri = source.v || source.av;
    if (this.follower.uri !== uri) {
      if (source.poster) this.fvideo.poster = source.poster;
      // Before the clock has loaded its currentTime is still 0; start at the resume point.
      const at = this.video.readyState > 0 ? this.video.currentTime : this.startAt;
      this.followerPos = pos;
      this.follower.quality = this.qualityFor(pos);
      this.follower.priority = this.roleOf(pos) === 'camera' ? 'low' : 'high';
      this.follower.load(uri, at, null);
    }
    if (!this.sync) this.sync = new FollowerSync(this.video, this.fvideo);
  }

  dropFollower() {
    if (this.sync) { this.sync.dispose(); this.sync = null; }
    if (this.follower.uri) this.follower.destroy();
    this.followerPos = -1;
  }

  applyLayout() {
    // A new arrangement starts with whole pictures.
    if (this.zoom) this.zoom.resetAll();
    const layout = this.layout;
    const st = this.stage;
    const pdf = this.pdfMode;
    for (const l of LAYOUTS) st.classList.toggle('l-' + l, l === layout);
    for (const c of CORNERS) st.classList.toggle('c-' + c, c === this.prefs.corner);
    // One video plays when it is shown alone or next to the PDF.
    if (layout === 'single' || pdf) {
      this.dropFollower();
      if (this.clockPos !== this.primaryPos && this.sources[this.primaryPos].av) {
        const v = this.video;
        this.loadClock(this.primaryPos, v.currentTime, !v.paused);
      }
    } else {
      this.ensureFollower();
    }
    const pdfView = this.$('.pdfview');
    if (pdf) {
      const pdfFirst = !!this.prefs.pdfFirst;
      this.video.dataset.slot = pdfFirst ? 'secondary' : 'primary';
      this.fvideo.dataset.slot = 'off';
      pdfView.dataset.slot = pdfFirst ? 'primary' : 'secondary';
    } else {
      const clockIsPrimary = this.clockPos === this.primaryPos || layout === 'single';
      this.video.dataset.slot = clockIsPrimary ? 'primary' : 'secondary';
      this.fvideo.dataset.slot = clockIsPrimary ? 'secondary' : 'primary';
      pdfView.dataset.slot = 'off';
    }
    this.$('.layout').style.display = this.dual || pdf ? '' : 'none';
    this.setButton('.layout', layout === 'side' ? 'layoutSide' : layout === 'pip' ? 'layoutPip' : 'layoutSingle', t('layout'));
    for (const b of this.root.querySelectorAll('.layoutmenu button')) b.setAttribute('aria-checked', String(b.dataset.layout === layout));
    if (this.reader) {
      this.reader.setActive('main', pdf);
      if (pdf) this.redrawPdf();
    }
    this.applyQuality();
  }

  // ---- the PDF in the picture area ----

  setPdfMain(on) {
    this.prefs.pdfMain = !!on;
    // Shown alone the PDF would hide the video (or the other way round): put them side by side.
    if (on && this.prefs.layout === 'single') this.prefs.layout = 'side';
    this.savePrefs();
    this.applyLayout();
    if (this.reader) this.reader.info();
  }

  swapPdf() {
    this.prefs.pdfFirst = !this.prefs.pdfFirst;
    this.savePrefs();
    this.applyLayout();
  }

  // Re-renders the main PDF view at its new size (after a layout or window change).
  redrawPdf() {
    if (!this.reader || !this.pdfMode) return;
    requestAnimationFrame(() => {
      const tg = this.reader.targets.get('main');
      if (tg && tg.active && this.reader.view >= 0) this.reader.drawInto(tg, this.reader.view);
    });
  }

  renderPdfBar() {
    const rd = this.reader;
    const deck = rd && rd.deck;
    if (!deck || rd.view < 0) return;
    this.$('.plabel').textContent = rd.label();
    this.$('.pprev').disabled = rd.view <= 0;
    this.$('.pnext').disabled = rd.view >= deck.pages.length - 1;
    const box = this.$('.pfollow');
    box.textContent = '';
    box.append(rd.followElement(true));
  }

  // ---- copying (picture, transcript) ----

  renderCopyMenu() {
    const span = this.prefs.copySpan || 60;
    for (const b of this.root.querySelectorAll('.copymenu [data-span]')) b.setAttribute('aria-checked', String(+b.dataset.span === span));
  }

  // The element showing the screen view if it is playing, else the main view.
  screenVideo() {
    const pos = this.slides && this.slides.screenIndex != null ? this.sources.findIndex((s) => s.index === this.slides.screenIndex) : -1;
    if (pos >= 0 && pos === this.clockPos) return this.video;
    if (pos >= 0 && pos === this.followerPos) return this.fvideo;
    return this.layout === 'single' || this.clockPos === this.primaryPos ? this.video : this.fvideo;
  }

  // Copies the current picture at the video's own resolution. Must run from a user action.
  copyFrame() {
    const v = this.screenVideo();
    if (!v.videoWidth) { this.toast(t('copyFailed', { msg: 'no picture yet' })); return; }
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    // The clipboard item is created synchronously (within the user action) from a promise.
    const blob = new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      .then(() => this.toast(t('copiedFrame', { w: c.width, h: c.height })))
      .catch((e) => this.toast(t('copyFailed', { msg: (e && e.message) || e })));
  }

  // Copies what was said in the last copySpan seconds, in whole sentences, with the
  // lecture's name and the time range.
  copyCaptions() {
    if (!this.cues || !this.cues.length) { this.toast(t('copyNoCaptions')); return; }
    const x = captionExcerpt(this.cues, this.video.currentTime, this.prefs.copySpan || 60);
    if (!x) { this.toast(t('copyNoCaptions')); return; }
    const long = this.duration() >= 3600;
    const from = fmtTime(x.start, long);
    const to = fmtTime(x.end, long);
    const text = this.lesson.title + '\n' + from + '–' + to + '\n\n' + x.text + '\n';
    navigator.clipboard.writeText(text)
      .then(() => this.toast(t('copiedCaptions', { from, to })))
      .catch((e) => this.toast(t('copyFailed', { msg: (e && e.message) || e })));
  }

  // ---- quality ----

  // 'screen' or 'camera'. Until the screen view is known, the first view counts as screen.
  roleOf(pos) {
    const src = this.sources[pos];
    if (!src) return 'screen';
    const screen = this.slides ? this.slides.screenIndex : null;
    if (screen != null) return src.index === screen ? 'screen' : 'camera';
    return pos === 0 ? 'screen' : 'camera';
  }

  qualityFor(pos) {
    return this.prefs.quality[this.roleOf(pos)] || 'auto';
  }

  // Applies the quality settings to both streams. The camera may use a smaller rendition
  // only while it is the small picture-in-picture window; the screen is never capped.
  applyQuality() {
    const pairs = [[this.clock, this.video, this.clockPos], [this.follower, this.fvideo, this.followerPos]];
    for (const [stream, el, pos] of pairs) {
      if (pos < 0 || !stream.uri) continue;
      let cap = 0;
      if (this.layout === 'pip' && el.dataset.slot === 'secondary' && this.roleOf(pos) === 'camera') {
        cap = Math.ceil(el.clientHeight * (window.devicePixelRatio || 1));
      }
      stream.setCap(cap);
      stream.setQuality(this.qualityFor(pos));
    }
    this.onLevelChange();
  }

  onLevelChange() {
    for (const [stream, pos] of [[this.clock, this.clockPos], [this.follower, this.followerPos]]) {
      if (pos >= 0 && stream.levels.length) this.levelsByRole[this.roleOf(pos)] = stream.levels.map((l) => l.height);
    }
    const shown = this.layout === 'single' || this.clockPos === this.primaryPos ? this.clock : this.follower;
    const h = shown.height;
    this.$('.qbtn').textContent = h ? h + 'p' : t('qualityAuto');
    if (!this.$('.qualitymenu').hidden) this.renderQualityMenu();
  }

  renderQualityMenu() {
    const menu = this.$('.qualitymenu');
    menu.textContent = '';
    menu.append(h('div.head', { text: t('quality') }));
    const roles = this.dual ? ['screen', 'camera'] : [this.roleOf(0)];
    for (const role of roles) {
      const pos = this.sources.findIndex((s, i) => this.roleOf(i) === role);
      if (pos < 0) continue;
      const stream = pos === this.clockPos ? this.clock : pos === this.followerPos ? this.follower : null;
      const playing = stream && stream.height ? stream.height + 'p' : '';
      if (this.dual) menu.append(h('div.sub', { text: t(role === 'screen' ? 'qualityScreen' : 'qualityCamera') + (playing ? ' \u00b7 ' + t('qualityNow', { q: playing }) : '') }));
      else if (playing) menu.append(h('div.sub', { text: t('qualityNow', { q: playing }) }));
      const want = this.prefs.quality[role];
      const heights = (this.levelsByRole[role] || []).slice().sort((a, b) => b - a);
      const opts = [['auto', t('qualityAutoBest')]].concat(heights.map((x) => [x, x + 'p']));
      for (const [val, label] of opts) {
        menu.append(h('button', { role: 'menuitemradio', 'aria-checked': String(want === val), 'data-role': role, 'data-q': String(val), text: label }));
      }
    }
  }

  setQuality(role, val) {
    this.prefs.quality[role] = val === 'auto' ? 'auto' : +val;
    this.savePrefs();
    this.applyQuality();
    this.renderQualityMenu();
  }

  setLayout(layout) {
    if (!(this.dual || this.pdfMode) || !LAYOUTS.includes(layout)) return;
    this.followerFailed = false;
    this.prefs.layout = layout;
    this.savePrefs();
    this.applyLayout();
  }

  // Swaps the screen and camera views. With the PDF in the picture area, this changes which
  // video is shown next to it (or, with one video, swaps the PDF and the video).
  swapViews() {
    if (!this.dual) { if (this.pdfMode) this.swapPdf(); return; }
    const next = this.secondaryPos;
    // A source without an audio+video rendition can only be shown as the follower.
    if ((this.layout === 'single' || this.pdfMode) && !this.sources[next].av) return;
    this.primaryPos = next;
    this.prefs.primary = this.sources[next].index;
    this.savePrefs();
    this.applyLayout();
  }

  onClockFatal(f) {
    if (this.destroyed) return;
    if (f.auth) {
      this.recoverAccess(this.clock, () => this.showAuthError());
      return;
    }
    this.showError(t('playbackFailedTitle'), t('playbackFailedText', { detail: f.details }),
      [[t('retry'), () => { this.hideError(); this.loadClock(this.clockPos, this.video.currentTime, true); }, true],
        [t('useOriginal'), () => this.opts.onFallback('error')]]);
  }

  // The video files were refused: renew the access in the background and carry on from
  // the current position with the same element. A second refusal right after a renewal,
  // or a renewal that fails, ends in `fail`.
  recoverAccess(stream, fail) {
    const now = Date.now();
    if (stream.renewedAt && now - stream.renewedAt < 30000) { fail(); return; }
    this.session.renew(true).then(() => {
      if (this.destroyed) return;
      stream.renewedAt = Date.now();
      stream.resume(stream.video.currentTime);
    }, () => { if (!this.destroyed) fail(); });
  }

  showAuthError() {
    const login = this.session.failed && this.session.failed.login;
    this.showError(t('authExpiredTitle'), t(login ? 'authLoginExpiredText' : 'authExpiredText'),
      [[t('reload'), () => { this.savePosition(); location.reload(); }, true], [t('useOriginal'), () => this.opts.onFallback('auth')]]);
  }

  onFollowerFatal() {
    if (this.destroyed || this.followerFailed) return;
    // Keep watching with the clock alone; the layout preference is kept for next time.
    this.followerFailed = true;
    this.applyLayout();
    this.toast(t('secondViewLost'), t('retry'), () => this.setLayout(this.prefs.layout));
  }

  // ---- video events ----

  bindVideo() {
    const v = this.video;
    const stage = this.stage;
    const d = this.d;
    const on = (type, fn) => d.listen(v, type, fn);
    on('play', () => {
      // Back after a long pause (or a sleeping laptop): renew the access before it runs out.
      this.session.wake();
      // Play is normally user-initiated; also recovers a context the browser suspended.
      if (this.audio) { this.audio.resume(); this.audio.syncTimer(); }
      stage.classList.remove('paused');
      this.setButton('.play', 'pause', t('pause'));
      if (this.reporter) this.reporter.onPlay();
      this.armIdle();
    });
    on('pause', () => {
      if (this.audio) this.audio.syncTimer();
      stage.classList.add('paused');
      this.setButton('.play', 'play', t('play'));
      if (this.reporter) this.reporter.onPause();
      this.savePosition();
      this.wake();
    });
    on('waiting', () => stage.classList.add('waiting'));
    on('seeking', () => stage.classList.add('waiting'));
    const clearWaiting = () => stage.classList.remove('waiting');
    on('playing', clearWaiting);
    on('seeked', clearWaiting);
    on('canplay', clearWaiting);
    const invalidate = () => this.frame.request();
    const onTime = () => {
      const ct = v.currentTime;
      if (this.loop) this.loop.tick(ct);
      this.cc.update(ct);
      this.transcript.update(ct);
      const scene = Math.floor(ct / FLAG_SCENE_SECONDS);
      if (scene !== this.flagScene) { this.flagScene = scene; this.renderFlagButton(); }
      this.silenceTick(ct);
      if (this.slidesPane) this.slidesPane.update(ct);
      if (this.reader) this.reader.update(ct);
    };
    on('timeupdate', () => { invalidate(); onTime(); });
    on('seeked', onTime);
    on('progress', invalidate);
    on('durationchange', () => { this.render(true); if (this.loop) this.loop.render(); this.renderWatched(); this.updateMarkers(); this.renderSilences(); this.renderChapterMarks(); });
    on('ratechange', () => {
      this.$('.speed').textContent = v.playbackRate + 'x';
      for (const b of this.root.querySelectorAll('.speedmenu button')) b.setAttribute('aria-checked', String(+b.dataset.rate === v.playbackRate));
    });
    on('volumechange', () => {
      this.renderVolume();
      this.prefs.volume = v.volume;
      this.prefs.muted = v.muted;
      this.savePrefs();
    });
    on('ended', () => this.savePosition(0));
    d.listen(document, 'visibilitychange', () => { if (!document.hidden) this.render(true); });
    d.listen(window, 'hashchange', () => { const tm = this.linkTime(); if (tm != null) this.seek(tm); });

    // Every 2 s: stall watchdog (playing, not seeking, time has not moved for 12 s) and,
    // every fifth tick, the local resume position as a fallback for the server-side one.
    let lastT = -1;
    let still = 0;
    let tick = 0;
    d.interval(() => {
      if (v.paused || v.seeking || v.ended) { still = 0; lastT = v.currentTime; return; }
      if (v.currentTime === lastT) {
        still += 2;
        if (still >= 12) {
          console.warn(TAG, 'playback stalled, restarting loader at', v.currentTime.toFixed(1));
          this.clock.kick(v.currentTime);
          still = 0;
        }
      } else { still = 0; lastT = v.currentTime; }
      if (++tick % 5 === 0) { this.savePosition(); this.watched.save(this.duration()); this.renderWatched(); }
    }, 2000);
  }

  setButton(sel, icon, label) {
    const b = this.$(sel);
    b.innerHTML = svg(icon);
    b.title = label;
    b.setAttribute('aria-label', label);
  }

  renderVolume() {
    const v = this.video;
    const level = v.muted ? 0 : v.volume;
    this.$('.mute').innerHTML = svg(v.muted || v.volume === 0 ? 'muted' : 'volume');
    const input = this.$('.volume');
    input.value = String(level);
    input.style.setProperty('--v', level * 100 + '%');
  }

  savePrefs() {
    clearTimeout(this.prefsTimer);
    this.prefsTimer = setTimeout(() => store.set('prefs', this.prefs), 300);
  }

  savePosition(pos) {
    store.set('pos:' + this.lesson.id, { t: pos === undefined ? this.video.currentTime : pos, at: Date.now() });
  }

  duration() {
    const dur = this.video.duration;
    return isFinite(dur) && dur > 0 ? dur : (isFinite(this.lesson.duration) ? this.lesson.duration : 0);
  }

  // Time label, progress and buffer bars. Runs at most once per frame and only while the
  // controls are visible; wake() forces a refresh when they reappear.
  render(force) {
    if (this.destroyed) return;
    if (!force && this.stage.classList.contains('idle')) return;
    const v = this.video;
    const dur = this.duration();
    const ct = v.currentTime;
    const sec = Math.floor(ct);
    if (force || sec !== this.lastSecond) {
      this.lastSecond = sec;
      const long = dur >= 3600;
      this.timeCur.textContent = fmtTime(ct, long);
      this.timeDur.textContent = fmtTime(dur, long);
      this.seekEl.setAttribute('aria-valuetext', fmtTime(ct, long));
    }
    if (!dur) return;
    if (!this.dragging) {
      const p = ct / dur;
      if (force || Math.abs(p - this.lastP) > 0.0002) {
        this.lastP = p;
        this.seekEl.style.setProperty('--p', p.toFixed(5));
      }
    }
    const buf = v.buffered;
    let end = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf.start(i) <= ct + 0.5 && buf.end(i) > end) end = buf.end(i);
    }
    const b = end / dur;
    if (force || Math.abs(b - this.lastB) > 0.001) {
      this.lastB = b;
      this.seekEl.style.setProperty('--b', b.toFixed(4));
    }
  }

  seek(target) {
    const dur = this.duration();
    const to = clamp(target, 0, dur ? dur - 0.1 : target);
    this.video.currentTime = to;
    this.render(true);
    if (this.loop) this.loop.seeked(to);
  }

  togglePlay() {
    const v = this.video;
    if (v.paused || v.ended) v.play().catch(() => {}); else v.pause();
  }

  setRate(r) {
    r = clamp(Math.round(r * 100) / 100, 0.25, 4);
    this.video.playbackRate = r;
    this.video.defaultPlaybackRate = r;
    this.prefs.rate = r;
    this.savePrefs();
  }

  // ---- floating window (Document Picture-in-Picture) ----

  canPopout() { return typeof window.documentPictureInPicture === 'object' && !!window.documentPictureInPicture; }

  // Moves the whole player (both views, controls, captions, side panel) into a floating
  // window and back. Nothing is rebuilt: the same elements, streams and audio graph move.
  async togglePopout() {
    if (this.popout) { this.popout.close(); return; }
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    const r = this.host.getBoundingClientRect();
    let pip;
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: Math.round(Math.min(960, r.width * 0.6)), height: Math.round(Math.min(600, r.height * 0.6)) });
    } catch (e) {
      this.toast(t('popoutFailed', { msg: (e && e.message) || e }));
      return;
    }
    const playing = !this.video.paused;
    this.popout = pip;
    const holder = h('div.e3l-holder', { style: 'display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:' + Math.round(r.height) + 'px;background:#111;color:#ccc;font:14px system-ui,sans-serif' },
      h('span', { text: t('popoutHere') }),
      h('button', { text: t('popoutBack'), style: 'padding:6px 12px;border-radius:8px;border:0;cursor:pointer', onclick: () => pip.close() }));
    this.host.replaceWith(holder);
    const doc = pip.document;
    doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
    doc.title = this.lesson.title;
    const css = this.host.style.cssText;
    this.host.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
    doc.body.append(this.host);
    this.host.classList.add('in-popout');
    const keys = (e) => this.onKey(e);
    doc.addEventListener('keydown', keys, true);
    const resize = () => { this.applyQuality(); this.redrawPdf(); };
    pip.addEventListener('resize', resize);
    // Moving can pause the elements in some browsers: carry on as before.
    if (playing && this.video.paused) this.video.play().catch(() => {});
    this.$('.popbtn').setAttribute('aria-pressed', 'true');
    pip.addEventListener('pagehide', () => {
      const still = !this.video.paused;
      doc.removeEventListener('keydown', keys, true);
      this.host.classList.remove('in-popout');
      this.host.style.cssText = css;
      holder.replaceWith(this.host);
      this.popout = null;
      if (still && this.video.paused) this.video.play().catch(() => {});
      if (!this.destroyed) {
        this.$('.popbtn').setAttribute('aria-pressed', 'false');
        this.applyQuality();
        this.redrawPdf();
      }
    }, { once: true });
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this.host.requestFullscreen().catch(() => {});
  }

  // ---- idle (auto-hide) handling ----
  menusOpen() {
    return [...this.root.querySelectorAll('.menu')].some((m) => !m.hidden);
  }

  wake() {
    const wasIdle = this.stage.classList.contains('idle');
    this.stage.classList.remove('idle');
    if (wasIdle) this.render(true);
    this.armIdle();
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(guard(() => {
      if (!this.video.paused && !this.dragging && !this.menusOpen()) this.stage.classList.add('idle');
    }), 2500);
  }

  bindControls() {
    this.d.listen(this.$('.kbtn'), 'click', (e) => { e.stopPropagation(); this.showKeys(true); });
    this.d.listen(this.$('.khclose'), 'click', (e) => { e.stopPropagation(); this.showKeys(false); });
    this.d.listen(this.$('.keyhelp'), 'click', (e) => { if (e.target === this.$('.keyhelp')) this.showKeys(false); });
    const $ = (s) => this.$(s);
    const v = this.video;
    const d = this.d;
    d.add(() => { clearTimeout(this.idleTimer); clearTimeout(this.toastTimer); clearTimeout(this.sharpTimer); clearTimeout(this.prefsTimer); store.set('prefs', this.prefs); });
    d.listen($('.play'), 'click', () => this.togglePlay());
    d.listen($('.rew'), 'click', () => this.seek(v.currentTime - 10));
    d.listen($('.fwd'), 'click', () => this.seek(v.currentTime + 10));
    d.listen($('.mute'), 'click', () => {
      if (v.muted || v.volume === 0) { v.muted = false; if (v.volume === 0) v.volume = 0.5; } else v.muted = true;
    });
    d.listen($('.volume'), 'input', (e) => { v.volume = +e.target.value; v.muted = v.volume === 0; });
    d.listen($('.fs'), 'click', () => this.toggleFullscreen());
    $('.popbtn').hidden = !this.canPopout();
    d.listen($('.popbtn'), 'click', () => this.togglePopout());
    d.add(() => { if (this.popout) this.popout.close(); });
    d.listen($('.swap'), 'click', () => this.swapViews());
    d.listen($('.orig'), 'click', () => this.opts.onFallback('user'));
    d.listen(document, 'fullscreenchange', () => {
      this.setButton('.fs', document.fullscreenElement ? 'exitFullscreen' : 'fullscreen', t('fullscreen'));
    });

    // Menus (speed, layout): one open at a time, closed by any click elsewhere.
    const menus = [[$('.speed'), $('.speedmenu')], [$('.layout'), $('.layoutmenu')], [$('.ccbtn'), $('.ccmenu')], [$('.audiobtn'), $('.audiomenu')], [$('.qbtn'), $('.qualitymenu')], [$('.copybtn'), $('.copymenu')]];
    for (const [btn, menu] of menus) {
      d.listen(btn, 'click', (e) => {
        e.stopPropagation();
        const open = menu.hidden;
        for (const [, m] of menus) m.hidden = true;
        if (open && menu.classList.contains('qualitymenu')) this.renderQualityMenu();
        if (open && menu.classList.contains('copymenu')) this.renderCopyMenu();
        menu.hidden = !open;
        this.wake();
      });
    }
    d.listen($('.copymenu'), 'click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button[data-copy], button[data-span]');
      if (!b) return;
      if (b.dataset.span) {
        this.prefs.copySpan = +b.dataset.span;
        this.savePrefs();
        this.renderCopyMenu();
        return;
      }
      $('.copymenu').hidden = true;
      if (b.dataset.copy === 'frame') this.copyFrame(); else this.copyCaptions();
    });
    d.listen($('.qualitymenu'), 'click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button[data-q]');
      if (b) this.setQuality(b.dataset.role, b.dataset.q);
    });
    let resizeTimer = 0;
    d.add(() => clearTimeout(resizeTimer));
    d.listen(window, 'resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(guard(() => { this.applyQuality(); this.redrawPdf(); }), 500); });
    d.listen($('.speedmenu'), 'click', (e) => {
      const b = e.target.closest('button[data-rate]');
      if (b) { this.setRate(+b.dataset.rate); $('.speedmenu').hidden = true; }
    });
    d.listen($('.layoutmenu'), 'click', (e) => {
      const b = e.target.closest('button[data-layout]');
      if (b) { this.setLayout(b.dataset.layout); $('.layoutmenu').hidden = true; }
    });
    d.listen($('.cctoggle'), 'click', () => this.setCaptions(!this.cc.on));
    d.listen($('.cchidepaused'), 'click', () => {
      this.prefs.capHidePaused = !this.prefs.capHidePaused;
      this.savePrefs();
      this.renderCaptionMenu();
    });
    d.listen($('.ccmenu .sizes'), 'click', (e) => {
      const b = e.target.closest('button[data-size]');
      if (b) this.setCaptionSize(b.dataset.size);
    });
    for (const chip of this.root.querySelectorAll('.top [data-open]')) d.listen(chip, 'click', () => this.sidebar.toggle(chip.dataset.open));
    d.listen($('.pclose'), 'click', () => this.sidebar.close());
    d.listen($('.bmbtn'), 'click', (e) => { if (this.notes) this.notes.addBookmark(e); });
    d.listen($('.flagbtn'), 'click', (e) => { if (this.notes) this.notes.toggleFlag(e); });
    d.listen($('.pextras button'), 'click', () => this.opts.onFallback('extras'));
    this.bindPanelResize();
    d.listen(this.root, 'click', (e) => {
      if (e.target.closest('.menu, .speed, .layout, .ccbtn, .audiobtn, .qbtn, .copybtn')) return;
      for (const [, m] of menus) m.hidden = true;
      if (this.loop) this.loop.menu.hidden = true;
    });
    this.loop = new ABLoop(this);

    // Click on a picture: play/pause; double click: fullscreen. While the controls are
    // hidden, the first click only brings them back (it may be aimed at a hidden button).
    let clickTimer = 0;
    let wokeByPress = false;
    d.add(() => clearTimeout(clickTimer));
    d.listen(this.stage, 'pointerdown', () => {
      wokeByPress = this.stage.classList.contains('idle');
      this.wake();
    }, true);
    const views = $('.views');
    this.zoom = new Zoomer(views, d, {
      // The PDF is drawn again at the zoom level once zooming pauses (in steps, so that
      // small changes do not render it again).
      onChange: () => {
        clearTimeout(this.sharpTimer);
        this.sharpTimer = setTimeout(guard(() => {
          const tg = this.reader && this.reader.targets.get('main');
          if (!tg || this.destroyed) return;
          const sharp = Math.min(4, Math.max(1, Math.round(this.zoom.get(tg.pages).s * 2) / 2));
          if (sharp !== (tg.sharp || 1)) { tg.sharp = sharp; this.redrawPdf(); }
        }), 250);
      },
      // Not the small picture-in-picture window.
      canZoom: (el) => !(this.layout === 'pip' && (el.closest('[data-slot]') || el).dataset.slot === 'secondary'),
    });
    d.listen(views, 'click', (e) => {
      if (e.target.tagName !== 'VIDEO') return;
      if (this.zoom.dragged) return;
      if (wokeByPress) { wokeByPress = false; return; }
      clearTimeout(clickTimer);
      clickTimer = setTimeout(guard(() => this.togglePlay()), 200);
    });
    d.listen(views, 'dblclick', (e) => {
      // Zoomed in: back to the whole picture; otherwise full screen.
      const z = this.zoom.targetOf(e.target);
      if (z && this.zoom.zoomed(z)) { clearTimeout(clickTimer); this.zoom.reset(z); return; }
      if (e.target.tagName !== 'VIDEO') return;
      clearTimeout(clickTimer);
      this.toggleFullscreen();
    });

    // Auto-hide
    d.listen(this.stage, 'pointermove', () => this.wake());
    d.listen(this.stage, 'pointerleave', () => { if (!v.paused) this.stage.classList.add('idle'); });

    // Seek bar
    const seekEl = this.seekEl;
    const tip = $('.tip');
    const tipText = tip.querySelector('.tt');
    const tipImg = tip.querySelector('.pv');
    let rect = null;
    let lastSeekAt = 0;
    const frac = (x) => clamp((x - rect.left) / rect.width, 0, 1);
    let nearMarker = null;
    let downX = 0;
    const hover = (e) => {
      if (!rect) rect = seekEl.getBoundingClientRect();
      const f = frac(e.clientX);
      const dur = this.duration();
      seekEl.style.setProperty('--h', f.toFixed(4));
      nearMarker = this.markers.nearest(f, rect.width, 6);
      const sil = nearMarker ? null : this.silence.silences[silenceIndexAt(this.silence.silences, f * dur)];
      tipText.textContent = nearMarker
        ? fmtTime(nearMarker.time, dur >= 3600) + ' \u00b7 ' + (nearMarker.label.length > 70 ? nearMarker.label.slice(0, 67) + '\u2026' : nearMarker.label)
        : fmtTime(f * dur, dur >= 3600) + (sil ? ' \u00b7 ' + t('silenceTip', { time: fmtTime(sil.end - sil.start) }) : '');
      const pv = this.previewAt(nearMarker ? nearMarker.time : f * dur);
      if (pv) { if (tipImg.getAttribute('src') !== pv) tipImg.src = pv; tipImg.hidden = false; } else tipImg.hidden = true;
      const half = pv ? 96 : 24;
      tip.style.left = clamp(f * rect.width, half, rect.width - half) + 'px';
      return f;
    };
    d.listen(seekEl, 'pointerenter', () => { rect = seekEl.getBoundingClientRect(); });
    d.listen(seekEl, 'pointermove', (e) => {
      const f = hover(e);
      if (this.dragging) {
        seekEl.style.setProperty('--p', f.toFixed(5));
        const now = performance.now();
        if (now - lastSeekAt > 200) { lastSeekAt = now; v.currentTime = f * this.duration(); }
      }
    });
    d.listen(seekEl, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      rect = seekEl.getBoundingClientRect();
      seekEl.setPointerCapture(e.pointerId);
      downX = e.clientX;
      this.dragging = true;
      seekEl.classList.add('dragging');
      seekEl.style.setProperty('--p', hover(e).toFixed(5));
    });
    const endDrag = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      seekEl.classList.remove('dragging');
      // A click (not a drag) next to a marker jumps exactly to the marked time.
      if (nearMarker && Math.abs(e.clientX - downX) < 4) this.seek(nearMarker.time);
      else this.seek(frac(e.clientX) * this.duration());
      this.armIdle();
    };
    d.listen(seekEl, 'pointerup', endDrag);
    d.listen(seekEl, 'pointercancel', endDrag);
    d.listen(seekEl, 'keydown', (e) => {
      if (e.key === 'Home') { this.seek(0); e.preventDefault(); }
      if (e.key === 'End') { this.seek(this.duration()); e.preventDefault(); }
    });
    d.listen(window, 'resize', () => { rect = null; });
  }

  // Divider (side by side) and the picture-in-picture window.
  bindLayoutControls() {
    const d = this.d;
    const st = this.stage;
    const divider = this.$('.divider');
    const frame = this.$('.pipframe');
    const grip = this.$('.grip');

    const setRatio = (r) => {
      this.prefs.ratio = clamp(r, 0.2, 0.8);
      st.style.setProperty('--ratio', this.prefs.ratio.toFixed(4));
    };
    let stageRect = null;
    d.listen(divider, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      stageRect = st.getBoundingClientRect();
      divider.setPointerCapture(e.pointerId);
      divider.classList.add('dragging');
      this.dragging = true;
    });
    d.listen(divider, 'pointermove', (e) => {
      if (!divider.classList.contains('dragging')) return;
      setRatio((e.clientX - stageRect.left) / stageRect.width);
    });
    const endDivider = () => {
      if (!divider.classList.contains('dragging')) return;
      divider.classList.remove('dragging');
      this.dragging = false;
      this.savePrefs();
      this.redrawPdf();
      this.armIdle();
    };
    d.listen(divider, 'pointerup', endDivider);
    d.listen(divider, 'pointercancel', endDivider);
    d.listen(divider, 'dblclick', () => { setRatio(0.5); this.savePrefs(); });
    d.listen(divider, 'keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        setRatio(this.prefs.ratio + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
        this.savePrefs();
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // PiP: drag to move (snaps to the nearest corner on release), click to swap views,
    // corner grip to resize. While dragging, both the frame and the video are translated.
    const pipEls = () => [frame, this.$('.views [data-slot=secondary]')].filter(Boolean);
    let drag = null;
    d.listen(frame, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      frame.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, moved: false, resize: e.target === grip, rect: frame.getBoundingClientRect(), stage: st.getBoundingClientRect() };
      this.dragging = true;
    });
    d.listen(frame, 'pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      frame.classList.add('dragging');
      if (drag.resize) {
        const c = this.prefs.corner;
        const r = drag.rect;
        const w = c === 'br' || c === 'tr' ? r.right - e.clientX : e.clientX - r.left;
        this.prefs.pipw = clamp(w / drag.stage.width, 0.15, 0.6);
        st.style.setProperty('--pipw', this.prefs.pipw.toFixed(4));
      } else {
        for (const el of pipEls()) el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      }
    });
    const endPip = (e) => {
      if (!drag) return;
      const was = drag;
      drag = null;
      this.dragging = false;
      frame.classList.remove('dragging');
      // A click swaps the two pictures (with the PDF shown: the PDF and the video).
      if (!was.moved) { if (this.pdfMode) this.swapPdf(); else this.swapViews(); return; }
      if (was.resize) this.redrawPdf();
      if (!was.resize) {
        const cx = was.rect.left + was.rect.width / 2 + (e.clientX - was.x);
        const cy = was.rect.top + was.rect.height / 2 + (e.clientY - was.y);
        const right = cx > was.stage.left + was.stage.width / 2;
        const bottom = cy > was.stage.top + was.stage.height / 2;
        this.prefs.corner = (bottom ? 'b' : 't') + (right ? 'r' : 'l');
        for (const el of pipEls()) el.style.transform = '';
        for (const c of CORNERS) st.classList.toggle('c-' + c, c === this.prefs.corner);
      }
      this.savePrefs();
      this.armIdle();
    };
    d.listen(frame, 'pointerup', endPip);
    d.listen(frame, 'pointercancel', endPip);
  }

  bindKeys() {
    this.onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || this.destroyed) return;
      const target = e.composedPath()[0];
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) && target.type !== 'range') return;
      const v = this.video;
      let handled = true;
      switch (e.key) {
        case ' ': case 'k': case 'K': this.togglePlay(); break;
        case 'ArrowLeft': if (e.shiftKey) handled = this.stepChapter(-1); else this.seek(v.currentTime - 5); break;
        case 'ArrowRight': if (e.shiftKey) handled = this.stepChapter(1); else this.seek(v.currentTime + 5); break;
        case 'j': case 'J': this.seek(v.currentTime - 10); break;
        case 'l': case 'L': this.seek(v.currentTime + 10); break;
        case 'ArrowUp': v.muted = false; v.volume = clamp(v.volume + 0.05, 0, 1); break;
        case 'ArrowDown': v.volume = clamp(v.volume - 0.05, 0, 1); break;
        case 'm': case 'M': v.muted = !v.muted; break;
        case 'f': case 'F': this.toggleFullscreen(); break;
        case 's': case 'S': this.swapViews(); break;
        case 'c': case 'C': if (this.cues && this.cues.length) this.setCaptions(!this.cc.on); else handled = false; break;
        case 't': case 'T': if (this.sidebar.has('transcript')) this.sidebar.toggle('transcript'); else handled = false; break;
        case 'b': case 'B': if (this.notes && this.notesReady) this.notes.addBookmark(e); else handled = false; break;
        case 'u': case 'U': if (this.notes && this.notesReady && this.notes.canFlag) this.notes.toggleFlag(e); else handled = false; break;
        case 'g': case 'G': if (this.notes && this.notesReady) this.notes.tagHere(e); else handled = false; break;
        case 'p': case 'P': this.copyFrame(); break;
        case 'a': case 'A': this.copyCaptions(); break;
        case 'Escape':
          if (!this.$('.keyhelp').hidden) this.showKeys(false);
          else if (this.menusOpen()) { for (const m of this.root.querySelectorAll('.menu')) m.hidden = true; } else handled = false;
          break;
        case '?': this.showKeys(this.$('.keyhelp').hidden); break;
        case '+': case '=': this.zoomMain(1.25); break;
        case '-': case '_': this.zoomMain(0.8); break;
        case '0': this.zoomMain(0); break;
        case 'i': case 'I': this.loop.setA(v.currentTime); break;
        case 'o': case 'O': this.loop.setB(v.currentTime); break;
        case 'x': case 'X': if (this.loop.a != null) this.loop.clear(); else handled = false; break;
        case 'w': case 'W': if (this.canPopout()) this.togglePopout(); else handled = false; break;
        case 'e': case 'E': if (this.notes && this.notesReady) this.notes.openExport(); else handled = false; break;
        case ']': this.setRate(nextSpeed(v.playbackRate, 1)); break;
        case '[': this.setRate(nextSpeed(v.playbackRate, -1)); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); this.wake(); }
    };
    this.d.listen(document, 'keydown', this.onKey, true);
  }

  // ---- captions and transcript ----

  loadCues() {
    this.cues = null;
    if (!this.opts.fetchCues) { this.silence.start([]); return; }
    this.opts.fetchCues(this.lesson).then((cues) => {
      if (this.destroyed) return;
      this.silence.start(cues);
      if (!cues.length) return;
      this.cues = cues;
      if (this.slidesPane) this.slidesPane.invalidate();
      if (this.reporter) this.reporter.captionsAvailable = cues.length;
      this.cc.setCues(cues);
      this.transcript.setCues(cues);
      this.$('.ccbtn').hidden = false;
      this.renderCaptionMenu();
      if (this.prefs.captions) this.setCaptions(true, true);
      this.registerTab('transcript', this.transcript);
    });
  }

  setCaptions(on, restoring) {
    this.cc.setOn(on);
    this.cc.update(this.video.currentTime);
    if (!restoring) { this.prefs.captions = on; this.savePrefs(); }
    this.$('.ccbtn').classList.toggle('active', on);
    this.renderCaptionMenu();
  }

  setCaptionSize(size) {
    if (!(size in CAPTION_SIZES)) return;
    this.prefs.capSize = size;
    this.cc.setSize(size);
    this.savePrefs();
    this.renderCaptionMenu();
  }

  renderCaptionMenu() {
    const on = this.cc.on;
    const toggle = this.$('.cctoggle');
    toggle.setAttribute('aria-checked', String(on));
    toggle.querySelector('.state').textContent = on ? t('on') : t('off');
    for (const b of this.root.querySelectorAll('.ccmenu .sizes button')) b.setAttribute('aria-checked', String(b.dataset.size === this.prefs.capSize));
    const hide = this.$('.cchidepaused');
    hide.setAttribute('aria-checked', String(!!this.prefs.capHidePaused));
    hide.querySelector('.state').textContent = this.prefs.capHidePaused ? t('on') : t('off');
    this.stage.classList.toggle('hidecc-paused', !!this.prefs.capHidePaused);
  }

  // ---- audio processing ----

  setupAudio() {
    const a = new AudioChain(this.video);
    this.audio = a;
    this.d.add(() => a.dispose());
    if (!this.prefs.audio || typeof this.prefs.audio !== 'object') this.prefs.audio = { level: false, voice: false, mono: false };
    a.settings = Object.assign({}, a.settings, this.prefs.audio);
    for (const b of this.root.querySelectorAll('.audiomenu [data-audio]')) {
      this.d.listen(b, 'click', (e) => {
        e.stopPropagation();
        if (a.reason) return;
        const k = b.dataset.audio;
        a.build();
        a.resume();
        a.set({ [k]: !a.settings[k] });
        this.prefs.audio = Object.assign({}, a.settings);
        this.savePrefs();
        this.renderAudioMenu();
      });
    }
    // Remembered settings: build the graph on the first user gesture, never before.
    if (!a.reason && a.anyOn()) {
      const onGesture = () => {
        if (a.built) return;
        a.build();
        a.resume();
        a.apply();
      };
      this.d.listen(this.host, 'pointerdown', onGesture, true);
      this.d.listen(document, 'keydown', onGesture, true);
    }
    this.renderAudioMenu();
  }

  renderAudioMenu() {
    const a = this.audio;
    const why = this.$('.audiomenu .why');
    why.hidden = !a.reason;
    why.textContent = a.reason === 'noWebAudio' ? t('audioNoWebAudio') : a.reason ? t('audioNativeHls') : '';
    for (const b of this.root.querySelectorAll('.audiomenu [data-audio]')) {
      const on = !!a.settings[b.dataset.audio];
      b.setAttribute('aria-checked', String(on));
      b.setAttribute('aria-disabled', String(!!a.reason));
      b.querySelector('.state').textContent = on ? t('on') : t('off');
    }
    this.$('.audiobtn').classList.toggle('active', a.anyOn() && !a.reason);
  }

  // ---- slide chapters ----

  setupSlides() {
    this.slidesPane = null;
    this.slides = new SlideAnalyzer({
      lesson: this.lesson,
      video: this.video,
      disposer: this.d,
      onChange: () => { if (!this.destroyed) this.onSlidesChange(); },
    });
    this.slides.start();
  }

  onSlidesChange() {
    const a = this.slides;
    // The screen view is known now: the per-view quality settings may apply differently.
    if (a.screenIndex !== this.knownScreen) {
      this.knownScreen = a.screenIndex;
      this.applyQuality();
      if (this.deck) this.deck.screenKnown();
    }
    this.renderChapterMarks();
    // The tab also holds the slide reader: it is there once the analysis has an answer,
    // even when no chapters were found.
    if (!a.chapters.length && a.state !== 'done' && a.state !== 'unavailable') return;
    if (a.state === 'unavailable' && this.deck) this.deck.screenKnown();
    if (!this.slidesPane) {
      this.slidesPane = new SlidesPane(this, this.$('.pane[data-pane=slides]'));
      this.d.add(() => this.slidesPane.dispose());
      this.registerTab('slides', this.slidesPane);
    }
    const pct = Math.floor(a.progress * 100);
    const status = !a.chapters.length && (a.state === 'done' || a.state === 'unavailable') ? t('slidesNone')
      : a.state === 'done' ? t('slidesFound', { n: a.chapters.length })
        : a.state === 'thumbnails' ? t('slidesRough', { pct }) : t('slidesFinding', { pct });
    this.slidesPane.setChapters(a.chapters, status);
  }

  // ---- slide files ----

  setupDeck() {
    this.reader = new SlideReader(this);
    this.reader.addTarget('main', this.$('.pstage'));
    this.reader.onInfo(() => { if (!this.destroyed) this.renderPdfBar(); });
    this.deck = new SlideDeckController({
      lesson: this.lesson,
      video: this.video,
      slides: this.slides,
      disposer: this.d,
      onChange: () => {
        if (this.destroyed) return;
        if (this.slidesPane) this.slidesPane.invalidate();
        // The PDF view appears (pages loaded) or goes (files removed) with the deck.
        if (this.pdfMode !== this.shownPdfMode) { this.shownPdfMode = this.pdfMode; this.applyLayout(); }
        if (this.reader.active) this.reader.update(this.video.currentTime, true);
      },
    });
    this.deck.restore().catch((e) => console.warn(TAG, 'slide files:', e && e.message ? e.message : e));
    const bar = (sel, fn) => this.d.listen(this.$(sel), 'click', (e) => { e.stopPropagation(); fn(); });
    bar('.pprev', () => this.reader.turn(-1));
    bar('.pnext', () => this.reader.turn(1));
    bar('.pswap', () => this.swapPdf());
    bar('.pclose', () => this.setPdfMain(false));
    // Dropping PDF files anywhere on the player adds them.
    const zone = this.$('.dropzone');
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    let depth = 0;
    this.d.listen(this.host, 'dragenter', (e) => { if (hasFiles(e)) { depth++; zone.hidden = false; } });
    this.d.listen(this.host, 'dragleave', () => { if (--depth <= 0) { depth = 0; zone.hidden = true; } });
    this.d.listen(this.host, 'dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    this.d.listen(this.host, 'drop', (e) => {
      depth = 0;
      zone.hidden = true;
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.deck.addFiles(e.dataTransfer.files).then((n) => {
        if (!n) { this.toast(t('dropNotPdf')); return; }
        if (this.sidebar.has('slides')) this.sidebar.open('slides');
      }).catch((err) => this.toast(t('deckError', { msg: String((err && err.message) || err) })));
    });
  }

  renderChapterMarks() {
    const el = this.$('.chaps');
    el.textContent = '';
    const dur = this.duration();
    if (!dur || !this.slides) return;
    const frag = document.createDocumentFragment();
    for (const c of this.slides.chapters) {
      if (c.start <= 0 || c.start >= dur) continue;
      const i = document.createElement('i');
      i.style.left = ((c.start / dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    el.appendChild(frag);
  }

  // Picture for the seek-bar preview: the slide shown at t if chapters are known,
  // otherwise Echo360's per-minute thumbnail of the main view.
  previewAt(t) {
    const chs = this.slides ? this.slides.chapters : [];
    const k = chapterIndexAt(chs, t);
    if (k >= 0 && chs[k].thumb) return chs[k].thumb;
    const src = this.sources[this.primaryPos];
    const set = (this.lesson.thumbnails || []).find((s) => s.sourceIndex === src.index);
    if (!set || !Array.isArray(set.timesInSeconds) || !set.timesInSeconds.length) return '';
    const times = set.timesInSeconds;
    let pick = times[0];
    for (const x of times) { if (x <= t) pick = x; else break; }
    return set.baseUri + '/' + pick + '.' + set.extension;
  }

  // Previous / next chapter; returns false when there are none (key not handled).
  stepChapter(dir) {
    const chs = this.slides ? this.slides.chapters : [];
    if (!chs.length) return false;
    const ct = this.video.currentTime;
    let k = chapterIndexAt(chs, ct);
    // "Previous" from more than 3 s into a chapter restarts it, like a music player.
    if (dir < 0 && k >= 0 && ct - chs[k].start > 3) dir = 0;
    k = clamp(k + dir, 0, chs.length - 1);
    this.seek(chs[k].start);
    return true;
  }

  // ---- silence ----

  setupSilence() {
    const av = this.sources.find((s) => s.av);
    const p = this.prefs.silence;
    this.silence = new SilenceAnalyzer({
      lesson: this.lesson,
      video: this.video,
      masterUrl: av ? av.av : null,
      disposer: this.d,
      onChange: () => { if (!this.destroyed) { this.renderSilences(); this.renderSilenceMenu(); } },
    });
    this.silence.options = { minSec: p.min, sensitivity: p.sens };
    this.silIdx = -1;
    this.silAutoSkipped = new Set();
    this.d.add(() => clearTimeout(this.skipTimer));
    const btn = this.$('.skipsil');
    this.d.listen(btn, 'click', (e) => {
      e.stopPropagation();
      const s = this.silence.silences[this.silIdx];
      this.hideSkip();
      if (s) this.seek(s.end);
    });
    const menu = this.$('.audiomenu');
    this.d.listen(menu.querySelector('[data-sil=auto]'), 'click', (e) => {
      e.stopPropagation();
      p.auto = !p.auto;
      this.savePrefs();
      this.renderSilenceMenu();
    });
    this.d.listen(menu.querySelector('.silmin'), 'click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button[data-min]');
      if (!b) return;
      p.min = +b.dataset.min;
      this.savePrefs();
      this.silence.setOptions({ minSec: p.min });
    });
    this.d.listen(menu.querySelector('.silsens'), 'click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button[data-sens]');
      if (!b) return;
      p.sens = b.dataset.sens;
      this.savePrefs();
      this.silence.setOptions({ sensitivity: p.sens });
    });
    this.renderSilenceMenu();
  }

  renderSilences() {
    const el = this.$('.sils');
    el.textContent = '';
    const dur = this.duration();
    if (!dur) return;
    const frag = document.createDocumentFragment();
    for (const s of this.silence.silences) {
      const i = document.createElement('i');
      i.style.left = ((s.start / dur) * 100).toFixed(3) + '%';
      i.style.width = (((Math.min(s.end, dur) - s.start) / dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    el.appendChild(frag);
    // New results (the analysis refines them as it goes) must not pop the button up again.
    this.silIdx = silenceIndexAt(this.silence.silences, this.video.currentTime);
  }

  renderSilenceMenu() {
    const a = this.silence;
    const p = this.prefs.silence;
    const total = a.silences.reduce((n, s) => n + s.end - s.start, 0);
    const found = a.silences.length
      ? t(a.source === 'transcript' ? 'silenceFromTranscript' : 'silenceFound', { n: a.silences.length, time: fmtTime(total) })
      : t('silenceNone', { min: p.min < 60 ? p.min + ' s' : p.min / 60 + ' min' });
    let status;
    if (a.source === 'pending') status = t('silenceWaiting');
    else if (a.source === 'unavailable') status = t(a.reason === 'saveData' ? 'silenceSaveData' : 'silenceUnavailable');
    else if (a.source === 'audio' && a.progress < 1) status = t('silenceAnalysing', { pct: Math.floor(a.progress * 100) }) + (a.silences.length ? ' ' + found : '');
    else status = found;
    const menu = this.$('.audiomenu');
    menu.querySelector('.silstatus').textContent = status;
    const auto = menu.querySelector('[data-sil=auto]');
    auto.setAttribute('aria-checked', String(p.auto));
    auto.querySelector('.state').textContent = p.auto ? t('on') : t('off');
    for (const b of menu.querySelectorAll('.silmin button')) b.setAttribute('aria-checked', String(+b.dataset.min === p.min));
    for (const b of menu.querySelectorAll('.silsens button')) b.setAttribute('aria-checked', String(b.dataset.sens === p.sens));
    // Sensitivity only matters when the audio itself is measured.
    menu.querySelector('.sens').hidden = a.source !== 'audio';
  }

  // On every time update: entering a silence offers to skip it (or skips it, if the user
  // turned that on). Only playback running into a silence skips automatically; seeking
  // into one just shows the button.
  silenceTick(ct) {
    const list = this.silence.silences;
    if (!list.length && this.silIdx === -1) return;
    const prev = this.silIdx;
    const i = silenceIndexAt(list, ct);
    if (i === prev) return;
    this.silIdx = i;
    const s = list[i];
    if (!s || s.end - ct < 5) { this.hideSkip(); return; }
    const ranInto = !this.video.seeking && !this.dragging && ct - s.start < 2;
    if (this.prefs.silence.auto && ranInto && !this.silAutoSkipped.has(s.start)) {
      this.silAutoSkipped.add(s.start);
      const from = ct;
      this.hideSkip();
      this.seek(s.end);
      this.toast(t('skippedSilence', { time: fmtTime(s.end - from) }), t('undo'), () => this.seek(from));
      return;
    }
    this.showSkip(s, ct);
  }

  showSkip(s, ct) {
    const btn = this.$('.skipsil');
    btn.textContent = t('skipSilence', { time: fmtTime(s.end - ct) });
    btn.classList.remove('fade');
    btn.tabIndex = 0;
    clearTimeout(this.skipTimer);
    this.skipTimer = setTimeout(guard(() => this.hideSkip()), 6000);
  }

  hideSkip() {
    const btn = this.$('.skipsil');
    btn.classList.add('fade');
    btn.tabIndex = -1;
    clearTimeout(this.skipTimer);
  }

  // ---- side panel, notes, discussion, markers ----

  registerTab(tab, controller) {
    this.sidebar.register(tab, controller);
    if (this.prefs.panel && this.prefs.tab === tab && !this.sidebar.isOpen) {
      this.restoringPanel = true;
      this.sidebar.open(tab);
      this.restoringPanel = false;
    }
  }

  onSidebarChange() {
    const sb = this.sidebar;
    this.app.classList.toggle('panel-open', sb.isOpen);
    for (const chip of this.root.querySelectorAll('.top [data-open]')) chip.setAttribute('aria-pressed', String(sb.visible(chip.dataset.open)));
    if (sb.visible('transcript')) this.transcript.renderMarks();
    if (!this.restoringPanel && sb.active) {
      this.prefs.panel = sb.isOpen;
      this.prefs.tab = sb.active;
      this.savePrefs();
    }
  }

  loadInteractions() {
    const l = this.lesson;
    const api = this.opts.api && l.lessonId && l.mediaId ? this.opts.api(l) : null;
    if (!api) return;
    const canFlag = !!l.sectionId && !l.isAnonymousUser;
    this.tags = new TagStore(l, () => { if (!this.destroyed && this.notes) this.notes.changed(); });
    this.tags.load().catch((e) => console.warn(TAG, 'tags:', e && e.message ? e.message : e));
    this.notes = new NotesPane(this, this.$('.pane[data-pane=notes]'), api, canFlag);
    this.notes.load().then((ok) => {
      if (this.destroyed || !ok) return;
      this.notesReady = true;
      this.$('.bmbtn').hidden = false;
      this.$('.flagbtn').hidden = !canFlag;
      this.renderFlagButton();
      this.registerTab('notes', this.notes);
    });
    this.discussion = new DiscussionPane(this, this.$('.pane[data-pane=discussion]'), api);
    this.discussion.load().then((ok) => {
      if (this.destroyed || !ok) return;
      this.registerTab('discussion', this.discussion);
    });
  }

  updateMarkers() {
    if (this.destroyed) return;
    const items = [];
    if (this.notes) items.push(...this.notes.markers());
    if (this.discussion && this.sidebar.has('discussion')) items.push(...this.discussion.markers());
    this.markers.set(items, this.duration());
  }

  renderFlagButton() {
    if (!this.notes || !this.notesReady) return;
    const on = !!this.notes.flagAt(this.video.currentTime);
    const b = this.$('.flagbtn');
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = svg(on ? 'flagOn' : 'flag');
  }

  renderExtras() {
    const x = this.lesson.extras || {};
    const what = [x.polls && t('extraPolls'), x.slides && t('extraSlides'), x.audioDescription && t('extraAudioDescription')].filter(Boolean);
    const box = this.$('.pextras');
    box.hidden = !what.length;
    if (what.length) box.querySelector('.msg').textContent = t('extrasNotice', { what: what.join(', ') });
  }

  bindPanelResize() {
    const handle = this.$('.presize');
    let appRect = null;
    this.d.listen(handle, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      appRect = this.app.getBoundingClientRect();
      handle.setPointerCapture(e.pointerId);
    });
    this.d.listen(handle, 'pointermove', (e) => {
      if (!appRect) return;
      const max = Math.min(640, appRect.width * 0.6);
      this.prefs.panelw = Math.round(clamp(appRect.right - e.clientX, 260, max));
      this.app.style.setProperty('--panelw', this.prefs.panelw + 'px');
    });
    const end = () => { if (appRect) { appRect = null; this.savePrefs(); } };
    this.d.listen(handle, 'pointerup', end);
    this.d.listen(handle, 'pointercancel', end);
  }

  // Stretches watched on this device (earlier visits and this one), faint on the rail.
  renderWatched() {
    const dur = this.duration();
    const el = this.$('.wat');
    if (!dur || !this.watched.ready) return;
    el.textContent = '';
    const frag = document.createDocumentFragment();
    for (const [a, b] of this.watched.ranges()) {
      const i = document.createElement('i');
      i.style.left = ((a / dur) * 100).toFixed(3) + '%';
      i.style.width = (((Math.min(b, dur) - a) / dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    el.appendChild(frag);
  }

  // Keyboard zoom on the main picture (the primary slot), around its centre; 0 resets.
  zoomMain(factor) {
    const slot = this.root.querySelector('.views [data-slot=primary]');
    const el = slot && (slot.tagName === 'VIDEO' ? slot : slot.querySelector('.rpages'));
    if (!el) return;
    if (!factor) { this.zoom.reset(el); return; }
    this.zoom.zoomAt(el, factor, 0.5, 0.5);
  }

  showKeys(on) {
    const box = this.$('.keyhelp');
    if (on) {
      const list = box.querySelector('.khlist');
      list.textContent = '';
      for (const [keys, label] of KEY_HELP) {
        list.append(h('div', null, ...keys.map((k) => h('kbd', { text: k }))), h('div', { text: t(label) }));
      }
    }
    box.hidden = !on;
    if (on) box.querySelector('.khclose').focus();
  }

  toast(msg, action, fn) {
    const el = this.$('.toast');
    el.querySelector('.msg').textContent = msg;
    const btn = el.querySelector('.act');
    btn.hidden = !action;
    btn.textContent = action || '';
    btn.onclick = guard((ev) => { el.hidden = true; if (fn) fn(ev); });
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.hidden = true; }, 8000);
  }

  showError(title, text, actions) {
    const box = this.$('.error');
    box.querySelector('h2').textContent = title;
    box.querySelector('p').textContent = text;
    const wrap = box.querySelector('.actions');
    wrap.textContent = '';
    for (const [label, fn, primary] of actions) {
      const b = document.createElement('button');
      b.textContent = label;
      if (primary) b.className = 'primary';
      b.addEventListener('click', fn);
      wrap.appendChild(b);
    }
    box.hidden = false;
    this.wake();
  }

  hideError() { this.$('.error').hidden = true; }

  destroy() {
    if (this.destroyed) return;
    this.savePosition();
    this.destroyed = true;
    this.d.dispose();
  }
}

function nextSpeed(current, dir) {
  const i = SPEEDS.findIndex((s) => s >= current - 0.001);
  const idx = i < 0 ? SPEEDS.length - 1 : i;
  return SPEEDS[clamp(idx + dir, 0, SPEEDS.length - 1)];
}
