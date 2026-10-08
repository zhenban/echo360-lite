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
//
// The player assembles its parts and keeps what they share: the streams, the layout and
// the settings. Each part gets only the functions and elements it needs, and is owned
// through a child of the player's Disposer (released with it, or alone if it fails):
//   SeekBar (41), KeyboardShortcuts (42), LayoutControls (43), QualityController (44),
//   MenuBar (45), PopoutController (46), SilenceUi (47); and the features: captions and
//   transcript (53), side panel (54), notes (55), discussion (57), slides (64-68),
//   zoom (50), A-B loop (51), watched parts (52), audio tools (60).
// ===================================================================================

class LitePlayer {
  constructor(lesson, opts) {
    this.d = new Disposer();
    this.destroyed = false;
    // A failure half-way must not leave a half-built player (a black overlay over the
    // original player, timers, requests): release everything made so far, then let the
    // caller fall back.
    this.constructing = true;
    try {
      this.init(lesson, opts);
      this.constructing = false;
    } catch (e) {
      this.destroyed = true;
      try { this.d.dispose(); } catch (err) { /* keep the first error */ }
      throw e;
    }
  }

  init(lesson, opts) {
    this.lesson = lesson;
    this.opts = opts;
    // A feature that fails is announced once (playback goes on).
    featureErrors.notify = (name) => { if (!this.destroyed && this.root) this.toast(tr('featureFailed', { name })); };
    this.d.add(() => { featureErrors.notify = null; });
    this.prefs = sanitizePrefs(store.get('prefs', null));
    this.played = new PlayedRanges();
    // Shared by the parts that drag (seek bar, divider, picture-in-picture window) and
    // those that must not interfere meanwhile (hiding the controls, skipping silences).
    this.ui = { dragging: false };
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
      url: location.href, renewMs: lesson.sessionRenewMs, disposer: this.d.feature('session renewal'),
      onState: (st) => { if (!this.destroyed) this.$('.sessionhint').hidden = st !== 'renewing'; },
    });
    this.clock = new Stream(this.video, (f) => this.onClockFatal(f));
    this.follower = new Stream(this.fvideo, (f) => (f.auth ? this.recoverAccess(this.follower, () => this.onFollowerFatal()) : this.onFollowerFatal()));
    this.followerPos = -1;
    for (const st of [this.clock, this.follower]) {
      st.onLevel = () => { if (!this.destroyed) this.quality.levelChanged(); };
      // Refused but still retrying: renew in the background (once at a time).
      st.onAuth = () => {
        if (this.destroyed) return;
        if (!this.session.failed) { this.session.renew(true).catch(() => {}); return; }
        // Renewal has already given up: say so now rather than after hls.js's retries.
        if (st === this.clock) this.showAuthError(); else this.onFollowerFatal();
      };
    }
    this.d.add(() => { this.dropFollower(); this.clock.destroy(); });
    this.setupParts();
    this.bindVideo();
    this.bindControls();
    this.watched = new WatchedStore(lesson, this.video, this.played);
    this.watched.load().then(() => { if (!this.destroyed) this.renderWatched(); }).catch(() => {});
    this.d.listen(window, 'pagehide', () => this.watched.save(this.duration()));
    this.reporter = lesson.analytics ? new Reporter(lesson.analytics, this.video, this.played, this.d.child()) : null;
    if (this.reporter) this.reporter.stateFn = () => ({ captions: this.cc.on, transcript: this.sidebar.visible('transcript') });
    // Optional features: one failing to start is turned off, the others and playback go on.
    featureGuard('silence detection', () => {
      this.silence = new SilenceUi({
        $: (sel) => this.$(sel), lesson, video: this.video, sources: this.sources, prefs: this.prefs, savePrefs: () => this.savePrefs(),
        seek: (t) => this.seek(t), duration: () => this.duration(), toast: (...a) => this.toast(...a), ui: this.ui,
        uniform: () => (this.slides ? this.slides.uniform : []),
        onSkips: (skips, end) => {
          this.seekBar.renderSkips(skips);
          if (this.watched) this.watched.contentEnd = end && end < this.duration() ? end : null;
        },
      }, this.d.feature('silence detection'));
    });
    featureGuard('slide chapters', () => this.setupSlides());
    featureGuard('slide reader', () => this.setupDeck());
    featureGuard('captions', () => this.loadCues());
    featureGuard('notes and discussion', () => this.loadInteractions());
    featureGuard('audio tools', () => this.setupAudio());

    const start = this.pickStart();
    this.startAt = start;
    this.loadClock(this.clockPos, start, false);
    this.applyLayout();
    if (start > 1) this.toast(tr('resumedAt', { time: fmtTime(start) }), tr('startOver'), () => this.seek(0));
  }

  // An element of the player's own markup. Each selector must name exactly one element:
  // two elements sharing a class once bound one button's action to another. Looked up
  // once and remembered (the markup is fixed; parts that are redrawn are not looked up
  // this way).
  $(sel) {
    let elem = this.refs.get(sel);
    if (!elem) {
      const all = this.root.querySelectorAll(sel);
      if (all.length !== 1) throw new Error('player markup: "' + sel + '" matches ' + all.length + ' elements');
      elem = all[0];
      this.refs.set(sel, elem);
    }
    return elem;
  }

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
    this.refs = new Map();
    this.stage = this.$('.stage');
    this.video = this.$('video.clock');
    this.fvideo = this.$('video.follower');
    this.app = this.$('.app');
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
    this.sidebar = new Sidebar(this, this.$('.panel'), this.d.child());
    this.transcript = new TranscriptPanel(this, this.$('.pane[data-pane=transcript]'), this.$('.marks'), this.d.child());
    this.markers = new MarkersLayer(this.$('.imarks'));
    this.notes = null;
    this.discussion = null;
    this.renderExtras();
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
      const local = sanitizePos(store.get('pos:' + this.lesson.id, null));
      t0 = local ? local.t : 0;
    }
    if (!(t0 > 0) || (isFinite(dur) && t0 > dur - RESUME_END_SEC)) t0 = 0;
    return t0;
  }

  // ---- streams and layout ----

  // Core playback: an error here hands over to the original player.
  loadClock(pos, startAt, autoplay) {
    try { this.loadClockNow(pos, startAt, autoplay); } catch (e) { if (this.constructing) throw e; reportUnexpected(e); }
  }

  loadClockNow(pos, startAt, autoplay) {
    const v = this.video;
    const source = this.sources[pos];
    this.played.absorb(v.played);
    this.clockPos = pos;
    if (source.poster && startAt < 1) v.poster = source.poster; else v.removeAttribute('poster');
    v.defaultPlaybackRate = this.prefs.rate;
    v.volume = clamp(this.prefs.volume, 0, 1);
    v.muted = !!this.prefs.muted;
    this.renderVolume();
    this.clock.quality = this.quality.qualityFor(pos);
    this.clock.priority = this.quality.roleOf(pos) === 'camera' ? 'low' : 'high';
    this.clock.load(source.av, startAt, () => {
      v.playbackRate = this.prefs.rate;
      if (this.clock.playing()) v.play().catch(() => {});
    }, autoplay);
  }

  ensureFollower() {
    const pos = this.sources.findIndex((s, i) => i !== this.clockPos);
    if (pos < 0) return;
    const source = this.sources[pos];
    const uri = source.v || source.av;
    if (this.follower.uri !== uri) {
      if (source.poster) this.fvideo.poster = source.poster;
      // Where the clock is, or is about to be while it is (re)loading.
      const at = this.clock.position();
      this.followerPos = pos;
      this.follower.quality = this.quality.qualityFor(pos);
      this.follower.priority = this.quality.roleOf(pos) === 'camera' ? 'low' : 'high';
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
    try { this.applyLayoutNow(); } catch (e) { if (this.constructing) throw e; reportUnexpected(e); }
  }

  applyLayoutNow() {
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
        // Asked of the stream, not the element: a switch made while the previous one is
        // still loading would otherwise read 0 (and paused) and start over.
        this.loadClock(this.primaryPos, this.clock.position(), this.clock.playing());
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
    this.setButton('.layout', layout === 'side' ? 'layoutSide' : layout === 'pip' ? 'layoutPip' : 'layoutSingle', tr('layout'));
    for (const b of this.root.querySelectorAll('.layoutmenu button')) b.setAttribute('aria-checked', String(b.dataset.layout === layout));
    if (this.reader) {
      this.reader.setActive('main', pdf);
      if (pdf) this.redrawPdf();
    }
    this.quality.apply();
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

  // The element showing the screen view if it is playing, else the main view.
  screenVideo() {
    const pos = this.slides && this.slides.screenIndex != null ? this.sources.findIndex((s) => s.index === this.slides.screenIndex) : -1;
    if (pos >= 0 && pos === this.clockPos) return this.video;
    if (pos >= 0 && pos === this.followerPos) return this.fvideo;
    return this.layout === 'single' || this.clockPos === this.primaryPos ? this.video : this.fvideo;
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
    this.showError(tr('playbackFailedTitle'), tr('playbackFailedText', { detail: f.details }),
      [[tr('retry'), () => { this.hideError(); this.loadClock(this.clockPos, this.clock.position(), true); }, true],
        [tr('useOriginal'), () => this.opts.onFallback('error')]]);
  }

  // The video files were refused: renew the access in the background and carry on from
  // the current position with the same element. A second refusal right after a renewal,
  // or a renewal that fails, ends in `fail`.
  recoverAccess(stream, fail) {
    const now = Date.now();
    if (stream.renewedAt && now - stream.renewedAt < RENEW_REFUSAL_MS) { fail(); return; }
    // The stream may be reloaded (views swapped) while renewing: resume only the instance
    // that failed; a new one has started loading by itself.
    const engine = stream.hls;
    this.session.renew(true).then(() => {
      if (this.destroyed || stream.hls !== engine) return;
      stream.renewedAt = Date.now();
      stream.resume(stream.position());
    }, () => { if (!this.destroyed) fail(); });
  }

  showAuthError() {
    const login = this.session.failed && this.session.failed.login;
    this.showError(tr('authExpiredTitle'), tr(login ? 'authLoginExpiredText' : 'authExpiredText'),
      [[tr('reload'), () => { this.savePosition(); location.reload(); }, true], [tr('useOriginal'), () => this.opts.onFallback('auth')]]);
  }

  onFollowerFatal() {
    if (this.destroyed || this.followerFailed) return;
    // Keep watching with the clock alone; the layout preference is kept for next time.
    this.followerFailed = true;
    this.applyLayout();
    this.toast(tr('secondViewLost'), tr('retry'), () => this.setLayout(this.prefs.layout));
  }

  // ---- the parts ----

  setupParts() {
    const $ = (sel) => this.$(sel);
    const savePrefs = () => this.savePrefs();
    const toast = (...a) => this.toast(...a);
    const isDestroyed = () => this.destroyed;
    this.seekBar = new SeekBar({
      $, video: this.video, clock: this.clock, duration: () => this.duration(), seek: (t) => this.seek(t),
      isIdle: () => this.stage.classList.contains('idle'), armIdle: () => this.armIdle(), markers: this.markers, ui: this.ui,
      previewAt: (t) => this.previewAt(t), skipAt: (t) => (this.silence ? this.silence.skipAt(t) : null),
    }, this.d.child());
    this.quality = new QualityController({
      $, prefs: this.prefs, savePrefs, sources: this.sources, dual: this.dual,
      screenIndex: () => (this.slides ? this.slides.screenIndex : null),
      streams: () => [{ stream: this.clock, elem: this.video, pos: this.clockPos }, { stream: this.follower, elem: this.fvideo, pos: this.followerPos }],
      shown: () => (this.layout === 'single' || this.clockPos === this.primaryPos ? this.clock : this.follower),
      layout: () => this.layout,
    }, this.d.child());
    this.layoutControls = new LayoutControls({
      $, stage: this.stage, prefs: this.prefs, savePrefs, ui: this.ui, armIdle: () => this.armIdle(), redrawPdf: () => this.redrawPdf(),
      // A click swaps the two pictures (with the PDF shown: the PDF and the video).
      onPipClick: () => { if (this.pdfMode) this.swapPdf(); else this.swapViews(); },
    }, this.d.child());
    this.menus = new MenuBar({
      $, root: this.root, stage: this.stage, video: this.video, prefs: this.prefs, savePrefs, cc: this.cc, toast,
      setRate: (r) => this.setRate(r), setLayout: (l) => this.setLayout(l), cues: () => this.cues || [], screenVideo: () => this.screenVideo(),
      title: this.lesson.title, duration: () => this.duration(), wake: () => this.wake(), showKeys: () => this.keys.showHelp(true),
      diagnostics: () => diagnosticsText(this),
      onOpen: (menu) => { if (menu.classList.contains('qualitymenu')) this.quality.renderMenu(); },
      onCloseAll: () => { if (this.loop) this.loop.menu.hidden = true; },
    }, this.d.child());
    this.keys = new KeyboardShortcuts({ $, isDestroyed, wake: () => this.wake(), actions: this.keyActions() }, this.d.child());
    this.popout = new PopoutController({
      $, host: this.host, video: this.video, title: this.lesson.title, onKey: this.keys.onKey, isDestroyed, toast,
      relayout: () => { this.quality.apply(); this.redrawPdf(); },
    }, this.d.feature('floating window'));
  }

  // What the keyboard shortcuts do (see 42-keys.js); false: not available now.
  keyActions() {
    const v = this.video;
    const notesReady = () => this.notes && this.notesReady;
    return {
      togglePlay: () => this.togglePlay(),
      seekBy: (s) => this.seek(this.clock.position() + s),
      stepChapter: (dir) => this.stepChapter(dir),
      volumeBy: (dv) => { if (dv > 0) v.muted = false; v.volume = clamp(v.volume + dv, 0, 1); },
      toggleMute: () => { v.muted = !v.muted; },
      fullscreen: () => this.toggleFullscreen(),
      swap: () => this.swapViews(),
      captions: () => (this.cues && this.cues.length ? this.menus.setCaptions(!this.cc.on) : false),
      transcript: () => (this.sidebar.has('transcript') ? this.sidebar.toggle('transcript') : false),
      bookmark: (a, e) => (notesReady() ? this.notes.addBookmark(e) : false),
      flag: (a, e) => (notesReady() && this.notes.canFlag ? this.notes.toggleFlag(e) : false),
      tag: (a, e) => (notesReady() ? this.notes.tagHere(e) : false),
      copyFrame: () => this.menus.copyFrame(),
      copyCaptions: () => this.menus.copyCaptions(),
      escape: () => {
        if (this.menus.diagnosticsOpen) this.menus.showDiagnostics(false);
        else if (this.keys.helpOpen) this.keys.showHelp(false);
        else if (this.menus.anyOpen()) this.menus.closeAll();
        else return false;
        return true;
      },
      zoom: (f) => this.zoomMain(f),
      loopA: () => this.loop.setA(v.currentTime),
      loopB: () => this.loop.setB(v.currentTime),
      loopClear: () => (this.loop.a != null ? this.loop.clear() : false),
      popout: () => (PopoutController.supported() ? this.popout.toggle() : false),
      exportNotes: () => (notesReady() ? this.notes.openExport() : false),
      speed: (dir) => this.setRate(nextSpeed(v.playbackRate, dir)),
    };
  }

  // ---- video events ----

  bindVideo() {
    const v = this.video;
    const stage = this.stage;
    // The clock video's events are core playback: an error here hands over to the original player.
    const d = this.d.core();
    const on = (type, fn) => d.listen(v, type, fn);
    on('play', () => {
      // Back after a long pause (or a sleeping laptop): renew the access before it runs out.
      this.session.wake();
      // Play is normally user-initiated; also recovers a context the browser suspended.
      if (this.audio) { this.audio.resume(); this.audio.syncTimer(); }
      stage.classList.remove('paused');
      this.setButton('.play', 'pause', tr('pause'));
      if (this.reporter) this.reporter.onPlay();
      this.armIdle();
    });
    on('pause', () => {
      if (this.audio) this.audio.syncTimer();
      stage.classList.add('paused');
      this.setButton('.play', 'play', tr('play'));
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
      if (this.silence) this.silence.tick(ct);
      if (this.slidesPane) this.slidesPane.update(ct);
      if (this.reader) this.reader.update(ct);
    };
    on('timeupdate', () => { invalidate(); onTime(); });
    on('seeked', onTime);
    on('progress', invalidate);
    on('durationchange', () => { this.render(true); if (this.loop) this.loop.render(); this.renderWatched(); this.updateMarkers(); if (this.silence) this.silence.update(); this.renderChapterMarks(); });
    on('ratechange', () => this.menus.renderSpeed(v.playbackRate));
    on('volumechange', () => {
      this.renderVolume();
      this.prefs.volume = v.volume;
      this.prefs.muted = v.muted;
      this.savePrefs();
    });
    on('ended', () => this.savePosition(0));
    d.listen(document, 'visibilitychange', () => { if (!document.hidden) this.render(true); });
    d.listen(window, 'hashchange', () => { const tm = this.linkTime(); if (tm != null) this.seek(tm); });

    // Stall watchdog (playing, not seeking, time has not moved for STALL_SEC) and, every
    // few ticks, the local resume position as a fallback for the server-side one.
    let lastT = -1;
    let still = 0;
    let tick = 0;
    d.interval(() => {
      if (v.paused || v.seeking || v.ended) { still = 0; lastT = v.currentTime; return; }
      if (v.currentTime === lastT) {
        still += STALL_CHECK_MS / 1000;
        if (still >= STALL_SEC) {
          log.warn('playback stalled, restarting loader at', v.currentTime.toFixed(1));
          this.clock.kick(v.currentTime);
          still = 0;
        }
      } else { still = 0; lastT = v.currentTime; }
      if (++tick % POSITION_SAVE_EVERY === 0) { this.savePosition(); this.watched.save(this.duration()); this.renderWatched(); }
    }, STALL_CHECK_MS);
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
    store.set('pos:' + this.lesson.id, { t: pos === undefined ? this.clock.position() : pos, at: Date.now() });
  }

  duration() {
    const dur = this.video.duration;
    return isFinite(dur) && dur > 0 ? dur : (isFinite(this.lesson.duration) ? this.lesson.duration : 0);
  }

  // Time label, progress and buffer bars (at most once per frame, see SeekBar).
  render(force) {
    if (!this.destroyed) this.seekBar.render(force);
  }

  seek(target) {
    const dur = this.duration();
    const to = clamp(target, 0, dur ? dur - 0.1 : target);
    this.clock.intend(to, null);
    this.video.currentTime = to;
    this.render(true);
    if (this.loop) this.loop.seeked(to);
  }

  togglePlay() {
    const v = this.video;
    // While (re)loading the element says paused: go by what the stream is meant to do.
    const play = this.clock.starting ? !this.clock.playing() : v.paused || v.ended;
    this.clock.intend(null, play);
    if (play) v.play().catch(() => {}); else v.pause();
  }

  setRate(r) {
    r = clamp(Math.round(r * 100) / 100, 0.25, 4);
    this.video.playbackRate = r;
    this.video.defaultPlaybackRate = r;
    this.prefs.rate = r;
    this.savePrefs();
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this.host.requestFullscreen().catch(() => {});
  }

  // ---- idle (auto-hide) handling ----

  wake() {
    const wasIdle = this.stage.classList.contains('idle');
    this.stage.classList.remove('idle');
    if (wasIdle) this.render(true);
    this.armIdle();
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(guard(() => {
      if (!this.video.paused && !this.ui.dragging && !this.menus.anyOpen()) this.stage.classList.add('idle');
    }), CONTROLS_HIDE_MS);
  }

  // The plain buttons, clicks on the pictures, zoom, the side panel chips.
  bindControls() {
    const $ = (sel) => this.$(sel);
    const v = this.video;
    const d = this.d;
    // Old analysis results are cleaned up in the background, once the page has settled.
    d.timeout(() => analysisCaches.prune().catch(() => {}), 60000);
    d.add(() => { clearTimeout(this.idleTimer); clearTimeout(this.toastTimer); clearTimeout(this.sharpTimer); clearTimeout(this.prefsTimer); store.set('prefs', this.prefs); });
    d.listen($('.play'), 'click', () => this.togglePlay());
    d.listen($('.rew'), 'click', () => this.seek(this.clock.position() - 10));
    d.listen($('.fwd'), 'click', () => this.seek(this.clock.position() + 10));
    d.listen($('.mute'), 'click', () => {
      if (v.muted || v.volume === 0) { v.muted = false; if (v.volume === 0) v.volume = 0.5; } else v.muted = true;
    });
    d.listen($('.volume'), 'input', (e) => { v.volume = +e.target.value; v.muted = v.volume === 0; });
    d.listen($('.fs'), 'click', () => this.toggleFullscreen());
    d.listen($('.swap'), 'click', () => this.swapViews());
    d.listen($('.orig'), 'click', () => this.opts.onFallback('user'));
    d.listen(document, 'fullscreenchange', () => {
      this.setButton('.fs', document.fullscreenElement ? 'exitFullscreen' : 'fullscreen', tr('fullscreen'));
    });
    let resizeTimer = 0;
    d.add(() => clearTimeout(resizeTimer));
    d.listen(window, 'resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(guard(() => { this.quality.apply(); this.redrawPdf(); }), 500); });
    for (const chip of this.root.querySelectorAll('.top [data-open]')) d.listen(chip, 'click', () => this.sidebar.toggle(chip.dataset.open));
    d.listen($('.panelclose'), 'click', () => this.sidebar.close());
    d.listen($('.bmbtn'), 'click', (e) => { if (this.notes) this.notes.addBookmark(e); });
    d.listen($('.flagbtn'), 'click', (e) => { if (this.notes) this.notes.toggleFlag(e); });
    d.listen($('.pextras button'), 'click', () => this.opts.onFallback('extras'));
    this.bindPanelResize();
    this.loop = new ABLoop({
      mount: $('.speedmenu').parentElement, rail: $('.seek'), video: v, duration: () => this.duration(), seek: (t) => this.seek(t), toast: (...a) => this.toast(...a),
    }, this.d.feature('A-B loop'));

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
    this.zoom = new Zoomer(views, this.d.feature('zoom'), {
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
      canZoom: (elem) => !(this.layout === 'pip' && (elem.closest('[data-slot]') || elem).dataset.slot === 'secondary'),
    });
    d.listen(views, 'click', (e) => {
      if (e.target.tagName !== 'VIDEO') return;
      if (this.zoom.dragged) return;
      if (wokeByPress) { wokeByPress = false; return; }
      clearTimeout(clickTimer);
      clickTimer = setTimeout(guard(() => this.togglePlay()), DOUBLE_CLICK_MS);
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
  }

  // ---- captions and transcript ----

  loadCues() {
    this.cues = null;
    if (!this.opts.fetchCues) { if (this.silence) this.silence.start([]); return; }
    this.opts.fetchCues(this.lesson).then((cues) => {
      if (this.destroyed) return;
      if (this.silence) this.silence.start(cues);
      if (!cues.length) return;
      this.cues = cues;
      if (this.slidesPane) this.slidesPane.invalidate();
      if (this.reporter) this.reporter.captionsAvailable = cues.length;
      this.cc.setCues(cues);
      this.transcript.setCues(cues);
      this.$('.ccbtn').hidden = false;
      this.menus.renderCaptionMenu();
      if (this.prefs.captions) this.menus.setCaptions(true, true);
      this.registerTab('transcript', this.transcript);
    });
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
    why.textContent = a.reason === 'noWebAudio' ? tr('audioNoWebAudio') : a.reason ? tr('audioNativeHls') : '';
    for (const b of this.root.querySelectorAll('.audiomenu [data-audio]')) {
      const on = !!a.settings[b.dataset.audio];
      b.setAttribute('aria-checked', String(on));
      b.setAttribute('aria-disabled', String(!!a.reason));
      b.querySelector('.state').textContent = on ? tr('on') : tr('off');
    }
    this.$('.audiobtn').classList.toggle('active', a.anyOn() && !a.reason);
  }

  // ---- slide chapters ----

  setupSlides() {
    this.slidesPane = null;
    this.slides = new SlideAnalyzer({
      lesson: this.lesson,
      video: this.video,
      disposer: this.d.feature('slide chapters'),
      onChange: () => { if (!this.destroyed) this.onSlidesChange(); },
    });
    this.slides.start();
  }

  onSlidesChange() {
    const a = this.slides;
    if (a.uniform !== this.knownUniform) { this.knownUniform = a.uniform; if (this.silence) this.silence.update(); }
    // The screen view is known now: the per-view quality settings may apply differently.
    if (a.screenIndex !== this.knownScreen) {
      this.knownScreen = a.screenIndex;
      this.quality.apply();
      if (this.deck) this.deck.screenKnown();
    }
    this.renderChapterMarks();
    // The tab also holds the slide reader: it is there once the analysis has an answer,
    // even when no chapters were found.
    if (!this.slidesPane && !a.chapters.length && a.state !== 'done' && a.state !== 'unavailable') return;
    if (a.state === 'unavailable' && this.deck) this.deck.screenKnown();
    if (!this.slidesPane) {
      this.slidesPane = new SlidesPane(this, this.$('.pane[data-pane=slides]'), this.d.child());
      this.registerTab('slides', this.slidesPane);
    }
    const pct = Math.floor(a.progress * 100);
    const status = !a.chapters.length && (a.state === 'done' || a.state === 'unavailable') ? tr('slidesNone')
      : a.state === 'done' ? tr('slidesFound', { n: a.chapters.length })
        : a.state === 'thumbnails' ? tr('slidesRough', { pct }) : tr('slidesFinding', { pct });
    this.slidesPane.setChapters(a.chapters, status);
  }

  // ---- slide files ----

  setupDeck() {
    this.reader = new SlideReader(this);
    this.reader.addTarget('main', this.$('.pstage'));
    this.d.add(this.reader.onInfo(() => { if (!this.destroyed) this.renderPdfBar(); }));
    this.deck = new SlideDeckController({
      lesson: this.lesson,
      video: this.video,
      slides: this.slides,
      disposer: this.d.feature('slide reader'),
      onChange: () => {
        if (this.destroyed) return;
        if (this.slidesPane) this.slidesPane.invalidate();
        // The PDF view appears (pages loaded) or goes (files removed) with the deck.
        if (this.pdfMode !== this.shownPdfMode) { this.shownPdfMode = this.pdfMode; this.applyLayout(); }
        if (this.reader.active) this.reader.update(this.video.currentTime, true);
      },
    });
    this.deck.restore().catch((e) => log.warn('slide files:', e && e.message ? e.message : e));
    const bar = (sel, fn) => this.d.listen(this.$(sel), 'click', (e) => { e.stopPropagation(); fn(); });
    bar('.pprev', () => this.reader.turn(-1));
    bar('.pnext', () => this.reader.turn(1));
    bar('.pswap', () => this.swapPdf());
    bar('.pdfclose', () => this.setPdfMain(false));
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
        if (!n) { this.toast(tr('dropNotPdf')); return; }
        if (this.sidebar.has('slides')) this.sidebar.open('slides');
      }).catch((err) => this.toast(this.deck.state === 'error' && this.deck.error ? this.deck.error : tr('deckError', { msg: String((err && err.message) || err) })));
    });
  }

  renderChapterMarks() {
    this.seekBar.renderChapters(this.slides ? this.slides.chapters : []);
  }

  renderWatched() {
    if (this.watched.ready) this.seekBar.renderWatched(this.watched.ranges());
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
    this.tags.load().catch((e) => log.warn('tags:', e && e.message ? e.message : e));
    this.notes = new NotesPane(this, this.$('.pane[data-pane=notes]'), api, canFlag, this.d.feature('notes'));
    this.notes.load().then((ok) => {
      if (this.destroyed || !ok) return;
      this.notesReady = true;
      this.$('.bmbtn').hidden = false;
      this.$('.flagbtn').hidden = !canFlag;
      this.renderFlagButton();
      this.registerTab('notes', this.notes);
    });
    this.discussion = new DiscussionPane(this, this.$('.pane[data-pane=discussion]'), api, this.d.feature('discussion'));
    this.discussion.load().then((ok) => {
      if (this.destroyed || !ok) return;
      this.registerTab('discussion', this.discussion);
    });
  }

  updateMarkers() {
    if (this.destroyed) return;
    const items = [];
    // Where Echo360 says playback stopped last time (any device), as it was when the page opened.
    const last = this.lesson.resumeAt;
    if (last > 1 && last < this.duration() - 1) items.push({ time: last, kind: 'laststop', label: tr('lastStopped') });
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
    const what = [x.polls && tr('extraPolls'), x.slides && tr('extraSlides'), x.audioDescription && tr('extraAudioDescription')].filter(Boolean);
    const box = this.$('.pextras');
    box.hidden = !what.length;
    if (what.length) box.querySelector('.msg').textContent = tr('extrasNotice', { what: what.join(', ') });
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

  // Keyboard zoom on the main picture (the primary slot), around its centre; 0 resets.
  zoomMain(factor) {
    const slot = this.root.querySelector('.views [data-slot=primary]');
    const elem = slot && (slot.tagName === 'VIDEO' ? slot : slot.querySelector('.rpages'));
    if (!elem) return;
    if (!factor) { this.zoom.reset(elem); return; }
    this.zoom.zoomAt(elem, factor, 0.5, 0.5);
  }

  toast(msg, action, fn) {
    const elem = this.$('.toast');
    elem.querySelector('.msg').textContent = msg;
    const btn = elem.querySelector('.act');
    btn.hidden = !action;
    btn.textContent = action || '';
    btn.onclick = guard((ev) => { elem.hidden = true; if (fn) fn(ev); });
    elem.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { elem.hidden = true; }, 8000);
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
