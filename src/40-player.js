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
//   Popovers and Tooltips (32), SeekBar (41), KeyboardShortcuts (42), LayoutControls (43),
//   QualityController (44), MenuBar (45), PopoutController (46), SilenceUi (47),
//   SpeedControl (48), VolumeControl (49); and the features: captions and
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
    this.frame = new FrameTask(() => this.render(), () => this.host);
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
        onChange: () => this.menus.refresh(),
        onSkips: (skips, end) => {
          this.seekBar.renderSkips(skips);
          if (this.watched) this.watched.contentEnd = end && end < this.duration() ? end : null;
        },
      }, this.d.feature('silence detection'));
      this.menuPages.silence = () => this.silence.items();
      this.menuValues.silence = () => this.silence.value();
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

  // All elements of the player's markup matching sel (for groups such as menu items).
  all(sel) {
    return /** @type {HTMLElement[]} */ ([...this.root.querySelectorAll(sel)]);
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
    host.id = 'lite-player-for-echo360';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + PLAYER_CSS + '</style>' + playerTemplate();
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
    this.app.dataset.theme = this.prefs.theme;
    this.stage.classList.toggle('hidecc-paused', !!this.prefs.capHidePaused);
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
    this.volumeCtl.render();
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
    this.renderLayoutButton();
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
    windowOf(this.host).requestAnimationFrame(() => {
      const tg = this.reader.targets.get('main');
      const i = this.reader.currentView();
      if (tg && tg.active && i >= 0) this.reader.drawInto(tg, i);
    });
  }

  renderPdfBar() {
    const rd = this.reader;
    const deck = rd && rd.deck;
    const i = rd ? rd.currentView() : -1;
    if (!deck || i < 0) return;
    this.$('.plabel').textContent = rd.label();
    this.$('.pprev').disabled = i <= 0;
    this.$('.pnext').disabled = i >= deck.pages.length - 1;
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

  // Layouts offered in the settings menu ([]: one picture only).
  layoutChoices() {
    return this.dual || this.pdfMode ? LAYOUTS : [];
  }

  // The layout button's cycle. With the PDF view open it switches between side by side and
  // picture in picture: alone, the PDF or the video would be hidden (single view stays in
  // the settings menu).
  layoutCycle() {
    if (this.pdfMode) return ['side', 'pip'];
    return this.dual ? LAYOUTS : [];
  }

  nextLayout() {
    const list = this.layoutCycle();
    return list[(list.indexOf(this.layout) + 1) % list.length];
  }

  // The icon shows the layout now; the tooltip says what a press switches to.
  renderLayoutButton() {
    const b = this.$('.layout');
    const hide = !this.layoutCycle().length;
    if (b.hidden !== hide) { b.hidden = hide; this.menus.fitBar(); }
    if (hide) return;
    const now = this.layout;
    const to = tr({ side: 'layoutToSide', pip: 'layoutToPip', single: 'layoutToSingle' }[this.nextLayout()]);
    b.innerHTML = svg(now === 'side' ? 'layoutSide' : now === 'pip' ? 'layoutPip' : 'layoutSingle');
    b.setAttribute('aria-label', tr('layoutNow', { layout: tr(layoutKey(now)) }) + '. ' + to);
    b.dataset.tip = to;
    this.menus.refresh();
  }

  setTheme(theme) {
    this.prefs.theme = theme;
    this.app.dataset.theme = theme;
    this.savePrefs();
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
    const layer = this.$('.layer');
    this.pops = new Popovers(layer, this.d.child(), (open) => { if (open) this.wake(); else this.armIdle(); });
    this.tooltips = new Tooltips(this.root, layer, this.d.child());
    this.seekBar = new SeekBar({
      $, video: this.video, clock: this.clock, duration: () => this.duration(), seek: (t) => this.seek(t),
      isIdle: () => this.stage.classList.contains('idle'), armIdle: () => this.armIdle(), markers: this.markers, ui: this.ui,
      previewAt: (t) => this.previewAt(t), skipAt: (t) => (this.silence ? this.silence.skipAt(t) : null),
    }, this.d.child());
    this.quality = new QualityController({
      prefs: this.prefs, onChange: () => { if (this.menus) this.menus.refresh(); }, savePrefs, sources: this.sources, dual: this.dual,
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
    const notesReady = () => !!(this.notes && this.notesReady);
    this.menus = new MenuBar({
      $, root: this.root, pops: this.pops, stage: this.stage, video: this.video, prefs: this.prefs, savePrefs, cc: this.cc, toast,
      cues: () => this.cues || [], screenVideo: () => this.screenVideo(), title: this.lesson.title, duration: () => this.duration(),
      diagnostics: () => diagnosticsText(this),
      layouts: () => this.layoutChoices(), layout: () => this.layout, setLayout: (l) => this.setLayout(l), swap: () => this.swapViews(),
      pdfMode: () => this.pdfMode, setTheme: (t) => this.setTheme(t),
      // Optional features add their pages and actions once they have started.
      pages: this.menuPages = { quality: () => this.quality.items(), audio: null, silence: null },
      values: this.menuValues = { quality: () => this.quality.value(), audio: () => '', silence: () => '' },
      actions: this.menuActions = {
        bookmark: (e) => { if (notesReady()) this.notes.addBookmark(e); },
        popout: PopoutController.supported() ? () => this.popout.toggle() : null,
        loopA: () => this.loop.setA(this.video.currentTime), loopB: () => this.loop.setB(this.video.currentTime),
        loopClear: () => this.loop.clear(), loopLabel: () => (this.loop ? this.loop.label() : tr('loopNone')),
        exportNotes: null, showKeys: () => this.keys.showHelp(true), original: () => this.opts.onFallback('user'),
      },
    }, this.d.child());
    this.menus.captionsAvailable(tr('captionsLoading'));
    this.volumeCtl = new VolumeControl({ $, video: this.video }, this.d.child());
    this.speed = new SpeedControl({ $, pops: this.pops, rate: () => this.video.playbackRate || this.prefs.rate, setRate: (r) => this.setRate(r) }, this.d.child());
    this.keys = new KeyboardShortcuts({ $, isDestroyed, wake: () => this.wake(), actions: this.keyActions() }, this.d.child());
    this.popout = new PopoutController({
      $, host: this.host, video: this.video, title: this.lesson.title, onKey: this.keys.onKey, isDestroyed, toast,
      relayout: () => { this.quality.apply(); this.redrawPdf(); this.render(true); this.menus.fitBar(); this.pops.place(); },
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
      volumeBy: (dv) => this.volumeCtl.by(dv, true),
      toggleMute: () => { v.muted = !v.muted; },
      fullscreen: () => this.toggleFullscreen(),
      swap: () => this.swapViews(),
      captions: () => {
        const why = unavailableReason(this.$('.ccbtn'));
        if (why) this.toast(why); else this.menus.setCaptions(!this.cc.on);
      },
      transcript: () => (this.sidebar.has('transcript') ? this.sidebar.toggle('transcript') : false),
      bookmark: (a, e) => (notesReady() ? this.notes.addBookmark(e) : false),
      flag: () => (notesReady() && this.notes.canFlag ? this.notes.flagByKey() : false),
      tag: (a, e) => (notesReady() ? this.notes.tagHere(e) : false),
      copyFrame: () => this.menus.copyFrame(),
      copyCaptions: () => this.menus.copyCaptions(),
      escape: () => {
        if (this.menus.diagnosticsOpen) this.menus.showDiagnostics(false);
        else if (this.keys.helpOpen) this.keys.showHelp(false);
        else if (this.pops.isOpen()) this.pops.close(true);
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
      this.setButton('.play', 'pause', tr('pause'), tr('pauseKey'));
      if (this.reporter) this.reporter.onPlay();
      this.armIdle();
    });
    on('pause', () => {
      if (this.audio) this.audio.syncTimer();
      stage.classList.add('paused');
      this.setButton('.play', 'play', tr('play'), tr('playKey'));
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
    on('ratechange', () => this.speed.render(v.playbackRate));
    on('volumechange', () => {
      this.volumeCtl.render();
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

  setButton(sel, icon, label, tip) {
    const b = this.$(sel);
    b.innerHTML = svg(icon);
    b.setAttribute('aria-label', label);
    b.dataset.tip = tip;
  }

  savePrefs() {
    clearTimeout(this.prefsTimer);
    this.prefsTimer = setTimeout(() => store.set('prefs', this.prefs), 300);
  }

  savePosition(pos) {
    store.set('pos:' + this.lesson.id, { t: pos === undefined ? this.clock.position() : pos, at: Date.now() });
  }

  duration() {
    return mediaDuration(this.video, this.lesson);
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
      if (!this.video.paused && !this.ui.dragging && !this.pops.isOpen()) this.stage.classList.add('idle');
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
    d.listen($('.fs'), 'click', () => this.toggleFullscreen());
    d.listen($('.swapdot'), 'click', (e) => { e.stopPropagation(); this.swapViews(); });
    d.listen($('.layout'), 'click', () => this.setLayout(this.nextLayout()));
    d.listen(document, 'fullscreenchange', () => {
      const fs = !!document.fullscreenElement;
      this.setButton('.fs', fs ? 'exitFullscreen' : 'fullscreen', tr(fs ? 'exitFullscreen' : 'fullscreen'), tr(fs ? 'exitFullscreenKey' : 'fullscreenKey'));
    });
    let resizeTimer = 0;
    d.add(() => clearTimeout(resizeTimer));
    d.listen(window, 'resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(guard(() => { this.quality.apply(); this.redrawPdf(); }), 500); });
    for (const chip of this.all('.top [data-open]')) d.listen(chip, 'click', () => this.sidebar.toggle(chip.dataset.open));
    d.listen($('.panelclose'), 'click', () => this.sidebar.close());
    d.listen($('.bmbtn'), 'click', (e) => { if (this.notes) this.notes.addBookmark(e); });
    d.listen($('.pextras button'), 'click', () => this.opts.onFallback('extras'));
    this.bindPanelResize();
    this.loop = new ABLoop({
      pops: this.pops, rail: $('.seek'), video: v, duration: () => this.duration(), seek: (t) => this.seek(t), toast: (...a) => this.toast(...a),
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
    d.listen(this.stage, 'pointerleave', (e) => {
      // Touch ends with pointerleave even when the finger was lifted inside the player.
      // Keep the controls until the idle timer expires so the next tap can pause.
      if (e.pointerType !== 'touch' && !v.paused) this.stage.classList.add('idle');
    });
  }

  // ---- captions and transcript ----

  loadCues() {
    this.cues = null;
    const none = () => { if (!this.destroyed) this.menus.captionsAvailable(tr('captionsNone')); };
    if (!this.opts.fetchCues) { none(); if (this.silence) this.silence.start([]); return; }
    this.opts.fetchCues(this.lesson).then((cues) => {
      if (this.destroyed) return;
      if (this.silence) this.silence.start(cues);
      if (!cues.length) { none(); return; }
      this.cues = cues;
      if (this.slidesPane) this.slidesPane.invalidate();
      if (this.reporter) this.reporter.captionsAvailable = cues.length;
      this.cc.setCues(cues);
      this.transcript.setCues(cues);
      this.menus.captionsAvailable('');
      if (this.prefs.captions) this.menus.setCaptions(true, true);
      this.registerTab('transcript', this.transcript);
    }, (e) => { none(); log.warn('captions:', e && e.message ? e.message : e); });
  }

  // ---- audio processing ----

  setupAudio() {
    const a = new AudioChain(this.video);
    this.audio = a;
    this.d.add(() => a.dispose());
    a.settings = { level: !!this.prefs.audio.level, voice: !!this.prefs.audio.voice, mono: !!this.prefs.audio.mono };
    const why = () => (a.reason === 'noWebAudio' ? tr('audioNoWebAudio') : a.reason ? tr('audioNativeHls') : '');
    // The settings page: one switch per tool (shown off, with the reason, when unsupported).
    this.menuPages.audio = () => [['level', 'audioLevel'], ['voice', 'audioVoice'], ['mono', 'audioMono']].map(([k, label]) => ({
      kind: 'toggle', label: tr(label), desc: tr(label + 'Desc'), reason: why, on: () => !!a.settings[k],
      set: (on) => {
        a.build();
        a.resume();
        a.set({ [k]: !!on });
        this.prefs.audio = Object.assign({}, a.settings, { levelChosen: this.prefs.audio.levelChosen || k === 'level' });
        this.savePrefs();
      },
    }));
    this.menuValues.audio = () => (!a.reason && a.anyOn() ? tr('on') : tr('off'));
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
    const status = a.reason === 'saveData' && !a.chapters.length ? tr('slidesSaveData')
      : !a.chapters.length && (a.state === 'done' || a.state === 'unavailable') ? tr('slidesNone')
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
    return thumbUrlOf(set, pick);
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
    for (const chip of this.all('.top [data-open]')) chip.setAttribute('aria-pressed', String(sb.visible(chip.dataset.open)));
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
      this.menus.fitBar();
      this.menuActions.exportNotes = () => this.notes.openExport();
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

  // The "Didn't understand" button in the Notes tab follows the part playing.
  renderFlagButton() {
    if (this.notes && this.notesReady) this.notes.renderFlagRow();
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
    const setWidth = (w) => {
      this.prefs.panelw = w;
      this.app.style.setProperty('--panelw', w + 'px');
    };
    onDrag(this.d, handle, {
      start: (e) => {
        if (e.button !== 0) return null;
        handle.setPointerCapture(e.pointerId);
        return { rect: this.app.getBoundingClientRect(), from: this.prefs.panelw };
      },
      move: (e, st) => setWidth(Math.round(clamp(st.rect.right - e.clientX, 260, Math.min(640, st.rect.width * 0.6)))),
      done: () => this.savePrefs(),
      cancel: (st) => setWidth(st.from),
    });
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
      b.className = primary ? 'pbtn primary' : 'pbtn';
      b.addEventListener('click', fn);
      wrap.appendChild(b);
    }
    box.hidden = false;
    wrap.firstChild.focus({ preventScroll: true });
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
