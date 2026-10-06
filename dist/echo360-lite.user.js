// ==UserScript==
// @name         Echo360 Lite Player
// @namespace    echo360-lite
// @version      0.10.0
// @description  Replaces the Echo360 lecture player with a lightweight native player (far lower CPU use). Falls back to the original player automatically if anything is not recognised.
// @license      MIT
// @match        https://echo360.net.au/lesson/*
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// ==/UserScript==

/* global Hls */
(function () {
  'use strict';

  const VERSION = '0.10.0';

// ---- 00-util.js ----
// ===================================================================================
// Utilities
// ===================================================================================

const TAG = '[Echo360 Lite]';
const NS = 'echo360lite:';
const HlsLib = typeof Hls !== 'undefined' ? Hls : window.Hls;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(NS + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  },
};

function fmtTime(sec, withHours) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0 || withHours) return h + ':' + String(m).padStart(2, '0') + ':' + ss;
  return m + ':' + ss;
}

function parseIsoDuration(s) {
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s || '');
  if (!m) return NaN;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Unexpected errors in our own handlers end up here. The bootstrap installs a handler that
// hands the page back to the original player (it runs at most once).
const unexpected = { handler: null };

function reportUnexpected(err) {
  console.error(TAG, 'unexpected error', err);
  const h = unexpected.handler;
  unexpected.handler = null;
  if (h) { try { h(err); } catch (e) { /* ignore */ } }
}

function guard(fn) {
  return function guarded() {
    try {
      return fn.apply(this, arguments);
    } catch (e) {
      reportUnexpected(e);
      return undefined;
    }
  };
}

// Owns every timer, listener, observer and child resource of a component so that one
// dispose() call releases all of them (used when switching recordings and when handing
// over to the original player). Listener and timer callbacks are wrapped with guard().
class Disposer {
  constructor() {
    this.fns = [];
    this.disposed = false;
  }

  add(fn) {
    if (this.disposed) { try { fn(); } catch (e) { /* ignore */ } return fn; }
    this.fns.push(fn);
    return fn;
  }

  listen(target, type, fn, opts) {
    const g = guard(fn);
    target.addEventListener(type, g, opts);
    this.add(() => target.removeEventListener(type, g, opts));
    return g;
  }

  interval(fn, ms) {
    const id = setInterval(guard(fn), ms);
    this.add(() => clearInterval(id));
    return id;
  }

  timeout(fn, ms) {
    const id = setTimeout(guard(fn), ms);
    this.add(() => clearTimeout(id));
    return id;
  }

  observe(observer) {
    this.add(() => observer.disconnect());
    return observer;
  }

  child() {
    const d = new Disposer();
    this.add(() => d.dispose());
    return d;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const fns = this.fns.splice(0);
    for (let i = fns.length - 1; i >= 0; i--) {
      try { fns[i](); } catch (e) { console.warn(TAG, 'dispose failed', e); }
    }
  }
}

// Coalesces repeated render requests into at most one call per animation frame.
// Nothing is scheduled while the page is hidden; callers re-render on visibility change.
class FrameTask {
  constructor(fn) {
    this.fn = fn;
    this.id = 0;
    this.run = () => { this.id = 0; this.fn(); };
  }

  request() {
    if (this.id || document.hidden) return;
    this.id = requestAnimationFrame(this.run);
  }

  cancel() {
    if (this.id) cancelAnimationFrame(this.id);
    this.id = 0;
  }
}

// ---- 01-i18n.js ----
// ===================================================================================
// User-facing strings. English only for now; other languages are added in the release
// milestone by adding a table here and choosing it from navigator.language.
// ===================================================================================

const STRINGS = {
  en: {
    back: 'Back to course',
    originalPlayer: 'Original player',
    originalPlayerTitle: 'Switch back to the Echo360 player',
    seek: 'Playback position',
    play: 'Play (Space)',
    pause: 'Pause (Space)',
    rewind: 'Back 10 seconds (J)',
    forward: 'Forward 10 seconds (L)',
    mute: 'Mute (M)',
    volume: 'Volume',
    swapViews: 'Swap views (S)',
    layout: 'Layout',
    layoutSide: 'Side by side',
    layoutPip: 'Picture in picture',
    layoutSingle: 'Single view',
    resizeViews: 'Drag to resize the views',
    pipHint: 'Drag to move, click to swap views',
    resizePip: 'Drag to resize',
    secondViewLost: 'The second view could not be loaded and was hidden.',
    captions: 'Captions',
    captionsKey: 'Captions (C)',
    showCaptions: 'Show captions',
    hideCaptionsPaused: 'Hide while paused',
    copy: 'Copy',
    copyFrame: 'Copy the picture',
    copyFrameDesc: 'The screen view at full resolution (or the main view), ready to paste.',
    copyCaptions: 'Copy what was just said',
    copyCaptionsDesc: 'The last part of the transcript in whole sentences, with the lecture name and times. Handy for asking an AI about it.',
    copyCaptionsSpan: 'How much to copy',
    copiedFrame: 'Picture copied ({w} × {h})',
    copiedCaptions: 'Copied {from}–{to} of the transcript',
    copyFailed: 'Could not copy ({msg})',
    copyNoCaptions: 'This recording has no transcript to copy.',
    pausedHint: 'Paused',
    captionSize: 'Text size',
    on: 'On',
    off: 'Off',
    transcript: 'Transcript',
    transcriptKey: 'Transcript (T)',
    closePanel: 'Close',
    resizePanel: 'Drag to resize',
    searchTranscript: 'Search transcript',
    prevMatch: 'Previous match (Shift+Enter)',
    nextMatch: 'Next match (Enter)',
    searchCount: '{n} found',
    searchPos: '{i} / {n}',
    backToCurrent: 'Back to current',
    notes: 'Notes',
    discussion: 'Discussion',
    sidebarTabs: 'Side panel',
    addNotePlaceholder: 'Write a private note at {time}',
    addNote: 'Add note',
    notesPrivate: 'Notes and bookmarks are private to you. Your instructor can see your "didn\'t understand" marks.',
    filterAll: 'All',
    filterNotes: 'Notes',
    filterBookmarks: 'Bookmarks',
    filterFlags: 'Didn\'t understand',
    noNotes: 'Nothing here yet. Add a note, a bookmark (B) or mark a part you didn\'t understand (U).',
    bookmark: 'Bookmark',
    bookmarkKey: 'Bookmark this moment (B)',
    bookmarkedAt: 'Bookmarked at {time}',
    undo: 'Undo',
    flag: 'Didn\'t understand',
    flagKey: 'Mark this part as not understood (U)',
    flagAdded: 'Marked {time} as not understood',
    flagRemoved: 'Removed the mark at {time}',
    edit: 'Edit',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    confirmDelete: 'Delete?',
    remove: 'Remove',
    saveFailed: 'Could not save: {error}',
    loadFailed: 'Could not load: {error}',
    publicWarning: 'Posts and replies are visible to your instructors and classmates.',
    postPlaceholder: 'Ask a question or comment on this lecture',
    linkTime: 'Link to {time}',
    hideName: 'Hide my name',
    postPublic: 'Post',
    replyPublic: 'Reply',
    replyPlaceholder: 'Write a reply',
    replies: '{n} replies',
    oneReply: '1 reply',
    hideReplies: 'Hide replies',
    like: 'Like',
    unlike: 'Unlike',
    savePost: 'Save for later (only you see this)',
    unsavePost: 'Remove from saved',
    anonymous: 'Anonymous',
    you: 'You',
    instructor: 'Instructor',
    ta: 'Teaching assistant',
    noPosts: 'No posts yet.',
    hiddenPosts: '{n} posts are hidden by your instructor.',
    attachment: 'Has an attachment',
    openInOriginal: 'Open in the original player',
    refresh: 'Refresh',
    sortNewest: 'Newest first',
    sortVideoTime: 'By video time',
    charsLeft: '{n} characters left',
    tooLong: 'Too long by {n} characters',
    extrasNotice: 'This recording has {what}. Open it in the original player to use them.',
    extraPolls: 'polls',
    extraSlides: 'slides',
    extraAudioDescription: 'an audio description track',
    markerNote: 'Note',
    markerBookmark: 'Bookmark',
    markerFlag: 'Didn\'t understand',
    markerComment: 'Post',
    audio: 'Audio',
    audioLevel: 'Even out volume',
    audioLevelDesc: 'Brings quiet speech up and keeps loud parts in check. Helps when the lecturer had no microphone.',
    audioVoice: 'Clearer voice',
    audioVoiceDesc: 'Cuts low hum from air conditioning and fans and lifts speech.',
    audioMono: 'Mono',
    audioMonoDesc: 'Plays both channels on both sides (for recordings that are only on one side).',
    quality: 'Quality',
    qualityAuto: 'Auto',
    qualityAutoBest: 'Auto (highest the network allows)',
    qualityScreen: 'Screen',
    qualityCamera: 'Camera',
    qualityNow: 'playing {q}',
    slides: 'Slides',
    slidesKey: 'Slides (Shift+\u2190 / Shift+\u2192: previous / next)',
    slideN: 'Slide {n}',
    slidesFinding: 'Finding slide changes: {pct}%',
    slidesRough: 'Approximate times from preview pictures. Finding exact changes: {pct}%',
    slidesFound: '{n} slides, found automatically from the screen recording.',
    addSlides: 'Add the slide PDF…',
    addMoreSlides: 'Add another PDF…',
    slidesLocal: 'Add the lecturer\'s slide PDF to read along: it turns to the page being talked about. The file stays on this device.',
    removeFile: 'Remove {name}',
    deckLoading: 'Opening the slide files…',
    deckReading: 'Reading the slides on screen: {pct}%',
    deckWaiting: 'Waiting to find the screen view…',
    deckError: 'Could not read the slide file ({msg}).',
    prevPage: 'Previous page',
    nextPage: 'Next page',
    pageOfN: 'Page {n} of {total}',
    following: 'Following the lecture',
    followingUnsure: 'Following the lecture (page not recognised here; showing the last one found)',
    followingStale: 'Following the lecture: the current page has not been recognised for a while',
    pageNotRecognised: 'Current page not recognised',
    followingShort: 'Following',
    followingUnsureShort: 'Following (last page found)',
    followingStaleShort: 'Page not recognised',
    backToLectureShort: 'Back to the lecture',
    pdfMainOpen: 'Show the PDF next to the video',
    pdfMainClose: 'Close the PDF view',
    pdfSwap: 'Swap the PDF and the video',
    backToLecture: 'Back to the page being talked about',
    shownAt: 'On screen at',
    notFoundInRecording: 'Not found in the recording.',
    wrongPage: 'Wrong page?',
    useThisPage: 'Show page {n} for the part playing now',
    markNotSlide: 'The part playing now is not a slide',
    undoCorrection: 'Undo my correction here',
    showChapters: 'Show the {n} chapters',
    hideChapters: 'Hide chapters',
    dropSlides: 'Drop the slide PDF here. It stays on this device.',
    dropNotPdf: 'Only PDF files can be added as slides.',
    silence: 'Silence',
    silenceAuto: 'Skip silence automatically',
    silenceAutoDesc: 'Jumps over long pauses (breaks, group work). Off: a button offers to skip.',
    silenceMin: 'Shortest silence to mark',
    silenceSensitivity: 'Sensitivity',
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    silenceFromTranscript: 'From the transcript: {n} silent stretches, {time} in total.',
    silenceFound: '{n} silent stretches, {time} in total.',
    silenceNone: 'No silence of {min} or longer.',
    silenceAnalysing: 'Analysing the audio: {pct}% done.',
    silenceWaiting: 'Looking for silence\u2026',
    silenceUnavailable: 'Silence detection is not available for this recording.',
    silenceSaveData: 'Silence detection is off while Data Saver is on.',
    silenceTip: 'silence {time}',
    skipSilence: 'Skip silence ({time}) \u203a',
    skippedSilence: 'Skipped {time} of silence',
    audioNoWebAudio: 'Audio processing is not available in this browser.',
    audioNativeHls: 'Audio processing needs Media Source Extensions, which this browser is not using for this video.',
    speed: 'Playback speed',
    fullscreen: 'Full screen (F)',
    resumedAt: 'Resumed at {time}',
    startOver: 'Start over',
    authExpiredTitle: 'Playback access expired',
    authExpiredText: 'Echo360\'s video access has expired. Reload the page to continue from where you are.',
    reload: 'Reload',
    useOriginal: 'Use the original player',
    playbackFailedTitle: 'Playback failed',
    playbackFailedText: 'The video could not be loaded ({detail}). You can retry or switch to the original player.',
    retry: 'Retry',
    close: 'Close',
    errorNotice: 'Echo360 Lite ran into an unexpected error and switched to the original player (with the CPU fix enabled).',
    fallbackNotice:'Echo360 Lite could not take over this page, so the original player is being used (with the CPU fix enabled).',
  },
};

const LANG = 'en';

function t(key, vars) {
  let s = (STRINGS[LANG] && STRINGS[LANG][key]) || STRINGS.en[key] || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

// ---- 10-adapter-echo360.js ----
// ===================================================================================
// Site adapters. Everything that knows about a particular Echo360 deployment lives here;
// the player only sees the normalised "lesson" object returned by parse().
//
// Adapter interface:
//   id                       string
//   matches()                -> boolean, is this page handled by the adapter
//   intercept(onBoot)        install hooks; call onBoot(arg, callOriginal) when the page
//                            would start its own player
//   parse(arg)               -> lesson (throws if the page is not understood)
//   withStartTime(arg, sec)  -> arg with the resume point moved (for handing over)
// ===================================================================================

const echo360ClassroomAdapter = {
  id: 'echo360-classroom',

  matches() {
    return /(^|\.)echo360\.[a-z.]+$/.test(location.hostname) && /^\/lesson\//.test(location.pathname);
  },

  // The page bootstraps its React player with an inline call
  //   Echo["echoPlayerV2FullApp"]("<json>")
  // once the document is complete. We trap that property so we receive the JSON and can
  // decide whether the original function ever runs.
  intercept(onBoot) {
    const NAME = 'echoPlayerV2FullApp';
    let original = null;
    let echo = window.Echo;

    function launcher(arg) {
      const self = this;
      return onBoot(arg, (a) => (original ? original.call(self, a) : undefined));
    }
    function getter() { return original ? launcher : undefined; }
    function setter(fn) { original = fn; }
    function trap(obj) {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      const d = Object.getOwnPropertyDescriptor(obj, NAME);
      if (d && d.get === getter) return;
      if (d && typeof d.value === 'function') original = d.value;
      Object.defineProperty(obj, NAME, { configurable: true, enumerable: true, get: getter, set: setter });
    }

    if (!echo) echo = {};
    trap(echo);
    Object.defineProperty(window, 'Echo', {
      configurable: true,
      enumerable: true,
      get() { return echo; },
      set(v) { echo = v; trap(v); },
    });
  },

  withStartTime(arg, sec) {
    const cfg = typeof arg === 'string' ? JSON.parse(arg) : Object.assign({}, arg);
    cfg.startTimeMillis = Math.max(0, Math.round(sec * 1000));
    return typeof arg === 'string' ? JSON.stringify(cfg) : cfg;
  },

  parse(arg) {
    const cfg = typeof arg === 'string' ? JSON.parse(arg) : arg;
    const video = cfg && cfg.video;
    if (!video || !Array.isArray(video.playableMedias)) throw new Error('video.playableMedias missing');
    if (video.playableMedias.some((m) => m && m.isLive)) throw new Error('live lessons are not supported');
    const cr = cfg.copyrightData;
    if (cr && cr.enforceCopyrightAcknowledgement && !cr.copyrightAcknowledged) {
      throw new Error('copyright acknowledgement required (handled by the original player)');
    }

    const bySource = new Map();
    for (const m of video.playableMedias) {
      if (!m || !m.isHls || typeof m.uri !== 'string') continue;
      const kind = (m.trackType || []).join('+');
      const s = bySource.get(m.sourceIndex) || {};
      if (kind === 'Audio+Video') s.av = m.uri;
      else if (kind === 'Video') s.v = m.uri;
      bySource.set(m.sourceIndex, s);
    }
    const posters = new Map((video.posterMedia || []).map((p) => [p.sourceIndex, p.uri]));
    const sources = [...bySource.entries()]
      .filter(([, s]) => s.av || s.v)
      .sort((a, b) => a[0] - b[0])
      .map(([index, s], i) => ({ index, n: i + 1, av: s.av || null, v: s.v || null, poster: posters.get(index) || null }));
    if (!sources.some((s) => s.av)) throw new Error('no audio+video HLS stream');

    const duration = parseIsoDuration(video.duration);
    const sectionId = cfg.sectionInfo && cfg.sectionInfo.section && cfg.sectionInfo.section.id;
    const ctx = cfg.context || {};
    const hostMatch = location.hostname.match(/echo360.+/);

    let analytics = null;
    if (cfg.sessionId && video.mediaId && hostMatch) {
      analytics = {
        gatewayUrl: location.protocol + '//api.' + hostMatch[0],
        appUrl: location.origin,
        sessionId: cfg.sessionId,
        mediaId: video.mediaId,
        context: {
          course_id: ctx.courseId, department_id: ctx.departmentId, group_id: ctx.groupId,
          lesson_id: ctx.lessonId, lti_id: ctx.ltiId, organization_id: ctx.organizationId,
          section_id: ctx.sectionId, term_id: ctx.termId,
        },
        link: { lti: ctx.ltiId, public: ctx.publicLinkId, secure: ctx.secureLinkId, secure_data: ctx.secureLinkAccessDataId },
        user: cfg.user ? { id: cfg.user.id, role: cfg.user.currentRole } : undefined,
      };
    }

    const lessonId = cfg.lesson && cfg.lesson.id;
    return {
      id: video.mediaId || lessonId || location.pathname,
      lessonId,
      sectionId: ctx.sectionId || sectionId || null,
      userId: cfg.user ? cfg.user.id : null,
      isAnonymousUser: !cfg.user || cfg.user.currentRole === 'Anonymous',
      mediaId: video.mediaId,
      transcriptUrl: lessonId && video.mediaId
        ? '/api/ui/echoplayer/lessons/' + encodeURIComponent(lessonId) + '/medias/' + encodeURIComponent(video.mediaId) + '/transcript'
        : null,
      title: cfg.title || (cfg.lesson && cfg.lesson.name) || document.title,
      backUrl: sectionId ? '/section/' + encodeURIComponent(sectionId) + '/home' : null,
      duration: isFinite(duration) ? duration : NaN,
      resumeAt: typeof cfg.startTimeMillis === 'number' ? cfg.startTimeMillis / 1000 : null,
      sources,
      captionsUrl: typeof cfg.captions === 'string' && cfg.captions ? cfg.captions : null,
      thumbnails: Array.isArray(video.thumbnailMedia) ? video.thumbnailMedia : [],
      // Content only the original player can show; we point users there instead.
      extras: {
        polls: Array.isArray(cfg.polls) && cfg.polls.length > 0,
        slides: !!(cfg.slides && cfg.slides.slideDeck),
        audioDescription: Array.isArray(video.audioDescriptions) && video.audioDescriptions.length > 0,
      },
      analytics,
    };
  },
};

// Transcript cues as [{ start, end, text, speaker }] (seconds), sorted by start. Uses the
// transcript API (same cues as the captions, with speaker labels) and falls back to the
// WebVTT captions file. Resolves to [] when the recording has neither.
echo360ClassroomAdapter.fetchCues = function (lesson) {
  const fromTranscript = () => {
    if (!lesson.transcriptUrl) return Promise.reject(new Error('no transcript url'));
    return fetch(lesson.transcriptUrl, { credentials: 'include', headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('transcript HTTP ' + r.status))))
      .then((j) => {
        const raw = j && j.data && j.data.contentJSON && j.data.contentJSON.cues;
        if (!Array.isArray(raw) || !raw.length) throw new Error('empty transcript');
        return raw
          .filter((c) => typeof c.startMs === 'number' && typeof c.content === 'string' && c.content.trim())
          .map((c) => ({ start: c.startMs / 1000, end: (typeof c.endMs === 'number' ? c.endMs : c.startMs + 3000) / 1000, text: c.content.trim(), speaker: c.speaker || '' }));
      });
  };
  const fromVtt = () => {
    if (!lesson.captionsUrl) return [];
    return fetch(lesson.captionsUrl)
      .then((r) => (r.ok ? r.text() : ''))
      .then(parseVtt);
  };
  return fromTranscript()
    .catch(() => fromVtt())
    .then((cues) => cues.sort((a, b) => a.start - b.start))
    .catch(() => []);
};

function parseVttTime(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
  if (!m) return NaN;
  return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

// Minimal WebVTT parser: cue timing lines plus text, NOTE blocks and tags removed.
function parseVtt(text) {
  const cues = [];
  const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseVttTime(a);
    const end = parseVttTime(b);
    if (!isFinite(start) || !isFinite(end)) continue;
    let speaker = '';
    const body = lines.slice(ti + 1).join(' ').replace(/<v\s+([^>]*)>/g, (m, who) => { speaker = who.trim(); return ''; })
      .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (body) cues.push({ start, end, text: decodeEntities(body), speaker });
  }
  return cues;
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&nbsp;/g, ' ');
}

const ADAPTERS = [echo360ClassroomAdapter];

// ---- 11-echo360-api.js ----
// ===================================================================================
// Echo360 data API (notes, bookmarks, "didn't understand" flags, discussions).
//
// Reads return normalised objects:
//   Note    { id, type: 'note' | 'bookmark', time (s) | null, text, createdAt }
//   Flag    { id, type: 'flag', time (s, start of its 30 s scene), createdAt }
//   Comment { id, questionId | null, body, time (s) | null, authorId, author, nameHidden,
//             instructor, ta, mine, likes, liked, saved, hasAttachment, createdAt,
//             updatedAt, replies: Comment[] }
//
// Every write takes the user event that caused it and refuses to run without a trusted
// one, so nothing is ever written to Echo360 without an explicit user action.
//
// Dry run (development): localStorage "echo360lite:dryRun" = "public" or "all". Matching
// writes are fully built but only recorded (console + window.__echo360LiteDryRun), never
// sent. Public = visible to the instructor or the class (discussion, likes, saves, flags).
// ===================================================================================

class ApiError extends Error {
  constructor(status, message) {
    super(message || ('HTTP ' + status));
    this.status = status;
  }
}

// Path segment as the original player builds it: Echo360 ids are used verbatim (they
// contain ':' and '.'), only characters that would break the URL are escaped.
function seg(id) {
  return String(id).replace(/[^\w.:~-]/g, encodeURIComponent);
}

// Same thumbnail choice as the original player: first thumbnail set, the last image taken
// strictly before the referenced moment, else the first one; '' without thumbnails.
function thumbnailFor(thumbnails, ms) {
  const set = thumbnails && thumbnails[0];
  if (!set || !Array.isArray(set.timesInSeconds) || !set.timesInSeconds.length) return '';
  const r = Number(ms) / 1000;
  let pick = set.timesInSeconds.slice().reverse().find((x) => x < r);
  if (pick === undefined) pick = set.timesInSeconds[0];
  return set.baseUri + '/' + pick + '.' + set.extension;
}

function requireGesture(ev) {
  if (!ev || ev.isTrusted !== true) throw new Error('write refused: not triggered by a user action');
}

const FLAG_SCENE_SECONDS = 30;

class Echo360Api {
  constructor(lesson) {
    this.l = lesson;
    const mode = store.get('dryRun', false);
    this.dryRun = mode === 'all' || mode === 'public' ? mode : false;
  }

  async request(method, path, body) {
    const opts = { method, credentials: 'include', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(path, opts);
    let j = null;
    try { j = await r.json(); } catch (e) { /* empty body */ }
    if (!r.ok || (j && j.status === 'ko')) throw new ApiError(r.status, j && j.message);
    return j && 'data' in j ? j.data : j;
  }

  // visibility: 'private' (only the user) or 'public' (instructor and/or class).
  write(ev, visibility, method, path, body) {
    requireGesture(ev);
    if (this.dryRun === 'all' || (this.dryRun === 'public' && visibility === 'public')) {
      const rec = { method, url: new URL(path, location.origin).href, body: body === undefined ? null : JSON.stringify(body), visibility };
      (window.__echo360LiteDryRun = window.__echo360LiteDryRun || []).push(rec);
      console.info(TAG, 'DRY RUN (not sent):', method, rec.url, rec.body || '');
      return Promise.resolve(dryRunResult(method, path, body));
    }
    return this.request(method, path, body);
  }

  // ---- notes and bookmarks (private) ----

  async notes() {
    const data = await this.request('GET', '/api/ui/lesson/' + seg(this.l.lessonId) + '/notes/content');
    return (data || []).filter((x) => x && x.note).map((x) => {
      const ts = x.videoContentRef && x.videoContentRef.content && x.videoContentRef.content.timestamp;
      return {
        id: x.note.id,
        type: x.note.bookmark ? 'bookmark' : 'note',
        time: typeof ts === 'number' ? Math.floor(ts) / 1000 : null,
        text: x.note.bookmark ? '' : (x.note.text || ''),
        createdAt: x.note.createdAt,
      };
    });
  }

  async addNote(ev, { text, time, bookmark, num }) {
    const body = { bookmark: !!bookmark, lessonId: this.l.lessonId, num: num || 1, text: bookmark ? 'bookmark' : text };
    if (time != null && this.l.mediaId) body.videoRef = { timestamp: Math.trunc(time * 1000), type: 'Video', videoId: this.l.mediaId };
    const data = await this.write(ev, 'private', 'POST', '/notes', body);
    const created = Array.isArray(data) ? data[0] : data;
    return {
      id: created && created.id,
      type: bookmark ? 'bookmark' : 'note',
      time: time != null ? Math.trunc(time * 1000) / 1000 : null,
      text: bookmark ? '' : text,
      createdAt: (created && created.createdAt) || new Date().toISOString(),
    };
  }

  updateNote(ev, note, text) {
    return this.write(ev, 'private', 'PUT', '/notes/' + seg(note.id), { bookmark: note.type === 'bookmark', text });
  }

  deleteNote(ev, note) {
    return this.write(ev, 'private', 'DELETE', '/notes/' + seg(note.id));
  }

  // ---- "didn't understand" flags (seen by the instructor as counts per 30 s scene) ----

  async flags() {
    const data = await this.request('GET', '/lesson/' + seg(this.l.lessonId) + '/video/' + seg(this.l.mediaId) + '/confusedV2');
    return (data || []).filter((x) => x && typeof x.sceneId === 'number').map((x) => ({
      id: 'flag-' + x.sceneId,
      type: 'flag',
      time: x.sceneId * FLAG_SCENE_SECONDS,
      createdAt: x.createdAt,
    }));
  }

  addFlag(ev, time) {
    return this.write(ev, 'public', 'POST', '/section/' + seg(this.l.sectionId) + '/video_time_confused',
      { lessonId: this.l.lessonId, videoId: this.l.mediaId, time: Math.trunc(time) });
  }

  // Echo360 deletes a flag with a GET to this address (same as the original player).
  removeFlag(ev, flag) {
    return this.write(ev, 'public', 'GET', '/lesson/' + seg(this.l.lessonId) + '/video/' + seg(this.l.mediaId)
      + '/confused/' + Math.trunc(flag.time) + '/delete');
  }

  // ---- discussions (visible to the instructor and the class) ----

  discussionBase() {
    return '/api/ui/discussions/lessons/' + seg(this.l.lessonId);
  }

  async discussions() {
    const data = await this.request('GET', this.discussionBase() + '/questions');
    const qs = (data && data.questions) || [];
    return {
      hiddenCount: (data && data.hiddenCount) || 0,
      threads: qs.filter((x) => x && x.question).map((x) => {
        const q = this.mapComment(x.question, null);
        q.replies = (x.responses || []).map((r) => this.mapComment(r, q.id));
        return q;
      }),
    };
  }

  mapComment(c, questionId) {
    const first = c.authorFirstName;
    const last = c.authorLastName;
    const full = first && last ? (first + ' ' + last).trim() : '';
    const roles = Array.isArray(c.authorRoles) ? c.authorRoles : [];
    const ref = c.videoContentRef;
    const refMs = ref && (typeof ref.timestampMillis === 'number' ? ref.timestampMillis
      : ref.content && typeof ref.content.timestamp === 'number' ? ref.content.timestamp : null);
    return {
      id: c.id,
      questionId: questionId || c.questionId || null,
      body: typeof c.body === 'string' ? c.body : '',
      time: typeof refMs === 'number' ? refMs / 1000 : null,
      authorId: c.authorId,
      author: full && !c.isNameHidden ? full : '',
      nameHidden: !!c.isNameHidden || !full,
      instructor: roles.includes('Instructor'),
      ta: roles.includes('TeachingAssistant'),
      mine: !!this.l.userId && c.authorId === this.l.userId,
      likes: c.likeCount || 0,
      liked: !!c.liked,
      saved: !!c.bookmarked,
      hasAttachment: !!c.attachment,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      replies: [],
    };
  }

  postComment(ev, { body, anonymous, time }) {
    const payload = { anonymous: !!anonymous, body, contextType: 'lessons' };
    if (time != null && this.l.mediaId) {
      const ms = Math.trunc(time * 1000);
      payload.videoContentRef = { mediaId: this.l.mediaId, timestampMillis: ms, thumbnailUri: thumbnailFor(this.l.thumbnails, ms) };
    }
    return this.write(ev, 'public', 'POST', this.discussionBase() + '/questions', payload);
  }

  reply(ev, questionId, { body, anonymous }) {
    return this.write(ev, 'public', 'POST', this.discussionBase() + '/questions/' + seg(questionId) + '/responses',
      { anonymous: !!anonymous, body, contextType: 'lessons' });
  }

  commentPath(c) {
    return this.discussionBase() + '/questions/' + (c.questionId
      ? seg(c.questionId) + '/responses/' + seg(c.id)
      : seg(c.id));
  }

  like(ev, c, like) {
    return this.write(ev, 'public', 'PUT', this.commentPath(c) + '/' + (like ? 'like' : 'unlike'));
  }

  deleteComment(ev, c) {
    return this.write(ev, 'public', 'DELETE', this.commentPath(c));
  }

  // Private "save for later" on a post (only you see it).
  save(ev, c, save) {
    return this.write(ev, 'public', 'POST', '/questions/' + seg(c.id) + '/' + (save ? 'bookmark' : 'forget'));
  }
}

// Plausible responses for dry runs so the UI can continue.
function dryRunResult(method, path, body) {
  if (method === 'POST' && /\/notes$/.test(path)) return [{ id: 'dry-' + Date.now(), createdAt: new Date().toISOString() }];
  return {};
}

echo360ClassroomAdapter.api = (lesson) => new Echo360Api(lesson);

// ---- 20-reporter.js ----
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
    this.d.listen(window, 'beforeunload', onUnload);
    this.d.add(() => this.detach());
    // The original player validates the session on load; the response may carry a fresh token.
    fetch(info.appUrl + '/api/ui/sessions/' + encodeURIComponent(info.sessionId), { credentials: 'include', headers: this.headers(false) })
      .then((r) => this.saveToken(r))
      .catch(() => {});
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
    }).catch(() => {});
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

// ---- 30-ui-assets.js ----
// ===================================================================================
// UI assets: inline SVG icons, the stylesheet (injected once into the shadow root) and
// the DOM template.
// ===================================================================================

const ICON = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
  back10: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><text x="12.2" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif">10</text>',
  fwd10: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><text x="11.8" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif">10</text>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  muted: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M16 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  fullscreen: '<path d="M4 9V4.5h4.5M20 9V4.5h-4.5M4 15v4.5h4.5M20 15v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  exitFullscreen: '<path d="M8.5 4v4.5H4M15.5 4v4.5H20M8.5 20v-4.5H4M15.5 20v-4.5H20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  back: '<path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  swap: '<path d="M5 8h13l-3.5-3.5M19 16H6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  layoutSide: '<rect x="3" y="6" width="8" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="6" width="8" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  layoutPip: '<rect x="3" y="5" width="18" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="12.5" y="11.5" width="6" height="5" rx="1" fill="currentColor"/>',
  cc: '<rect x="3" y="5.5" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M16.5 10.2a2.2 2.2 0 1 0 0 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  slides: '<rect x="3.5" y="5" width="17" height="11.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 16.5v3M8.5 20h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  transcript: '<path d="M5 6.5h14M5 10.5h14M5 14.5h9M5 18.5h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  bookmarkOn: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  flag: '<path d="M6 21V4.5M6 5h11l-2.5 4 2.5 4H6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  flagOn: '<path d="M6 21V4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6 5h11l-2.5 4 2.5 4H6z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  notes: '<path d="M6 3.5h9l3 3V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 10h6M9 13.5h6M9 17h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  discussion: '<path d="M4.5 5.5h15v10h-9l-4 3.5v-3.5h-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  audio: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 5.5v-.5a1.5 1.5 0 0 0-1.5-1.5H6a1.5 1.5 0 0 0-1.5 1.5v8a1.5 1.5 0 0 0 1.5 1.5h.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  close: '<path d="M6.5 6.5l11 11m0-11l-11 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  up: '<path d="M6.5 14.5l5.5-5.5 5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  layoutSingle: '<rect x="3" y="5" width="18" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
};
const svg = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[name] + '</svg>';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483000; display: block; background: #000;
  color: #f1f1f3; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  --accent: #4f8cff; --panel: rgba(18,18,22,.92); -webkit-font-smoothing: antialiased; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
svg { width: 24px; height: 24px; display: block; }
.app { position: absolute; inset: 0; --panelw: 360px; }
.stage { position: absolute; inset: 0; overflow: hidden; --ratio: .5; --pipw: .26; }
.app.panel-open .stage { right: var(--panelw); }
.captions { position: absolute; left: 50%; bottom: 96px; z-index: 4; transform: translateX(-50%); width: max-content; max-width: min(88%, 52em);
  text-align: center; pointer-events: none; transition: bottom .2s ease; --capscale: 1; }
.captions[hidden], .captions.empty { display: none; }
.idle .captions { bottom: 28px; }
.captions span { padding: .12em .45em; border-radius: 4px; background: rgba(0,0,0,.74); color: #fff;
  font-size: calc(clamp(15px, 1.8vw, 30px) * var(--capscale)); line-height: 1.5;
  -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.panel { position: absolute; top: 0; right: 0; bottom: 0; width: var(--panelw); z-index: 5; display: flex; flex-direction: column;
  background: #131317; border-left: 1px solid rgba(255,255,255,.08); }
.panel[hidden] { display: none; }
.presize { position: absolute; left: -5px; top: 0; bottom: 0; width: 10px; cursor: col-resize; touch-action: none; }
.phead { display: flex; align-items: center; gap: 6px; padding: 10px 8px 6px 16px; font-size: 15px; font-weight: 600; }
.phead .ptitle { flex: 1; }
.psearch { display: flex; align-items: center; gap: 2px; padding: 0 8px 8px 12px; }
.tsearch { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
  background: rgba(255,255,255,.06); color: inherit; font: inherit; font-size: 13px; }
.tsearch:focus { outline: none; border-color: var(--accent); }
.tcount { min-width: 4.5em; padding: 0 4px; font-size: 12px; text-align: right; white-space: nowrap; opacity: .7; }
.psearch .btn { width: 30px; height: 30px; }
.psearch .btn svg, .phead .btn svg { width: 20px; height: 20px; }
.phead .btn { width: 32px; height: 32px; }
.tlist { flex: 1; overflow-y: auto; padding: 2px 6px 56px; overscroll-behavior: contain; }
.trow { display: flex; gap: 10px; padding: 6px 8px; border-radius: 8px; cursor: pointer; font-size: 14px; line-height: 1.45;
  content-visibility: auto; contain-intrinsic-size: auto 44px; }
.trow:hover { background: rgba(255,255,255,.06); }
.trow .ts { flex: none; width: 4.4em; padding-top: 2px; font-size: 12px; font-variant-numeric: tabular-nums; opacity: .5; }
.trow.cur { background: rgba(79,140,255,.16); }
.trow.cur .ts { color: var(--accent); opacity: 1; }
.trow.hit .tx { background: linear-gradient(transparent 62%, rgba(255,196,0,.45) 62%); }
.tback { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); height: 32px; padding: 0 14px; border-radius: 16px;
  background: var(--accent); color: #fff; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
.tback[hidden] { display: none; }
.marks { position: absolute; left: 0; right: 0; top: 3px; height: 12px; pointer-events: none; }
.marks i { position: absolute; top: 0; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px; background: #ffc400; }
.tabs { display: flex; gap: 2px; flex: 1; min-width: 0; }
.tabs button { height: 32px; padding: 0 10px; border-radius: 8px; font-size: 13px; opacity: .7; white-space: nowrap; }
.tabs button:hover { background: rgba(255,255,255,.08); opacity: 1; }
.tabs button[aria-selected=true] { background: rgba(255,255,255,.12); opacity: 1; font-weight: 600; }
.pane { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pane[data-pane=notes], .pane[data-pane=discussion] { overflow-y: auto; padding: 0 12px 16px; overscroll-behavior: contain; }
.pextras { margin: 0 12px 8px; padding: 8px 10px; border-radius: 8px; background: rgba(255,196,0,.1); font-size: 12px; line-height: 1.45; }
.pextras button { margin-top: 4px; }
.pinfo { margin: 2px 0 10px; font-size: 12px; line-height: 1.45; opacity: .6; }
.pwarn { margin-bottom: 8px; padding: 7px 10px; border-radius: 8px; background: rgba(255,170,0,.14); color: #ffd38a; font-size: 12px; line-height: 1.4; }
.composer { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.composer.reply { margin: 10px 0 0; }
.input { width: 100%; padding: 8px 10px; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; background: rgba(255,255,255,.06);
  color: inherit; font: inherit; font-size: 13px; line-height: 1.45; resize: vertical; }
.input:focus { outline: none; border-color: var(--accent); }
.input.small { width: auto; padding: 4px 8px; }
select.input option { background: #1b1b20; }
.crow, .ptools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.ptools { margin-bottom: 10px; }
.grow { flex: 1; }
.check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; opacity: .85; }
.check input { accent-color: var(--accent); }
.counter { opacity: .6; } .counter.over { color: #ff8a80; opacity: 1; }
.pbtn { height: 30px; padding: 0 12px; border-radius: 8px; background: rgba(255,255,255,.1); font-size: 13px; }
.pbtn:hover { background: rgba(255,255,255,.16); }
.pbtn.primary { background: var(--accent); color: #fff; font-weight: 600; }
.pbtn:disabled { opacity: .45; cursor: default; }
.link { font-size: 12px; opacity: .75; padding: 2px 0; }
.link:hover { opacity: 1; text-decoration: underline; }
.link.on { color: var(--accent); opacity: 1; }
.link.danger:hover { color: #ff8a80; }
.perror { margin-bottom: 10px; padding: 7px 10px; border-radius: 8px; background: rgba(255,82,82,.14); color: #ffb4ab; font-size: 12px; }
.pempty { padding: 24px 8px; text-align: center; font-size: 13px; opacity: .55; line-height: 1.5; }
.pmuted { font-size: 12px; opacity: .55; }
.plist { display: flex; flex-direction: column; gap: 8px; }
.card { padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.045); border-left: 3px solid transparent; }
.card.k-note { border-left-color: #6ea8ff; } .card.k-bookmark { border-left-color: #4fd1a5; } .card.k-flag { border-left-color: #ff6b6b; }
.ihead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.ibody { margin-top: 6px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.iactions, .cactions { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; }
.kind { font-weight: 600; } .kind.k-note { color: #9cc3ff; } .kind.k-bookmark { color: #7ee2bf; } .kind.k-flag { color: #ff9a9a; }
.chiptime { height: 22px; padding: 0 8px; border-radius: 11px; background: rgba(79,140,255,.18); color: #b9d2ff; font-size: 12px; font-variant-numeric: tabular-nums; }
.chiptime:hover { background: rgba(79,140,255,.32); }
.author { font-weight: 600; font-size: 13px; }
.badge { padding: 1px 6px; border-radius: 6px; font-size: 11px; }
.badge.inst { background: rgba(126,226,191,.16); color: #7ee2bf; }
.comment + .comment { margin-top: 10px; }
.replies { margin-top: 10px; padding-left: 12px; border-left: 2px solid rgba(255,255,255,.08); }
.comment.reply .ibody { font-size: 13px; }
.imarks { position: absolute; left: 0; right: 0; top: 0; height: 18px; pointer-events: none; }
.mk { position: absolute; top: 2px; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; box-shadow: 0 0 0 1.5px rgba(0,0,0,.6); }
.mk-note { background: #6ea8ff; }
.mk-bookmark { background: #4fd1a5; border-radius: 1px; }
.mk-flag { background: #ff6b6b; top: 1px; width: 4px; height: 8px; margin-left: -2px; border-radius: 1px; }
.mk-comment { background: #f3c969; transform: rotate(45deg); border-radius: 1px; }
.btn.flagbtn.active { color: #ff6b6b; }
.btn.bmbtn.active { color: #4fd1a5; }
.audiomenu { min-width: 260px; max-width: 320px; }
.audiomenu .opt { display: flex; flex-direction: column; align-items: stretch; gap: 2px; white-space: normal; }
.audiomenu .opt .row1 { display: flex; justify-content: space-between; gap: 16px; }
.audiomenu .opt .desc { font-size: 12px; opacity: .55; line-height: 1.35; }
.audiomenu .opt[aria-disabled=true] { opacity: .45; cursor: default; }
.audiomenu { max-height: calc(100% - 80px); overflow-y: auto; }
.qualitymenu { min-width: 200px; }
.copymenu { min-width: 260px; max-width: 320px; }
.copymenu .opt { display: flex; flex-direction: column; align-items: stretch; gap: 2px; white-space: normal; }
.copymenu .opt .row1 { display: flex; justify-content: space-between; gap: 16px; }
.copymenu .opt .key { opacity: .5; font-size: 12px; }
.copymenu .opt .desc { font-size: 12px; opacity: .55; line-height: 1.35; }
.copymenu .sub { padding: 6px 10px 0; font-size: 12px; opacity: .6; }
.copymenu .choices { display: flex; gap: 4px; padding: 4px 6px 2px; }
.copymenu .choices button { width: auto; flex: 1; text-align: center; padding: 6px 0; }
.qualitymenu .sub { padding: 8px 10px 2px; font-size: 12px; opacity: .6; }
.audiomenu .sep { height: 1px; margin: 6px 4px; background: rgba(255,255,255,.1); }
.audiomenu .silstatus { padding: 0 10px 6px; font-size: 12px; line-height: 1.4; opacity: .75; }
.audiomenu .sub { padding: 6px 10px 0; font-size: 12px; opacity: .6; }
.audiomenu .choices { display: flex; gap: 4px; padding: 4px 6px 2px; }
.audiomenu .choices button { width: auto; flex: 1; text-align: center; padding: 6px 0; }
.sils { position: absolute; inset: 0; }
.chaps { position: absolute; inset: 0; }
.chaps i { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: rgba(0,0,0,.75); }
.tip .pv { display: block; width: 176px; aspect-ratio: 16 / 9; object-fit: cover; margin: 2px 0 4px; border-radius: 4px; background: #000; }
.tip .pv[hidden] { display: none; }
.pane[data-pane=slides] { overflow-y: auto; padding: 0 12px 16px; overscroll-behavior: contain; }
.sstatus { padding: 4px 2px 8px; font-size: 12px; opacity: .65; }
.slist { display: flex; flex-direction: column; gap: 8px; }
.scard { display: flex; gap: 10px; align-items: flex-start; width: 100%; padding: 6px; border-radius: 10px; text-align: left; }
.scard:hover { background: rgba(255,255,255,.07); }
.scard.cur { background: rgba(79,140,255,.18); box-shadow: inset 0 0 0 1px rgba(79,140,255,.6); }
.scard img, .scard .noimg { flex: none; width: 128px; aspect-ratio: 16 / 9; border-radius: 6px; background: #222; object-fit: cover; }
.slist[hidden], .sstatus[hidden], .reader[hidden], .chaptoggle[hidden] { display: none; }
.reader { padding: 4px 0 8px; }
.rstage { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background: #fff; }
.rpage { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; transition: opacity .18s ease; }
.rpage.in { opacity: 1; }
.rstale { position: absolute; inset: 0; z-index: 1; display: none; align-items: center; justify-content: center; padding: 12px; text-align: center;
  font-size: 13px; font-weight: 600; color: #fff; background: rgba(20,20,24,.72); }
.stale > .rstale { display: flex; }
.pstage .rstale { z-index: 2; font-size: 15px; }
.rbar { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.rnav { width: 32px; height: 28px; border-radius: 8px; font-size: 20px; line-height: 1; }
.rnav:hover:not(:disabled) { background: rgba(255,255,255,.1); }
.rnav:disabled { opacity: .3; cursor: default; }
.rlabel { flex: 1; text-align: center; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rfollow { margin-top: 6px; text-align: center; font-size: 12px; }
.rfollowing { opacity: .55; }
.rback { padding: 5px 12px; border-radius: 14px; background: var(--accent); color: #fff; font-weight: 600; }
.rtimes { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 8px; font-size: 12px; }
.rtl { opacity: .6; margin-right: 2px; }
.rtime { padding: 2px 8px; border-radius: 10px; background: rgba(255,255,255,.1); font-variant-numeric: tabular-nums; }
.rtime:hover { background: rgba(255,255,255,.18); }
.rfix { margin-top: 8px; font-size: 12px; }
.rfix summary { cursor: pointer; opacity: .6; }
.rfix[open] summary { opacity: .9; margin-bottom: 4px; }
.rfixbtn { display: block; width: 100%; text-align: left; padding: 5px 8px; border-radius: 6px; }
.rfixbtn:hover { background: rgba(255,255,255,.08); }
.rmain { display: block; width: 100%; margin-top: 6px; padding: 5px 8px; border-radius: 8px; font-size: 12px; background: rgba(255,255,255,.08); }
.rmain:hover { background: rgba(255,255,255,.14); }
.chaptoggle { display: block; margin: 6px 0; padding: 4px 0; font-size: 12px; color: var(--accent); }
.sdeck { padding: 8px 2px 4px; border-bottom: 1px solid rgba(255,255,255,.08); margin-bottom: 6px; }
.sfiles { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sfile { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 3px 4px 3px 10px; border-radius: 14px; background: rgba(255,255,255,.1); font-size: 12px; }
.sfname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.sfremove { width: 20px; height: 20px; border-radius: 50%; font-size: 11px; opacity: .7; }
.sfremove:hover { background: rgba(255,255,255,.15); opacity: 1; }
.sfadd { padding: 4px 10px; border-radius: 14px; font-size: 12px; color: var(--accent); }
.sfadd:hover { background: rgba(79,140,255,.12); }
.sdmsg { margin-top: 6px; font-size: 12px; line-height: 1.4; opacity: .65; }
.dropzone { position: absolute; inset: 12px; z-index: 6; display: flex; align-items: center; justify-content: center; border: 2px dashed var(--accent);
  border-radius: 16px; background: rgba(10,12,20,.75); font-size: 16px; pointer-events: none; }
.dropzone[hidden] { display: none; }
.smeta { min-width: 0; flex: 1; }
.stitle { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 600; }
.stitle .st { font-weight: 400; opacity: .65; font-variant-numeric: tabular-nums; }
.ssaid { margin-top: 3px; font-size: 12px; line-height: 1.35; opacity: .7; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sils i { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(135deg, rgba(255,255,255,.55) 0 1.5px, transparent 1.5px 4px); opacity: .8; }
.skipsil { position: absolute; z-index: 5; right: 14px; bottom: 96px; height: 34px; padding: 0 14px; border-radius: 17px; background: var(--panel);
  font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.4); transition: opacity .4s ease; }
.skipsil:hover { background: #2a2a31; }
.skipsil.fade { opacity: 0; pointer-events: none; }
.audiomenu .why { padding: 4px 10px 6px; font-size: 12px; line-height: 1.4; color: #ffd38a; }
.ccmenu .opt { display: flex; justify-content: space-between; gap: 16px; }
.ccmenu .sizes { display: flex; gap: 4px; padding: 4px 6px 2px; }
.ccmenu .sizes button { width: auto; flex: 1; text-align: center; padding: 6px 0; }
.top .tbtn { display: inline-flex; align-items: center; gap: 6px; }
.top .tbtn svg { width: 18px; height: 18px; }
@media (max-width: 720px) {
  .top .chip .lbl { display: none; }
  .app.panel-open .stage { right: 0; }
  .panel { width: 100%; }
  .presize { display: none; }
}
.views { position: absolute; inset: 0; }
video, .pdfview { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
[data-slot=off] { display: none !important; }
.l-single :is(video, .pdfview)[data-slot=secondary] { display: none; }
.l-side :is(video, .pdfview)[data-slot=primary] { width: calc(var(--ratio) * 100%); }
.l-side :is(video, .pdfview)[data-slot=secondary] { left: auto; right: 0; width: calc((1 - var(--ratio)) * 100%); }
/* The lecturer's PDF as a picture of its own (see SlideReader). */
.pdfview { background: #1a1a1d; overflow: hidden; }
.pstage { position: absolute; inset: 0; }
.pstage .rpage { position: absolute; left: 50%; top: 50%; width: auto; height: auto; max-width: 100%; max-height: 100%; transform: translate(-50%, -50%); }
.pbar { position: absolute; left: 50%; top: 58px; z-index: 3; display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-radius: 16px;
  max-width: calc(100% - 16px); overflow: hidden; transform: translateX(-50%); background: rgba(18,18,22,.82); font-size: 12px; white-space: nowrap;
  transition: opacity .2s ease; }
.pfollow { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.idle .pbar { opacity: 0; pointer-events: none; }
.pnav { width: 26px; height: 24px; border-radius: 8px; font-size: 15px; line-height: 1; }
.pnav:hover:not(:disabled) { background: rgba(255,255,255,.12); }
.pnav:disabled { opacity: .3; }
.plabel { padding: 0 4px; font-variant-numeric: tabular-nums; }
.pfollow .rback { padding: 3px 10px; font-size: 12px; }
.pfollow .rfollowing { opacity: .6; padding: 0 6px; }
.l-pip .pdfview[data-slot=secondary] .pbar { display: none; }
.divider { position: absolute; top: 0; bottom: 0; left: calc(var(--ratio) * 100%); width: 16px; margin-left: -8px; cursor: col-resize; z-index: 3; display: none; touch-action: none; }
.divider::after { content: ""; position: absolute; left: 7px; top: 50%; width: 2px; height: 48px; margin-top: -24px; border-radius: 1px; background: rgba(255,255,255,.35); transition: background .15s ease; }
.divider:hover::after, .divider.dragging::after { background: var(--accent); }
.l-side .divider { display: block; }
.l-pip :is(video, .pdfview)[data-slot=secondary], .pipframe { left: auto; top: auto; width: calc(var(--pipw) * 100%); height: auto; aspect-ratio: 16 / 9; }
.l-pip :is(video, .pdfview)[data-slot=secondary] { z-index: 2; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.55); }
.pipframe { position: absolute; z-index: 3; display: none; border-radius: 10px; cursor: grab; touch-action: none; }
.pipframe.dragging { cursor: grabbing; }
.l-pip .pipframe { display: block; }
.pipframe:hover { box-shadow: inset 0 0 0 2px rgba(255,255,255,.5); }
.grip { position: absolute; width: 18px; height: 18px; opacity: 0; transition: opacity .15s ease; touch-action: none; }
.grip::before { content: ""; position: absolute; inset: 4px; border: 2px solid #fff; border-radius: 2px; }
.pipframe:hover .grip { opacity: .9; }
.l-pip.c-br :is(video, .pdfview)[data-slot=secondary], .l-pip.c-br .pipframe { right: 16px; bottom: 84px; }
.l-pip.c-bl :is(video, .pdfview)[data-slot=secondary], .l-pip.c-bl .pipframe { left: 16px; bottom: 84px; }
.l-pip.c-tr :is(video, .pdfview)[data-slot=secondary], .l-pip.c-tr .pipframe { right: 16px; top: 64px; }
.l-pip.c-tl :is(video, .pdfview)[data-slot=secondary], .l-pip.c-tl .pipframe { left: 16px; top: 64px; }
.c-br .grip { left: 0; top: 0; cursor: nwse-resize; }
.c-bl .grip { right: 0; top: 0; cursor: nesw-resize; }
.c-tr .grip { left: 0; bottom: 0; cursor: nesw-resize; }
.c-tl .grip { right: 0; bottom: 0; cursor: nwse-resize; }
.layoutmenu button { display: flex; align-items: center; gap: 10px; }
.layoutmenu svg { width: 20px; height: 20px; }
.top, .bottom { position: absolute; left: 0; right: 0; transition: opacity .2s ease; }
.top { top: 0; z-index: 4; display: flex; align-items: center; gap: 8px; padding: 10px 14px 28px;
  background: linear-gradient(rgba(0,0,0,.72), rgba(0,0,0,0)); }
.bottom { bottom: 0; z-index: 4; padding: 28px 14px 8px; background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,.78)); }
.idle .top, .idle .bottom { opacity: 0; pointer-events: none; }
.idle { cursor: none; }
.back { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; color: inherit; text-decoration: none; flex: none; }
.back:hover { background: rgba(255,255,255,.12); }
.title { flex: 0 1 auto; margin-right: auto; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { flex: none; height: 30px; padding: 0 12px; border-radius: 15px; background: rgba(255,255,255,.12); font-size: 13px; }
.chip:hover { background: rgba(255,255,255,.2); }
.seek { position: relative; height: 18px; margin: 0 2px 2px; cursor: pointer; touch-action: none; --p: 0; --b: 0; --h: 0; }
.rail { position: absolute; left: 0; right: 0; top: 7px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.22); overflow: hidden; transition: transform .12s ease; }
.seek:hover .rail, .seek.dragging .rail { transform: scaleY(1.5); }
.bar { position: absolute; inset: 0; transform-origin: 0 50%; }
.buf { background: rgba(255,255,255,.32); transform: scaleX(var(--b)); }
.hov { background: rgba(255,255,255,.28); transform: scaleX(var(--h)); opacity: 0; }
.seek:hover .hov { opacity: 1; }
.fill { background: var(--accent); transform: scaleX(var(--p)); }
.knob-track { position: absolute; inset: 0; transform: translateX(calc(var(--p) * 100%)); pointer-events: none; }
.knob { position: absolute; left: -7px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 3px rgba(79,140,255,.25); transform: scale(0); transition: transform .12s ease; }
.seek:hover .knob, .seek.dragging .knob { transform: scale(1); }
.tip { position: absolute; bottom: 22px; left: 0; padding: 3px 7px; border-radius: 6px; background: var(--panel); font-size: 12px;
  font-variant-numeric: tabular-nums; white-space: nowrap; transform: translateX(-50%); pointer-events: none; opacity: 0; }
.seek:hover .tip, .seek.dragging .tip { opacity: 1; }
.row { display: flex; align-items: center; gap: 2px; height: 44px; }
.btn { width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; flex: none; }
.btn:hover { background: rgba(255,255,255,.12); }
.btn.active { color: var(--accent); }
.time { margin: 0 10px; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; opacity: .92; }
.spacer { flex: 1; }
.vol { display: flex; align-items: center; }
.vol input { width: 0; opacity: 0; transition: width .15s ease, opacity .15s ease; }
.vol:hover input, .vol input:focus-visible { width: 84px; opacity: 1; margin: 0 6px 0 2px; }
input[type=range] { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; cursor: pointer;
  background: linear-gradient(to right, #fff var(--v, 100%), rgba(255,255,255,.3) var(--v, 100%)); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #fff; }
input[type=range]::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: #fff; }
.qbtn { min-width: 52px; height: 32px; padding: 0 8px; border-radius: 16px; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.qbtn:hover { background: rgba(255,255,255,.12); }
.speed { min-width: 52px; height: 32px; padding: 0 8px; border-radius: 16px; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.speed:hover { background: rgba(255,255,255,.12); }
.src { height: 32px; padding: 0 10px; border-radius: 16px; display: inline-flex; align-items: center; gap: 4px; font-size: 13px; }
.src svg { width: 18px; height: 18px; }
.src:hover { background: rgba(255,255,255,.12); }
.menu { position: absolute; z-index: 5; right: 14px; bottom: 64px; min-width: 120px; padding: 6px; border-radius: 12px; background: var(--panel);
  box-shadow: 0 8px 30px rgba(0,0,0,.45); backdrop-filter: blur(8px); }
.menu[hidden] { display: none; }
.menu .head { padding: 4px 10px 6px; font-size: 12px; opacity: .6; }
.menu button { display: block; width: 100%; text-align: left; padding: 7px 10px; border-radius: 8px; font-variant-numeric: tabular-nums; }
.menu button:hover { background: rgba(255,255,255,.1); }
.menu button[aria-checked=true] { color: var(--accent); font-weight: 600; }
.center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none; }
.spinner { width: 46px; height: 46px; border-radius: 50%; border: 3px solid rgba(255,255,255,.2); border-top-color: #fff;
  animation: spin .9s linear infinite; display: none; }
.waiting .spinner { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
/* Paused: a small label in the title bar instead of a big icon over the picture. */
.pausehint { flex: none; display: none; align-items: center; gap: 6px; padding: 4px 10px 4px 8px; margin-right: auto;
  border-radius: 14px; background: rgba(255,255,255,.12); font-size: 12px; pointer-events: none; }
.pausehint svg { width: 14px; height: 14px; }
.paused:not(.waiting) .pausehint { display: inline-flex; }
.paused:not(.waiting) .title { margin-right: 0; }
.paused.hidecc-paused .captions { display: none; }
.toast { position: absolute; z-index: 5; left: 50%; bottom: 96px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px;
  padding: 9px 10px 9px 16px; border-radius: 12px; background: var(--panel); font-size: 13px; box-shadow: 0 8px 30px rgba(0,0,0,.4); max-width: calc(100% - 28px); }
.toast[hidden] { display: none; }
.toast button { color: var(--accent); font-weight: 600; padding: 4px 8px; border-radius: 6px; }
.toast button:hover { background: rgba(255,255,255,.08); }
.error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.7); }
.error[hidden] { display: none; }
.card { max-width: 420px; margin: 16px; padding: 20px 22px; border-radius: 14px; background: #1b1b20; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
.card h2 { margin: 0 0 8px; font-size: 16px; }
.card p { margin: 0 0 16px; opacity: .8; }
.card .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.card button { height: 34px; padding: 0 14px; border-radius: 8px; background: rgba(255,255,255,.1); }
.card button.primary { background: var(--accent); color: #fff; }
@media (max-width: 560px) {
  .hide-sm { display: none !important; }
  .top { padding: 6px 8px 22px; }
  .bottom { padding: 22px 6px 4px; }
  .time { margin: 0 6px; font-size: 12px; }
  .btn { width: 36px; height: 36px; }
}
`;

function playerTemplate() {
  return `
<div class="app">
<div class="stage paused l-single c-br">
  <div class="views">
    <video class="clock" playsinline preload="auto" data-slot="primary"></video>
    <video class="follower" playsinline preload="auto" muted data-slot="secondary"></video>
    <div class="pdfview" data-slot="off">
      <div class="pstage"></div>
      <div class="pbar">
        <button class="pnav pprev" title="${t('prevPage')}" aria-label="${t('prevPage')}">‹</button>
        <span class="plabel"></span>
        <button class="pnav pnext" title="${t('nextPage')}" aria-label="${t('nextPage')}">›</button>
        <span class="pfollow"></span>
        <button class="pnav pswap" title="${t('pdfSwap')}" aria-label="${t('pdfSwap')}">⇄</button>
        <button class="pnav pclose" title="${t('pdfMainClose')}" aria-label="${t('pdfMainClose')}">✕</button>
      </div>
    </div>
    <div class="divider" role="separator" aria-orientation="vertical" aria-label="${t('resizeViews')}" tabindex="0"></div>
    <div class="pipframe" title="${t('pipHint')}"><div class="grip" title="${t('resizePip')}"></div></div>
  </div>
  <div class="captions" hidden><span></span></div>
  <div class="center"><div class="spinner"></div></div>
  <div class="top">
    <a class="back" title="${t('back')}" aria-label="${t('back')}">${svg('back')}</a>
    <div class="title"></div>
    <span class="pausehint" aria-hidden="true">${svg('pause')}<span>${t('pausedHint')}</span></span>
 <button class="chip tbtn" data-open="transcript" hidden aria-pressed="false" title="${t('transcriptKey')}">${svg('transcript')}<span class="lbl">${t('transcript')}</span></button>
    <button class="chip tbtn" data-open="slides" hidden aria-pressed="false" title="${t('slidesKey')}">${svg('slides')}<span class="lbl">${t('slides')}</span></button>
    <button class="chip tbtn" data-open="notes" hidden aria-pressed="false" title="${t('notes')}">${svg('notes')}<span class="lbl">${t('notes')}</span></button>
    <button class="chip tbtn" data-open="discussion" hidden aria-pressed="false" title="${t('discussion')}">${svg('discussion')}<span class="lbl">${t('discussion')}</span></button>
    <button class="chip orig" title="${t('originalPlayerTitle')}">${t('originalPlayer')}</button>
  </div>
  <div class="bottom">
    <div class="seek" role="slider" aria-label="${t('seek')}" tabindex="0">
      <div class="rail"><div class="bar buf"></div><div class="sils"></div><div class="chaps"></div><div class="bar hov"></div><div class="bar fill"></div></div>
      <div class="imarks"></div>
      <div class="marks"></div>
      <div class="knob-track"><div class="knob"></div></div>
      <div class="tip"><img class="pv" alt="" hidden><span class="tt">0:00</span></div>
    </div>
    <div class="row">
      <button class="btn play" title="${t('play')}" aria-label="${t('play')}">${svg('play')}</button>
      <button class="btn rew hide-sm" title="${t('rewind')}" aria-label="${t('rewind')}">${svg('back10')}</button>
      <button class="btn fwd hide-sm" title="${t('forward')}" aria-label="${t('forward')}">${svg('fwd10')}</button>
      <div class="vol">
        <button class="btn mute" title="${t('mute')}" aria-label="${t('mute')}">${svg('volume')}</button>
        <input class="volume hide-sm" type="range" min="0" max="1" step="0.01" aria-label="${t('volume')}">
      </div>
      <div class="time"><span class="cur">0:00</span> / <span class="dur">0:00</span></div>
      <div class="spacer"></div>
      <button class="btn bmbtn hide-sm" hidden title="${t('bookmarkKey')}" aria-label="${t('bookmark')}">${svg('bookmark')}</button>
      <button class="btn flagbtn hide-sm" hidden title="${t('flagKey')}" aria-label="${t('flag')}" aria-pressed="false">${svg('flag')}</button>
      <button class="btn copybtn" title="${t('copy')}" aria-label="${t('copy')}" aria-haspopup="menu">${svg('copy')}</button>
      <button class="btn audiobtn hide-sm" title="${t('audio')}" aria-label="${t('audio')}" aria-haspopup="menu">${svg('audio')}</button>
      <button class="btn ccbtn" hidden title="${t('captionsKey')}" aria-label="${t('captions')}" aria-haspopup="menu">${svg('cc')}</button>
      <button class="btn swap" title="${t('swapViews')}" aria-label="${t('swapViews')}">${svg('swap')}</button>
      <button class="btn layout" title="${t('layout')}" aria-label="${t('layout')}" aria-haspopup="menu">${svg('layoutSide')}</button>
      <button class="qbtn hide-sm" title="${t('quality')}" aria-label="${t('quality')}" aria-haspopup="menu"></button>
      <button class="speed" title="${t('speed')}" aria-label="${t('speed')}">1x</button>
      <button class="btn fs" title="${t('fullscreen')}" aria-label="${t('fullscreen')}">${svg('fullscreen')}</button>
    </div>
  </div>
  <div class="menu qualitymenu" hidden role="menu"></div>
  <div class="menu speedmenu" hidden role="menu"><div class="head">${t('speed')}</div></div>
  <div class="menu layoutmenu" hidden role="menu"><div class="head">${t('layout')}</div>
    <button role="menuitemradio" data-layout="side">${svg('layoutSide')}${t('layoutSide')}</button>
    <button role="menuitemradio" data-layout="pip">${svg('layoutPip')}${t('layoutPip')}</button>
    <button role="menuitemradio" data-layout="single">${svg('layoutSingle')}${t('layoutSingle')}</button>
  </div>
  <div class="menu ccmenu" hidden role="menu"><div class="head">${t('captions')}</div>
    <button class="opt cctoggle" role="menuitemcheckbox" aria-checked="false"><span>${t('showCaptions')}</span><span class="state"></span></button>
    <button class="opt cchidepaused" role="menuitemcheckbox" aria-checked="true"><span>${t('hideCaptionsPaused')}</span><span class="state"></span></button>
    <div class="head">${t('captionSize')}</div>
    <div class="sizes">
      <button role="menuitemradio" data-size="s">S</button><button role="menuitemradio" data-size="m">M</button><button role="menuitemradio" data-size="l">L</button><button role="menuitemradio" data-size="xl">XL</button>
    </div>
  </div>
  <div class="menu copymenu" hidden role="menu"><div class="head">${t('copy')}</div>
    <button class="opt" role="menuitem" data-copy="frame"><span class="row1"><span>${t('copyFrame')}</span><span class="key">P</span></span><span class="desc">${t('copyFrameDesc')}</span></button>
    <button class="opt" role="menuitem" data-copy="captions"><span class="row1"><span>${t('copyCaptions')}</span><span class="key">A</span></span><span class="desc">${t('copyCaptionsDesc')}</span></button>
    <div class="sub">${t('copyCaptionsSpan')}</div>
    <div class="choices copyspan">${[30, 60, 120, 300].map((s) => `<button role="menuitemradio" data-span="${s}">${s < 60 ? s + 's' : s / 60 + 'm'}</button>`).join('')}</div>
  </div>
  <div class="menu audiomenu" hidden role="menu"><div class="head">${t('audio')}</div>
    <div class="why" hidden></div>
    <button class="opt" role="menuitemcheckbox" data-audio="level" aria-checked="false"><span class="row1"><span>${t('audioLevel')}</span><span class="state"></span></span><span class="desc">${t('audioLevelDesc')}</span></button>
    <button class="opt" role="menuitemcheckbox" data-audio="voice" aria-checked="false"><span class="row1"><span>${t('audioVoice')}</span><span class="state"></span></span><span class="desc">${t('audioVoiceDesc')}</span></button>
    <button class="opt" role="menuitemcheckbox" data-audio="mono" aria-checked="false"><span class="row1"><span>${t('audioMono')}</span><span class="state"></span></span><span class="desc">${t('audioMonoDesc')}</span></button>
    <div class="sep"></div>
    <div class="head">${t('silence')}</div>
    <div class="silstatus"></div>
    <button class="opt" role="menuitemcheckbox" data-sil="auto" aria-checked="false"><span class="row1"><span>${t('silenceAuto')}</span><span class="state"></span></span><span class="desc">${t('silenceAutoDesc')}</span></button>
    <div class="sub">${t('silenceMin')}</div>
    <div class="choices silmin">${SILENCE_MIN_CHOICES.map((s) => `<button role="menuitemradio" data-min="${s}">${s < 60 ? s + 's' : s / 60 + 'm'}</button>`).join('')}</div>
    <div class="sens"><div class="sub">${t('silenceSensitivity')}</div>
    <div class="choices silsens"><button role="menuitemradio" data-sens="low">${t('low')}</button><button role="menuitemradio" data-sens="normal">${t('normal')}</button><button role="menuitemradio" data-sens="high">${t('high')}</button></div></div>
  </div>
  <button class="skipsil fade" tabindex="-1"></button>
  <div class="toast" hidden><span class="msg"></span><button class="act"></button></div>
  <div class="dropzone" hidden>${t('dropSlides')}</div>
  <div class="error" hidden><div class="card"><h2></h2><p></p><div class="actions"></div></div></div>
</div>
<aside class="panel" hidden aria-label="${t('sidebarTabs')}">
  <div class="presize" title="${t('resizePanel')}"></div>
  <div class="phead">
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="transcript" hidden>${t('transcript')}</button>
      <button role="tab" data-tab="slides" hidden>${t('slides')}</button>
      <button role="tab" data-tab="notes" hidden>${t('notes')}</button>
      <button role="tab" data-tab="discussion" hidden>${t('discussion')}</button>
    </div>
    <button class="btn pclose" title="${t('closePanel')}" aria-label="${t('closePanel')}">${svg('close')}</button>
  </div>
  <div class="pextras" hidden><div class="msg"></div><button class="link">${t('openInOriginal')}</button></div>
  <section class="pane" data-pane="transcript" hidden>
    <div class="psearch">
      <input class="tsearch" type="search" placeholder="${t('searchTranscript')}" aria-label="${t('searchTranscript')}">
      <span class="tcount" aria-live="polite"></span>
      <button class="btn tprev" title="${t('prevMatch')}" aria-label="${t('prevMatch')}">${svg('up')}</button>
      <button class="btn tnext" title="${t('nextMatch')}" aria-label="${t('nextMatch')}">${svg('down')}</button>
    </div>
    <div class="tlist" tabindex="0"></div>
    <button class="tback" hidden>${t('backToCurrent')}</button>
  </section>
  <section class="pane" data-pane="slides" hidden></section>
  <section class="pane" data-pane="notes" hidden></section>
  <section class="pane" data-pane="discussion" hidden></section>
</aside>
</div>`;
}

// ---- 35-stream.js ----
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

// ---- 38-sync.js ----
// ===================================================================================
// Keeps a muted follower <video> in step with the clock <video> (the one with audio).
//   - play / pause / seek / rate changes are mirrored immediately;
//   - while the clock buffers, the follower waits;
//   - a 1 s check while playing nudges the follower's rate for small drift and seeks it
//     for large drift. The check only runs while the clock is playing.
// ===================================================================================

const SYNC_TOLERANCE = 0.08;   // seconds of drift that are ignored
const SYNC_SEEK_AT = 1.0;      // seconds of drift corrected by seeking instead of nudging
const SYNC_MAX_NUDGE = 0.1;    // max relative rate change while catching up

class FollowerSync {
  constructor(clock, follower) {
    this.clock = clock;
    this.follower = follower;
    this.d = new Disposer();
    this.timer = 0;
    const d = this.d;
    const c = clock;
    const f = follower;
    f.muted = true;

    d.listen(c, 'play', () => { this.align(); this.playFollower(); this.start(); });
    d.listen(c, 'playing', () => this.playFollower());
    d.listen(c, 'pause', () => { this.stop(); f.pause(); this.align(); });
    d.listen(c, 'waiting', () => f.pause());
    d.listen(c, 'seeking', () => this.align());
    d.listen(c, 'ratechange', () => { f.playbackRate = c.playbackRate; });
    d.listen(f, 'loadedmetadata', () => { this.align(); if (!c.paused) this.playFollower(); });
    d.add(() => this.stop());

    f.playbackRate = c.playbackRate;
    if (!c.paused) this.start();
  }

  playFollower() {
    const c = this.clock;
    const f = this.follower;
    if (c.paused || c.readyState < 3) return;
    if (f.paused) f.play().catch(() => {});
  }

  align() {
    const f = this.follower;
    if (f.readyState === 0 || this.clock.readyState === 0) return;
    if (Math.abs(f.currentTime - this.clock.currentTime) > SYNC_TOLERANCE) f.currentTime = this.clock.currentTime;
    f.playbackRate = this.clock.playbackRate;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(guard(() => this.check()), 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  check() {
    const c = this.clock;
    const f = this.follower;
    if (c.paused || c.seeking || f.seeking || f.readyState < 2) return;
    const base = c.playbackRate;
    const drift = f.currentTime - c.currentTime;
    if (Math.abs(drift) >= SYNC_SEEK_AT) {
      // Aim slightly ahead so the follower lands in sync once its seek completes.
      f.currentTime = c.currentTime + 0.1 * base;
      f.playbackRate = base;
    } else if (Math.abs(drift) > SYNC_TOLERANCE) {
      f.playbackRate = base * (1 - clamp(drift * 0.5, -SYNC_MAX_NUDGE, SYNC_MAX_NUDGE));
    } else if (f.playbackRate !== base) {
      f.playbackRate = base;
    }
    if (f.paused && c.readyState >= 3) f.play().catch(() => {});
  }

  dispose() {
    this.d.dispose();
  }
}

// ---- 40-player.js ----
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
    this.clock = new Stream(this.video, (f) => this.onClockFatal(f));
    this.follower = new Stream(this.fvideo, () => this.onFollowerFatal());
    this.followerPos = -1;
    for (const st of [this.clock, this.follower]) st.onLevel = () => { if (!this.destroyed) this.onLevelChange(); };
    this.d.add(() => { this.dropFollower(); this.clock.destroy(); });
    this.bindVideo();
    this.bindControls();
    this.bindLayoutControls();
    this.bindKeys();
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

  pickStart() {
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
      this.showError(t('authExpiredTitle'), t('authExpiredText'),
        [[t('reload'), () => { this.savePosition(); location.reload(); }, true], [t('useOriginal'), () => this.opts.onFallback('auth')]]);
      return;
    }
    this.showError(t('playbackFailedTitle'), t('playbackFailedText', { detail: f.details }),
      [[t('retry'), () => { this.hideError(); this.loadClock(this.clockPos, this.video.currentTime, true); }, true],
        [t('useOriginal'), () => this.opts.onFallback('error')]]);
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
    on('durationchange', () => { this.render(true); this.updateMarkers(); this.renderSilences(); this.renderChapterMarks(); });
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
      if (++tick % 5 === 0) this.savePosition();
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
    this.video.currentTime = clamp(target, 0, dur ? dur - 0.1 : target);
    this.render(true);
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
    const $ = (s) => this.$(s);
    const v = this.video;
    const d = this.d;
    d.add(() => { clearTimeout(this.idleTimer); clearTimeout(this.toastTimer); clearTimeout(this.prefsTimer); store.set('prefs', this.prefs); });
    d.listen($('.play'), 'click', () => this.togglePlay());
    d.listen($('.rew'), 'click', () => this.seek(v.currentTime - 10));
    d.listen($('.fwd'), 'click', () => this.seek(v.currentTime + 10));
    d.listen($('.mute'), 'click', () => {
      if (v.muted || v.volume === 0) { v.muted = false; if (v.volume === 0) v.volume = 0.5; } else v.muted = true;
    });
    d.listen($('.volume'), 'input', (e) => { v.volume = +e.target.value; v.muted = v.volume === 0; });
    d.listen($('.fs'), 'click', () => this.toggleFullscreen());
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
    });

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
    d.listen(views, 'click', (e) => {
      if (e.target.tagName !== 'VIDEO') return;
      if (wokeByPress) { wokeByPress = false; return; }
      clearTimeout(clickTimer);
      clickTimer = setTimeout(guard(() => this.togglePlay()), 200);
    });
    d.listen(views, 'dblclick', (e) => {
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
    this.d.listen(document, 'keydown', (e) => {
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
        case 'p': case 'P': this.copyFrame(); break;
        case 'a': case 'A': this.copyCaptions(); break;
        case 'Escape':
          if (this.menusOpen()) { for (const m of this.root.querySelectorAll('.menu')) m.hidden = true; } else handled = false;
          break;
        case ']': this.setRate(nextSpeed(v.playbackRate, 1)); break;
        case '[': this.setRate(nextSpeed(v.playbackRate, -1)); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); this.wake(); }
    }, true);
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
    if (!a.chapters.length) return;
    if (!this.slidesPane) {
      this.slidesPane = new SlidesPane(this, this.$('.pane[data-pane=slides]'));
      this.d.add(() => this.slidesPane.dispose());
      this.registerTab('slides', this.slidesPane);
    }
    const pct = Math.floor(a.progress * 100);
    const status = a.state === 'done' ? t('slidesFound', { n: a.chapters.length })
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

// ---- 45-captions.js ----
// ===================================================================================
// Captions overlay and transcript panel. Both read one sorted cue list.
// ===================================================================================

// Finds the cue for a playback time. Sequential playback moves forward one cue at a time,
// so the previous answer is checked first; seeks fall back to a binary search.
class CueIndex {
  constructor(cues) {
    this.cues = cues;
    this.last = -1;
  }

  // Index of the last cue that started at or before t (-1 before the first cue).
  started(t) {
    const c = this.cues;
    const i = this.last;
    if (i >= 0 && i < c.length && c[i].start <= t && (i + 1 === c.length || c[i + 1].start > t)) return i;
    if (i + 1 < c.length && c[i + 1].start <= t && (i + 2 >= c.length || c[i + 2].start > t)) return (this.last = i + 1);
    let lo = 0;
    let hi = c.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    this.last = k;
    return k;
  }

  // Index of the cue being spoken at t, or -1 in a gap.
  active(t) {
    const k = this.started(t);
    return k >= 0 && t < this.cues[k].end ? k : -1;
  }
}

// What was said in the last `span` seconds before t, in whole sentences: { start, end,
// text } or null. A cue that continues a sentence from the cue before it pulls that one
// in (at most 30 s further back); the sentence being spoken at t is completed (at most
// 20 s ahead). Cues are sentence-ish but often break mid-sentence.
function captionExcerpt(cues, t, span) {
  const ends = (s) => /[.?!]["')\]]?\s*$/.test(s);
  let a = cues.findIndex((c) => c.end > t - span);
  if (a < 0) return null;
  let b = a;
  while (b + 1 < cues.length && cues[b + 1].start <= t) b++;
  if (cues[a].start > t) return null;
  const from = t - span;
  while (a > 0 && !ends(cues[a - 1].text) && cues[a - 1].start >= from - 30) a--;
  while (b + 1 < cues.length && !ends(cues[b].text) && cues[b + 1].start <= t + 20) b++;
  const text = cues.slice(a, b + 1).map((c) => c.text.trim()).join(' ').replace(/\s+/g, ' ');
  return { start: cues[a].start, end: cues[b].end, text };
}

const CAPTION_SIZES = { s: 0.8, m: 1, l: 1.3, xl: 1.65 };

class CaptionsView {
  constructor(el, video) {
    this.el = el;
    this.video = video;
    this.textEl = el.firstElementChild;
    this.index = null;
    this.on = false;
    this.shown = -2;
    this.timer = 0;
  }

  setCues(cues) {
    this.index = new CueIndex(cues);
    this.shown = -2;
  }

  setOn(on) {
    this.on = on;
    this.el.hidden = !on;
    this.shown = -2;
    if (!on) this.clearTimer();
  }

  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
  }

  // timeupdate fires only about 4 times a second, so a caption could change up to 250 ms
  // late. While playing, one timer is set for the next cue boundary instead.
  scheduleNext(t) {
    this.clearTimer();
    const v = this.video;
    if (!v || v.paused || v.seeking || !this.index) return;
    const c = this.index.cues;
    const k = this.index.started(t);
    let next = k + 1 < c.length ? c[k + 1].start : Infinity;
    if (k >= 0 && c[k].end > t) next = Math.min(next, c[k].end);
    if (!isFinite(next)) return;
    const ms = ((next - t) / (v.playbackRate || 1)) * 1000;
    if (ms > 400) return; // the next timeupdate comes first
    this.timer = setTimeout(guard(() => { this.timer = 0; this.update(this.video.currentTime); }), Math.max(0, ms) + 5);
  }

  dispose() {
    this.clearTimer();
  }

  setSize(size) {
    this.el.style.setProperty('--capscale', String(CAPTION_SIZES[size] || 1));
  }

  // Called on timeupdate/seeked (about 4 times a second): writes the DOM only when the cue
  // changes.
  update(t) {
    if (!this.on || !this.index || document.hidden) return;
    const k = this.index.active(t);
    this.scheduleNext(t);
    if (k === this.shown) return;
    this.shown = k;
    if (k < 0) { this.el.classList.add('empty'); this.textEl.textContent = ''; return; }
    this.el.classList.remove('empty');
    this.textEl.textContent = this.index.cues[k].text;
  }
}

// Transcript tab of the side panel. The list is built once, on first show; rows use
// `content-visibility: auto`, so off-screen rows cost no layout or paint.
class TranscriptPanel {
  constructor(player, el, marksEl) {
    this.player = player;
    this.el = el;
    this.visible = false;
    this.marksEl = marksEl;
    this.list = el.querySelector('.tlist');
    this.search = el.querySelector('.tsearch');
    this.countEl = el.querySelector('.tcount');
    this.backBtn = el.querySelector('.tback');
    this.cues = [];
    this.lower = null;
    this.index = null;
    this.rows = null;
    this.current = -1;
    this.follow = true;
    this.hits = [];
    this.hitPos = -1;
    this.searchTimer = 0;
    this.programmaticScrollUntil = 0;
    this.d = new Disposer();
    this.bind();
  }

  setCues(cues) {
    this.cues = cues;
    this.index = new CueIndex(cues);
    this.lower = null;
    if (this.rows) { this.list.textContent = ''; this.rows = null; }
  }

  get open() { return this.visible; }

  build() {
    if (this.rows) return;
    const long = this.player.duration() >= 3600;
    const frag = document.createDocumentFragment();
    this.rows = this.cues.map((c, i) => {
      const row = document.createElement('div');
      row.className = 'trow';
      row.dataset.i = String(i);
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = fmtTime(c.start, long);
      const tx = document.createElement('span');
      tx.className = 'tx';
      tx.textContent = c.text;
      row.append(ts, tx);
      frag.appendChild(row);
      return row;
    });
    this.list.appendChild(frag);
    this.current = -1;
  }

  show(on) {
    this.visible = on;
    if (on) {
      this.build();
      this.follow = true;
      this.backBtn.hidden = true;
      this.update(this.player.video.currentTime, true);
    }
  }

  // Called on timeupdate/seeked while the panel is open: moves the highlight when the cue
  // changes and keeps it in view unless the user has scrolled away.
  update(t, force) {
    if (!this.open || !this.rows || document.hidden) return;
    const k = this.index.started(t);
    if (k === this.current && !force) return;
    if (this.current >= 0 && this.rows[this.current]) this.rows[this.current].classList.remove('cur');
    this.current = k;
    if (k < 0) return;
    this.rows[k].classList.add('cur');
    if (this.follow) this.scrollTo(k);
  }

  scrollTo(k) {
    const row = this.rows[k];
    if (!row) return;
    this.programmaticScrollUntil = performance.now() + 600;
    row.scrollIntoView({ block: 'center' });
  }

  stopFollowing() {
    if (!this.follow) return;
    this.follow = false;
    this.backBtn.hidden = false;
  }

  bind() {
    const d = this.d;
    d.listen(this.list, 'click', (e) => {
      const row = e.target.closest('.trow');
      if (!row) return;
      this.player.seek(this.cues[+row.dataset.i].start);
      this.follow = true;
      this.backBtn.hidden = true;
    });
    // Any user-initiated scrolling of the list pauses auto-follow.
    const userScroll = () => this.stopFollowing();
    d.listen(this.list, 'wheel', userScroll, { passive: true });
    d.listen(this.list, 'touchmove', userScroll, { passive: true });
    d.listen(this.list, 'keydown', (e) => { if (/^(Arrow|Page|Home|End| )/.test(e.key)) userScroll(); });
    d.listen(this.list, 'scroll', () => { if (performance.now() > this.programmaticScrollUntil && this.dragScroll) userScroll(); }, { passive: true });
    d.listen(this.list, 'pointerdown', (e) => { if (e.target === this.list) this.dragScroll = true; });
    d.listen(window, 'pointerup', () => { this.dragScroll = false; });
    d.listen(this.backBtn, 'click', () => {
      this.follow = true;
      this.backBtn.hidden = true;
      if (this.current >= 0) this.scrollTo(this.current);
    });
    d.listen(this.search, 'input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.runSearch(), 150);
    });
    d.listen(this.search, 'keydown', (e) => {
      if (e.key === 'Enter') { this.stepHit(e.shiftKey ? -1 : 1); e.preventDefault(); }
      if (e.key === 'Escape') { this.search.value = ''; this.runSearch(); e.preventDefault(); }
      e.stopPropagation();
    });
    d.listen(this.el.querySelector('.tprev'), 'click', () => this.stepHit(-1));
    d.listen(this.el.querySelector('.tnext'), 'click', () => this.stepHit(1));
    d.add(() => clearTimeout(this.searchTimer));
  }

  runSearch() {
    const q = this.search.value.trim().toLowerCase();
    for (const i of this.hits) if (this.rows && this.rows[i]) this.rows[i].classList.remove('hit');
    this.hits = [];
    this.hitPos = -1;
    if (q) {
      if (!this.lower) this.lower = this.cues.map((c) => c.text.toLowerCase());
      for (let i = 0; i < this.lower.length; i++) if (this.lower[i].includes(q)) this.hits.push(i);
      for (const i of this.hits) this.rows[i].classList.add('hit');
    }
    this.countEl.textContent = q ? t('searchCount', { n: this.hits.length }) : '';
    this.renderMarks();
  }

  stepHit(dir) {
    if (!this.hits.length) return;
    this.hitPos = (this.hitPos + dir + this.hits.length) % this.hits.length;
    const k = this.hits[this.hitPos];
    this.countEl.textContent = t('searchPos', { i: this.hitPos + 1, n: this.hits.length });
    this.stopFollowing();
    this.scrollTo(k);
  }

  // Search hits on the progress bar, merged into 0.25% buckets (at most 400 marks).
  renderMarks() {
    const el = this.marksEl;
    el.textContent = '';
    const dur = this.player.duration();
    if (!this.hits.length || !dur) return;
    const seen = new Set();
    const frag = document.createDocumentFragment();
    for (const i of this.hits) {
      const bucket = Math.floor((this.cues[i].start / dur) * 400);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      const m = document.createElement('i');
      m.style.left = (bucket / 4).toFixed(2) + '%';
      frag.appendChild(m);
    }
    el.appendChild(frag);
  }

  dispose() {
    this.d.dispose();
  }
}

// ---- 46-sidebar.js ----
// ===================================================================================
// Side panel with tabs (transcript, slides, notes, discussion). Each tab is a controller with
// show(visible); only the active tab of an open panel is visible, so hidden tabs do no work.
// ===================================================================================

// Small DOM helper: h('button.btn.primary', { title: 'x', onclick }, 'text', child, ...)
function h(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), guard(v));
      else if (k === 'text') el.textContent = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

const SIDEBAR_TABS = ['transcript', 'slides', 'notes', 'discussion'];

class Sidebar {
  constructor(player, el) {
    this.p = player;
    this.el = el;
    this.controllers = {};
    this.active = null;
    this.isOpen = false;
    this.d = new Disposer();
    for (const b of el.querySelectorAll('.tabs [data-tab]')) {
      this.d.listen(b, 'click', () => this.switchTo(b.dataset.tab));
    }
  }

  tabButton(tab) { return this.el.querySelector('.tabs [data-tab="' + tab + '"]'); }

  pane(tab) { return this.el.querySelector('.pane[data-pane="' + tab + '"]'); }

  register(tab, controller) {
    this.controllers[tab] = controller;
    this.tabButton(tab).hidden = false;
    for (const chip of this.p.root.querySelectorAll('.top [data-open="' + tab + '"]')) chip.hidden = false;
  }

  has(tab) { return !!this.controllers[tab]; }

  visible(tab) { return this.isOpen && this.active === tab; }

  open(tab) {
    const target = this.has(tab) ? tab : (this.has(this.active) ? this.active : SIDEBAR_TABS.find((x) => this.has(x)));
    if (!target) return;
    this.isOpen = true;
    this.el.hidden = false;
    this.switchTo(target);
    this.p.onSidebarChange();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    if (this.active && this.controllers[this.active]) this.controllers[this.active].show(false);
    this.p.onSidebarChange();
  }

  toggle(tab) {
    if (this.isOpen && (!tab || this.active === tab)) this.close();
    else this.open(tab);
  }

  switchTo(tab) {
    if (!this.has(tab)) return;
    const prev = this.active;
    if (prev && prev !== tab && this.controllers[prev]) this.controllers[prev].show(false);
    this.active = tab;
    for (const t2 of SIDEBAR_TABS) {
      const pane = this.pane(t2);
      if (pane) pane.hidden = t2 !== tab;
      const b = this.tabButton(t2);
      if (b) b.setAttribute('aria-selected', String(t2 === tab));
    }
    if (this.isOpen) this.controllers[tab].show(true);
    this.p.onSidebarChange();
  }

  dispose() {
    for (const c of Object.values(this.controllers)) if (c.dispose) c.dispose();
    this.d.dispose();
  }
}

// ---- 47-notes.js ----
// ===================================================================================
// Notes tab: private notes, bookmarks and "didn't understand" flags, sorted by time.
// Data is loaded once at start (it also feeds the progress-bar markers); the list DOM is
// only rebuilt while the tab is visible.
// ===================================================================================

const NOTE_FILTERS = ['all', 'note', 'bookmark', 'flag'];

class NotesPane {
  constructor(player, pane, api, canFlag) {
    this.p = player;
    this.pane = pane;
    this.api = api;
    this.canFlag = canFlag;
    this.items = [];
    this.filter = 'all';
    this.visible = false;
    this.dirty = true;
    this.d = new Disposer();
    this.build();
  }

  // Resolves true when notes are available for this recording.
  async load() {
    const [notes, flags] = await Promise.allSettled([this.api.notes(), this.canFlag ? this.api.flags() : Promise.resolve([])]);
    if (notes.status !== 'fulfilled') {
      console.info(TAG, 'notes unavailable:', notes.reason && notes.reason.message);
      return false;
    }
    this.items = notes.value.concat(flags.status === 'fulfilled' ? flags.value : []);
    this.sort();
    this.changed();
    return true;
  }

  sort() {
    this.items.sort((a, b) => (a.time == null ? -1 : a.time) - (b.time == null ? -1 : b.time));
  }

  changed() {
    this.dirty = true;
    if (this.visible) this.render();
    this.p.updateMarkers();
  }

  build() {
    const timeLabel = h('span');
    this.composerTime = timeLabel;
    this.textarea = h('textarea.input', { rows: 3, maxLength: 5000, 'aria-label': t('addNote') });
    this.addBtn = h('button.pbtn.primary', { text: t('addNote'), onclick: (e) => this.addNote(e) });
    this.d.listen(this.textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.addNote(e); }
    });
    this.d.listen(this.textarea, 'focus', () => this.updatePlaceholder());
    this.select = h('select.input.small', { 'aria-label': t('filterAll') });
    for (const f of NOTE_FILTERS) {
      const label = { all: t('filterAll'), note: t('filterNotes'), bookmark: t('filterBookmarks'), flag: t('filterFlags') }[f];
      if (f === 'flag' && !this.canFlag) continue;
      this.select.append(h('option', { value: f, text: label }));
    }
    this.d.listen(this.select, 'change', () => { this.filter = this.select.value; this.render(); });
    this.errorEl = h('div.perror', { hidden: true });
    this.list = h('div.plist');
    this.pane.append(
      h('div.pinfo', { text: t('notesPrivate') }),
      h('div.composer', null, this.textarea, h('div.crow', null, timeLabel, h('span.grow'), this.addBtn)),
      h('div.ptools', null, this.select),
      this.errorEl,
      this.list,
    );
  }

  updatePlaceholder() {
    const at = fmtTime(this.p.video.currentTime, this.p.duration() >= 3600);
    this.textarea.placeholder = t('addNotePlaceholder', { time: at });
  }

  show(on) {
    this.visible = on;
    if (on) { this.updatePlaceholder(); if (this.dirty) this.render(); }
  }

  showError(msg) {
    this.errorEl.textContent = msg;
    this.errorEl.hidden = !msg;
  }

  fail(e) {
    console.warn(TAG, 'write failed', e);
    this.showError(t('saveFailed', { error: e.message || e }));
    this.p.toast(t('saveFailed', { error: e.message || e }));
  }

  render() {
    this.dirty = false;
    const long = this.p.duration() >= 3600;
    const shown = this.items.filter((x) => this.filter === 'all' || x.type === this.filter);
    const frag = document.createDocumentFragment();
    if (!shown.length) frag.append(h('div.pempty', { text: t('noNotes') }));
    for (const item of shown) frag.append(this.renderItem(item, long));
    this.list.textContent = '';
    this.list.append(frag);
  }

  renderItem(item, long) {
    const label = { note: t('markerNote'), bookmark: t('markerBookmark'), flag: t('markerFlag') }[item.type];
    const time = item.time != null
      ? h('button.chiptime', { text: fmtTime(item.time, long), title: label, onclick: () => this.p.seek(item.time) })
      : null;
    const head = h('div.ihead', null, h('span.kind.k-' + item.type, { text: label }), time, h('span.grow'));
    const body = item.type === 'note' ? h('div.ibody', { text: item.text }) : null;
    const actions = h('div.iactions');
    if (item.type === 'note') actions.append(h('button.link', { text: t('edit'), onclick: () => this.startEdit(item, card) }));
    actions.append(this.deleteButton(item));
    const card = h('div.card.k-' + item.type, null, head, body, actions);
    return card;
  }

  // Two clicks within 3 s delete; the second click is the user action sent with the write.
  deleteButton(item) {
    const label = item.type === 'flag' ? t('remove') : t('delete');
    let armed = 0;
    const b = h('button.link.danger', { text: label });
    b.addEventListener('click', guard((e) => {
      if (!armed) {
        b.textContent = t('confirmDelete');
        armed = setTimeout(() => { armed = 0; b.textContent = label; }, 3000);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      this.remove(e, item);
    }));
    return b;
  }

  startEdit(item, card) {
    const area = h('textarea.input', { rows: 3, maxLength: 5000 });
    area.value = item.text;
    const save = h('button.pbtn.primary', { text: t('save') });
    const cancel = h('button.pbtn', { text: t('cancel'), onclick: () => this.render() });
    save.addEventListener('click', guard(async (e) => {
      const text = area.value.trim();
      if (!text) return;
      save.disabled = true;
      try {
        await this.api.updateNote(e, item, text);
        item.text = text;
        this.showError('');
        this.changed();
      } catch (err) { save.disabled = false; this.fail(err); }
    }));
    card.querySelector('.ibody').replaceWith(h('div.composer', null, area, h('div.crow', null, h('span.grow'), cancel, save)));
    card.querySelector('.iactions').hidden = true;
    area.focus();
  }

  async addNote(e) {
    const text = this.textarea.value.trim();
    if (!text) return;
    this.addBtn.disabled = true;
    try {
      const note = await this.api.addNote(e, { text, time: this.p.video.currentTime, num: this.count('note') + 1 });
      this.textarea.value = '';
      this.items.push(note);
      this.sort();
      this.showError('');
      this.changed();
    } catch (err) {
      this.fail(err);
    } finally {
      this.addBtn.disabled = false;
    }
  }

  count(type) { return this.items.filter((x) => x.type === type).length; }

  async addBookmark(e) {
    const time = this.p.video.currentTime;
    try {
      const note = await this.api.addNote(e, { bookmark: true, time, num: this.count('bookmark') + 1 });
      this.items.push(note);
      this.sort();
      this.changed();
      this.p.toast(t('bookmarkedAt', { time: fmtTime(time) }), t('undo'), (ev) => this.remove(ev, note));
    } catch (err) { this.fail(err); }
  }

  flagAt(time) {
    const scene = Math.floor(time / FLAG_SCENE_SECONDS) * FLAG_SCENE_SECONDS;
    return this.items.find((x) => x.type === 'flag' && x.time === scene) || null;
  }

  async toggleFlag(e) {
    if (!this.canFlag) return;
    const time = this.p.video.currentTime;
    const existing = this.flagAt(time);
    try {
      if (existing) {
        await this.api.removeFlag(e, existing);
        this.items = this.items.filter((x) => x !== existing);
        this.p.toast(t('flagRemoved', { time: fmtTime(existing.time) }));
      } else {
        await this.api.addFlag(e, time);
        const scene = Math.floor(time / FLAG_SCENE_SECONDS) * FLAG_SCENE_SECONDS;
        this.items.push({ id: 'flag-' + scene / FLAG_SCENE_SECONDS, type: 'flag', time: scene, createdAt: new Date().toISOString() });
        this.sort();
        this.p.toast(t('flagAdded', { time: fmtTime(scene) }));
      }
      this.changed();
      this.p.renderFlagButton();
    } catch (err) { this.fail(err); }
  }

  async remove(e, item) {
    try {
      if (item.type === 'flag') await this.api.removeFlag(e, item);
      else await this.api.deleteNote(e, item);
      this.items = this.items.filter((x) => x !== item);
      this.showError('');
      this.changed();
      this.p.renderFlagButton();
    } catch (err) { this.fail(err); }
  }

  markers() {
    return this.items.filter((x) => x.time != null).map((x) => ({
      time: x.time,
      kind: x.type,
      label: x.type === 'note' ? t('markerNote') + ': ' + x.text : x.type === 'bookmark' ? t('markerBookmark') : t('markerFlag'),
    }));
  }

  dispose() {
    this.d.dispose();
  }
}

// ---- 48-discussion.js ----
// ===================================================================================
// Discussion tab: the lesson's public questions and replies.
// Loaded once at start (for availability and progress-bar markers) and again when the tab
// is opened or refreshed, and after every write, so the list always shows server state.
// Every write is a click (or Ctrl+Enter) by the user; the composer states who can see posts.
// ===================================================================================

const MAX_POST_LENGTH = 5000;

class DiscussionPane {
  constructor(player, pane, api) {
    this.p = player;
    this.pane = pane;
    this.api = api;
    this.threads = [];
    this.hiddenCount = 0;
    this.sort = 'newest';
    this.visible = false;
    this.dirty = true;
    this.openReplies = new Set();
    this.replyOpen = null;
    this.loadedAt = 0;
    this.d = new Disposer();
    this.build();
  }

  // Resolves true when discussions are enabled for this lesson.
  async load() {
    try {
      const data = await this.api.discussions();
      this.threads = data.threads;
      this.hiddenCount = data.hiddenCount;
      this.loadedAt = Date.now();
      this.showError('');
      this.changed();
      return true;
    } catch (e) {
      console.info(TAG, 'discussions unavailable:', e.message);
      if (this.loadedAt) this.showError(t('loadFailed', { error: e.message }));
      return false;
    }
  }

  changed() {
    this.dirty = true;
    if (this.visible) this.render();
    this.p.updateMarkers();
  }

  build() {
    this.textarea = h('textarea.input', { rows: 3, maxLength: MAX_POST_LENGTH + 500, placeholder: t('postPlaceholder'), 'aria-label': t('postPlaceholder') });
    this.counter = h('span.counter');
    this.linkTime = h('input', { type: 'checkbox', checked: true });
    this.linkLabel = h('span');
    this.anon = h('input', { type: 'checkbox' });
    this.postBtn = h('button.pbtn.primary', { text: t('postPublic'), onclick: (e) => this.post(e) });
    this.d.listen(this.textarea, 'input', () => this.updateCounter(this.textarea, this.counter, this.postBtn));
    this.d.listen(this.textarea, 'focus', () => this.updateLinkLabel());
    this.d.listen(this.textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.post(e); }
    });
    this.sortSel = h('select.input.small', { 'aria-label': t('sortNewest') },
      h('option', { value: 'newest', text: t('sortNewest') }), h('option', { value: 'time', text: t('sortVideoTime') }));
    this.d.listen(this.sortSel, 'change', () => { this.sort = this.sortSel.value; this.render(); });
    this.hiddenEl = h('span.pmuted');
    this.errorEl = h('div.perror', { hidden: true });
    this.list = h('div.plist');
    this.pane.append(
      h('div.composer.public', null,
        h('div.pwarn', { role: 'note', text: t('publicWarning') }),
        this.textarea,
        h('div.crow', null,
          h('label.check', null, this.linkTime, this.linkLabel),
          h('label.check', null, this.anon, h('span', { text: t('hideName') })),
          h('span.grow'), this.counter, this.postBtn)),
      h('div.ptools', null, this.sortSel, this.hiddenEl, h('span.grow'),
        h('button.link', { text: t('refresh'), onclick: () => this.load() })),
      this.errorEl,
      this.list,
    );
    this.updateLinkLabel();
    this.updateCounter(this.textarea, this.counter, this.postBtn);
  }

  updateLinkLabel() {
    this.linkLabel.textContent = t('linkTime', { time: fmtTime(this.p.video.currentTime, this.p.duration() >= 3600) });
  }

  updateCounter(area, counter, button) {
    const left = MAX_POST_LENGTH - area.value.length;
    counter.textContent = left < 0 ? t('tooLong', { n: -left }) : left < 500 ? t('charsLeft', { n: left }) : '';
    counter.classList.toggle('over', left < 0);
    button.disabled = left < 0 || !area.value.trim();
  }

  show(on) {
    this.visible = on;
    if (!on) return;
    this.updateLinkLabel();
    if (this.dirty) this.render();
    // Refresh when the tab is opened, at most once a minute (no live push channel).
    if (Date.now() - this.loadedAt > 60000) this.load();
  }

  showError(msg) {
    this.errorEl.textContent = msg;
    this.errorEl.hidden = !msg;
  }

  fail(e) {
    console.warn(TAG, 'discussion write failed', e);
    this.showError(t('saveFailed', { error: e.message || e }));
  }

  sorted() {
    const list = this.threads.slice();
    if (this.sort === 'time') list.sort((a, b) => (a.time == null ? Infinity : a.time) - (b.time == null ? Infinity : b.time));
    else list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return list;
  }

  render() {
    this.dirty = false;
    this.hiddenEl.textContent = this.hiddenCount ? t('hiddenPosts', { n: this.hiddenCount }) : '';
    const long = this.p.duration() >= 3600;
    const frag = document.createDocumentFragment();
    if (!this.threads.length) frag.append(h('div.pempty', { text: t('noPosts') }));
    for (const q of this.sorted()) frag.append(this.renderThread(q, long));
    this.list.textContent = '';
    this.list.append(frag);
  }

  renderThread(q, long) {
    const card = h('div.card.thread', null, this.renderComment(q, long));
    const n = q.replies.length;
    const footer = h('div.iactions');
    if (n) {
      const open = this.openReplies.has(q.id);
      footer.append(h('button.link', {
        text: open ? t('hideReplies') : (n === 1 ? t('oneReply') : t('replies', { n })),
        onclick: () => { if (open) this.openReplies.delete(q.id); else this.openReplies.add(q.id); this.render(); },
      }));
    }
    footer.append(h('button.link', { text: t('replyPublic'), onclick: () => { this.replyOpen = q.id; this.openReplies.add(q.id); this.render(); } }));
    card.append(footer);
    if (n && this.openReplies.has(q.id)) {
      const replies = h('div.replies');
      for (const r of q.replies) replies.append(this.renderComment(r, long));
      card.append(replies);
    }
    if (this.replyOpen === q.id) card.append(this.renderReplyComposer(q));
    return card;
  }

  renderComment(c, long) {
    const who = c.mine ? t('you') + (c.nameHidden ? ' (' + t('anonymous') + ')' : '') : (c.author || t('anonymous'));
    const badges = [];
    if (c.instructor) badges.push(h('span.badge.inst', { text: t('instructor') }));
    if (c.ta) badges.push(h('span.badge.inst', { text: t('ta') }));
    const time = c.time != null ? h('button.chiptime', { text: fmtTime(c.time, long), onclick: () => this.p.seek(c.time) }) : null;
    const date = h('span.pmuted', { text: formatDate(c.createdAt), title: c.createdAt || '' });
    const actions = h('div.cactions',
      null,
      h('button.link' + (c.liked ? '.on' : ''), {
        text: (c.liked ? t('unlike') : t('like')) + (c.likes ? ' · ' + c.likes : ''),
        onclick: (e) => this.write(e, () => this.api.like(e, c, !c.liked)),
      }),
      c.questionId ? null : h('button.link' + (c.saved ? '.on' : ''), {
        text: c.saved ? t('unsavePost') : t('savePost'),
        onclick: (e) => this.write(e, () => this.api.save(e, c, !c.saved)),
      }),
      c.mine ? this.deleteButton(c) : null,
      c.hasAttachment ? h('button.link', { text: t('attachment') + ' → ' + t('openInOriginal'), onclick: () => this.p.opts.onFallback('attachment') }) : null,
    );
    return h('div.comment' + (c.questionId ? '.reply' : ''), null,
      h('div.ihead', null, h('span.author', { text: who }), ...badges, time, h('span.grow'), date),
      h('div.ibody', { text: c.body }),
      actions);
  }

  deleteButton(c) {
    let armed = 0;
    const b = h('button.link.danger', { text: t('delete') });
    b.addEventListener('click', guard((e) => {
      if (!armed) {
        b.textContent = t('confirmDelete');
        armed = setTimeout(() => { armed = 0; b.textContent = t('delete'); }, 3000);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      this.write(e, () => this.api.deleteComment(e, c));
    }));
    return b;
  }

  renderReplyComposer(q) {
    const area = h('textarea.input', { rows: 2, placeholder: t('replyPlaceholder'), 'aria-label': t('replyPlaceholder') });
    const counter = h('span.counter');
    const anon = h('input', { type: 'checkbox' });
    const send = h('button.pbtn.primary', { text: t('replyPublic') });
    const submit = (e) => {
      const body = area.value.trim();
      if (!body || body.length > MAX_POST_LENGTH) return;
      send.disabled = true;
      this.write(e, () => this.api.reply(e, q.id, { body, anonymous: anon.checked }), () => { this.replyOpen = null; });
    };
    area.addEventListener('input', guard(() => this.updateCounter(area, counter, send)));
    area.addEventListener('keydown', guard((e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(e); } }));
    send.addEventListener('click', guard(submit));
    this.updateCounter(area, counter, send);
    setTimeout(() => area.focus(), 0);
    return h('div.composer.public.reply', null,
      h('div.pwarn', { role: 'note', text: t('publicWarning') }),
      area,
      h('div.crow', null, h('label.check', null, anon, h('span', { text: t('hideName') })), h('span.grow'), counter,
        h('button.pbtn', { text: t('cancel'), onclick: () => { this.replyOpen = null; this.render(); } }), send));
  }

  async post(e) {
    const body = this.textarea.value.trim();
    if (!body || body.length > MAX_POST_LENGTH) return;
    this.postBtn.disabled = true;
    const time = this.linkTime.checked ? this.p.video.currentTime : null;
    await this.write(e, () => this.api.postComment(e, { body, anonymous: this.anon.checked, time }), () => {
      this.textarea.value = '';
      this.anon.checked = false;
    });
    this.updateCounter(this.textarea, this.counter, this.postBtn);
  }

  // Runs one write, then reloads the list so it shows what the server stored.
  async write(e, fn, onSuccess) {
    try {
      await fn();
      if (onSuccess) onSuccess();
      this.showError('');
    } catch (err) {
      this.fail(err);
    }
    await this.load();
  }

  markers() {
    return this.threads.filter((q) => q.time != null).map((q) => ({
      time: q.time,
      kind: 'comment',
      label: t('markerComment') + ': ' + (q.body.length > 80 ? q.body.slice(0, 77) + '…' : q.body),
    }));
  }

  dispose() {
    this.d.dispose();
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  try {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch (e) {
    return iso.slice(0, 10);
  }
}

// ---- 49-markers.js ----
// ===================================================================================
// Progress-bar markers for timed items (notes, bookmarks, flags, discussion posts).
// The layer is rebuilt only when the data or the duration changes; hover and click use
// the seek bar's existing pointer handlers via nearest().
// ===================================================================================

class MarkersLayer {
  constructor(el) {
    this.el = el;
    this.items = [];
    this.dur = 0;
  }

  set(items, dur) {
    this.items = items.slice().sort((a, b) => a.time - b.time);
    this.dur = dur;
    this.render();
  }

  render() {
    const el = this.el;
    el.textContent = '';
    if (!this.dur) return;
    const frag = document.createDocumentFragment();
    for (const m of this.items) {
      if (m.time < 0 || m.time > this.dur) continue;
      const i = document.createElement('i');
      i.className = 'mk mk-' + m.kind;
      i.style.left = ((m.time / this.dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    el.appendChild(frag);
  }

  // Closest item within `px` pixels of fraction `f` on a bar `width` pixels wide.
  nearest(f, width, px) {
    if (!this.items.length || !this.dur || !width) return null;
    const t0 = f * this.dur;
    const tol = (px / width) * this.dur;
    let best = null;
    let bestD = tol;
    for (const m of this.items) {
      const dd = Math.abs(m.time - t0);
      if (dd <= bestD) { best = m; bestD = dd; }
      if (m.time > t0 + tol) break;
    }
    return best;
  }
}

// ---- 50-notice.js ----
// ===================================================================================
// Small, dismissible notice shown when we fall back to the original player.
// ===================================================================================

function notice(text) {
  const show = () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>div{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:min(420px,calc(100vw - 32px));'
      + 'padding:10px 12px 10px 14px;border-radius:10px;background:rgba(20,20,24,.94);color:#eee;'
      + 'font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:flex-start}'
      + 'button{all:unset;cursor:pointer;opacity:.7;padding:0 4px}button:hover{opacity:1}</style>'
      + '<div role="status"><span></span><button>✕</button></div>';
    root.querySelector('span').textContent = text;
    const close = root.querySelector('button');
    close.setAttribute('aria-label', t('close'));
    close.addEventListener('click', () => host.remove());
    document.body.appendChild(host);
    setTimeout(() => host.remove(), 10000);
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
}

// ---- 52-audio.js ----
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
// Tuned offline on real lecture audio: a recording 20 dB too quiet comes
// out at about -20 dBFS RMS without clipping; normal recordings are nearly unchanged; input
// peaking above full scale is held about 4 dB below it. The voice stage lowers 50 Hz hum
// by about 10 dB.
// ===================================================================================

const AUDIO_FEATURES = ['level', 'voice', 'mono'];
const LEVEL_TARGET_DB = -20;     // target short-term RMS after levelling
const LEVEL_MAX_GAIN_DB = 18;    // never boost more than this
const LEVEL_TICK_MS = 500;
const LIMIT_THRESHOLD_DB = -6;
const LIMIT_TRIM_DB = -3;        // offsets the compressor's built-in makeup gain

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
    const ctx = new Ctx();
    const n = {};
    n.src = ctx.createMediaElementSource(this.video);
    n.mono = ctx.createGain();
    n.mono.channelCount = 1;
    n.mono.channelCountMode = 'explicit';
    n.mono.channelInterpretation = 'speakers';
    n.highpass = ctx.createBiquadFilter();
    n.highpass.type = 'highpass';
    n.highpass.frequency.value = 100;
    n.highpass.Q.value = 0.7;
    n.presence = ctx.createBiquadFilter();
    n.presence.type = 'peaking';
    n.presence.frequency.value = 3000;
    n.presence.Q.value = 0.9;
    n.presence.gain.value = 4;
    n.leveller = ctx.createDynamicsCompressor();
    n.leveller.threshold.value = -34;
    n.leveller.knee.value = 12;
    n.leveller.ratio.value = 3.5;
    n.leveller.attack.value = 0.02;
    n.leveller.release.value = 0.4;
    n.makeup = ctx.createGain();
    n.limiter = ctx.createDynamicsCompressor();
    n.limiter.threshold.value = LIMIT_THRESHOLD_DB;
    n.limiter.knee.value = 0;
    n.limiter.ratio.value = 20;
    n.limiter.attack.value = 0.001;
    n.limiter.release.value = 0.1;
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
    if (pow < 1e-8) return; // silence: leave the gain alone
    this.avgPow = this.avgPow ? this.avgPow * 0.85 + pow * 0.15 : pow;
    const levelDb = 10 * Math.log10(this.avgPow);
    const wanted = clamp(LEVEL_TARGET_DB - levelDb, 0, LEVEL_MAX_GAIN_DB);
    this.makeupDb += clamp(wanted - this.makeupDb, -1.5, 0.75);
    this.n.makeup.gain.setTargetAtTime(Math.pow(10, this.makeupDb / 20), this.ctx.currentTime, 0.3);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    if (this.ctx) this.ctx.close().catch(() => {});
  }
}

// ---- 53-media-io.js ----
// ===================================================================================
// Shared helpers for background media work: HLS playlist parsing, ranged fetches, an
// IndexedDB cache, and a gate that keeps background downloads from competing with playback.
// ===================================================================================

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

// Media playlist -> { init: { url, offset, length } | null, segments: [{ start, dur, url, offset, length }] }.
// length is null for segments that are whole files.
function parseMediaPlaylist(text, base) {
  const out = { init: null, segments: [] };
  let dur = 0;
  let range = null;
  let t = 0;
  const nextOffset = new Map();
  const parseRange = (spec, url) => {
    const [len, off] = spec.split('@');
    const offset = off !== undefined ? +off : (nextOffset.get(url) || 0);
    nextOffset.set(url, offset + +len);
    return { offset, length: +len };
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      const url = new URL(a.URI, base).href;
      out.init = Object.assign({ url }, a.BYTERANGE ? parseRange(a.BYTERANGE, url) : { offset: 0, length: null });
    } else if (line.startsWith('#EXTINF:')) {
      dur = parseFloat(line.slice(8));
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      range = line.slice(17);
    } else if (!line.startsWith('#')) {
      const url = new URL(line, base).href;
      const r = range ? parseRange(range, url) : { offset: 0, length: null };
      out.segments.push({ start: t, dur, url, offset: r.offset, length: r.length });
      t += dur;
      range = null;
    }
  }
  return out;
}

function fetchOk(url, init) {
  return fetch(url, Object.assign({ credentials: 'include' }, init)).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url.split('?')[0]);
    return r;
  });
}

function fetchRange(url, offset, length, signal) {
  const headers = length === null ? {} : { Range: 'bytes=' + offset + '-' + (offset + length - 1) };
  return fetchOk(url, { headers, signal }).then((r) => r.arrayBuffer());
}

const idbCache = {
  db: null,
  open() {
    if (this.db) return this.db;
    this.db = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
      const req = indexedDB.open('echo360lite', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('cache')) req.result.createObjectStore('cache'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    this.db.catch(() => {});
    return this.db;
  },
  tx(mode, fn) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('cache', mode);
      const req = fn(tx.objectStore('cache'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  },
  get(key) { return this.tx('readonly', (s) => s.get(key)).catch(() => undefined); },
  put(key, value) { return this.tx('readwrite', (s) => s.put(value, key)).catch(() => undefined); },
  del(key) { return this.tx('readwrite', (s) => s.delete(key)).catch(() => undefined); },
};

// Background downloads must never compete with playback: turn() resolves only when the
// video is paused or has at least minBuffer seconds buffered ahead, after a pause of
// playingMs (pausedMs while paused). Everything rejects once the signal aborts.
class BackgroundGate {
  constructor(video, signal) {
    this.video = video;
    this.signal = signal;
  }

  wait(ms) {
    const signal = this.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      const onAbort = () => { clearTimeout(id); reject(new Error('aborted')); };
      const id = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async turn(playingMs, pausedMs, minBuffer) {
    const v = this.video;
    const need = minBuffer || 20;
    for (;;) {
      await this.wait(v.paused ? pausedMs : playingMs);
      if (v.seeking || v.readyState < 2) continue;
      if (v.paused || bufferedAhead(v) >= need) return;
    }
  }
}

function bufferedAhead(v) {
  const t = v.currentTime;
  const b = v.buffered;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) > t) return b.end(i) - t;
  return 0;
}

function idle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 1000 });
    else setTimeout(resolve, 0);
  });
}

// ---- 54-silence.js ----
// ===================================================================================
// Silence analysis, and the audio-track reader it is built on.
//
// Data sources, best first:
//   1. Transcript timing: gaps between cues. Free, because the cues are loaded anyway.
//   2. The separate audio rendition (about 46 kbps, 40 MB for two hours): fetched in 60 s
//      byte ranges only while playback has enough buffer, decoded to 16 kHz mono by the
//      browser's decoder (which runs off the main thread), and reduced to a loudness
//      envelope of one value per 0.1 s. The envelope is cached in IndexedDB, so a later
//      visit shows it at once and an unfinished analysis continues where it stopped.
//
// The pieces are meant to be reused by later features that read the same audio and cut it
// at the same pauses (for example local transcription):
//   HlsAudioTrack     open(), duration, chunkCount, chunkSpan(i), readChunk(i) -> { start, end, rate, pcm }
//   Envelope          step, length, db(i), dbAt(t), known(i), fill(start, pcm, rate), coverage()
//   findSilences(env, opts)            -> { silences: [{ start, end }], noiseDb, speechDb, thresholdDb }
//   silencesFromCues(cues, dur, opts)  -> [{ start, end }]
//   speechSpans(silences, dur, env, maxSec) -> speech between silences, each piece at most
//                                         maxSec long and cut at its quietest moment
//   SilenceAnalyzer   source, silences, track, env, progress; onChange
// ===================================================================================

const AUDIO_RATE = 16000;          // speech models expect this; plenty for loudness
const CHUNK_SEGMENTS = 6;          // 6 x 10 s HLS segments per request and decode
const ENV_STEP = 0.1;              // envelope resolution in seconds
const SILENCE_PAD = 0.5;           // seconds kept at each edge so skipping never clips speech
const SILENCE_BRIDGE = 1.5;        // a louder blip shorter than this inside a pause stays silent
const SILENCE_MIN_CHOICES = [15, 30, 60, 120];
const SILENCE_SENSITIVITY = { low: 0.2, normal: 0.3, high: 0.4 };

// ---- the audio track ----

// URI of the audio rendition used by the lowest-bandwidth variant of a master playlist.
function pickAudioRendition(master) {
  const groups = new Map();
  let best = null;
  const lines = String(master).split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI && !groups.has(a['GROUP-ID'])) groups.set(a['GROUP-ID'], a.URI);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice(18));
      const bw = +a.BANDWIDTH || Infinity;
      if (a.AUDIO && groups.has(a.AUDIO) && (!best || bw < best.bw)) best = { bw, uri: groups.get(a.AUDIO) };
    }
  }
  return best ? best.uri : (groups.size ? groups.values().next().value : null);
}

// Reads the separate audio rendition of an HLS stream as PCM, one chunk at a time.
class HlsAudioTrack {
  constructor(masterUrl) {
    this.masterUrl = masterUrl;
    this.segments = [];
    this.init = null;
    this.initBytes = null;
    this.duration = 0;
  }

  async open(signal) {
    const master = await (await fetchOk(this.masterUrl, { signal })).text();
    const uri = pickAudioRendition(master);
    if (!uri) throw new Error('no separate audio rendition');
    this.playlistUrl = new URL(uri, this.masterUrl).href;
    const pl = parseMediaPlaylist(await (await fetchOk(this.playlistUrl, { signal })).text(), this.playlistUrl);
    if (!pl.segments.length) throw new Error('empty audio playlist');
    this.init = pl.init;
    this.segments = pl.segments;
    const last = pl.segments[pl.segments.length - 1];
    this.duration = last.start + last.dur;
    return this;
  }

  get chunkCount() { return Math.ceil(this.segments.length / CHUNK_SEGMENTS); }

  chunkSpan(i) {
    const segs = this.segments.slice(i * CHUNK_SEGMENTS, (i + 1) * CHUNK_SEGMENTS);
    const last = segs[segs.length - 1];
    return { start: segs[0].start, end: last.start + last.dur };
  }

  chunkAt(t) {
    return clamp(Math.floor(t / (this.duration / this.segments.length) / CHUNK_SEGMENTS), 0, this.chunkCount - 1);
  }

  // Decoded audio of chunk i: { start, end, rate, pcm } with pcm a mono Float32Array.
  async readChunk(i, signal, rate) {
    const sampleRate = rate || AUDIO_RATE;
    const segs = this.segments.slice(i * CHUNK_SEGMENTS, (i + 1) * CHUNK_SEGMENTS);
    if (!segs.length) throw new Error('no chunk ' + i);
    if (this.init && !this.initBytes) this.initBytes = await fetchRange(this.init.url, this.init.offset, this.init.length, signal);
    // Adjacent byte ranges of the same file are fetched with one request.
    const reqs = [];
    for (const s of segs) {
      const prev = reqs[reqs.length - 1];
      if (prev && s.length !== null && prev.length !== null && prev.url === s.url && prev.offset + prev.length === s.offset) prev.length += s.length;
      else reqs.push({ url: s.url, offset: s.offset, length: s.length });
    }
    const parts = [];
    if (this.initBytes) parts.push(this.initBytes);
    for (const r of reqs) parts.push(await fetchRange(r.url, r.offset, r.length, signal));
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) { bytes.set(new Uint8Array(p), o); o += p.byteLength; }
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ab = await new Offline(1, sampleRate, sampleRate).decodeAudioData(bytes.buffer);
    let pcm = ab.getChannelData(0);
    if (ab.numberOfChannels > 1) {
      pcm = Float32Array.from(pcm);
      for (let c = 1; c < ab.numberOfChannels; c++) {
        const ch = ab.getChannelData(c);
        for (let k = 0; k < pcm.length; k++) pcm[k] += ch[k];
      }
      for (let k = 0; k < pcm.length; k++) pcm[k] /= ab.numberOfChannels;
    }
    const last = segs[segs.length - 1];
    return { start: segs[0].start, end: last.start + last.dur, rate: ab.sampleRate, pcm };
  }
}

// ---- loudness envelope ----

// Speech-band level (roughly 150 Hz to 4 kHz, so air-conditioning rumble counts as quiet)
// per ENV_STEP seconds, stored as one byte: 0 = not analysed yet, 1..255 = -100..0 dBFS.
class Envelope {
  constructor(duration, data) {
    this.step = ENV_STEP;
    this.length = Math.max(1, Math.ceil(duration / ENV_STEP));
    this.data = data && data.length === this.length ? data : new Uint8Array(this.length);
  }

  known(i) { return this.data[i] !== 0; }

  db(i) {
    const v = this.data[i];
    return v ? -100 + (v - 1) / 2.54 : NaN;
  }

  dbAt(t) { return this.db(clamp(Math.floor(t / this.step), 0, this.length - 1)); }

  fill(start, pcm, rate) {
    const per = Math.round(rate * this.step);
    // One-pole high-pass and low-pass filters; the state restarts with every chunk.
    const hpA = Math.exp(-2 * Math.PI * 150 / rate);
    const lpA = Math.exp(-2 * Math.PI * 4000 / rate);
    let hpPrevIn = 0;
    let hpPrevOut = 0;
    let lp = 0;
    const first = Math.round(start / this.step);
    for (let f = 0; (f + 1) * per <= pcm.length; f++) {
      const i = first + f;
      let sum = 0;
      for (let k = f * per, end = k + per; k < end; k++) {
        const x = pcm[k];
        const hp = hpA * (hpPrevOut + x - hpPrevIn);
        hpPrevIn = x;
        hpPrevOut = hp;
        lp = lp * lpA + hp * (1 - lpA);
        sum += lp * lp;
      }
      if (i < 0 || i >= this.length) continue;
      const db = 10 * Math.log10(sum / per + 1e-12);
      this.data[i] = 1 + Math.round((clamp(db, -100, 0) + 100) * 2.54);
    }
  }

  coverage() {
    let n = 0;
    for (let i = 0; i < this.length; i++) if (this.data[i]) n++;
    return n / this.length;
  }

  // Share of frames analysed in [start, end).
  coverageOf(start, end) {
    const a = clamp(Math.floor(start / this.step), 0, this.length);
    const b = clamp(Math.ceil(end / this.step), a, this.length);
    let n = 0;
    for (let i = a; i < b; i++) if (this.data[i]) n++;
    return b > a ? n / (b - a) : 1;
  }
}

// ---- finding silence ----

function percentile(sorted, p) {
  return sorted[clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1)];
}

// Quiet stretches of an envelope. The threshold adapts to the recording: a point between
// its noise floor (10th percentile) and its speech level (90th percentile), so a recording
// that is quiet overall is not marked silent as a whole.
function findSilences(env, opts) {
  const o = Object.assign({ minSec: 30, sensitivity: 'normal', pad: SILENCE_PAD, bridge: SILENCE_BRIDGE }, opts);
  const vals = [];
  for (let i = 0; i < env.length; i++) if (env.known(i)) vals.push(env.db(i));
  const result = { silences: [], noiseDb: NaN, speechDb: NaN, thresholdDb: NaN };
  if (vals.length < 60 / env.step) return result; // less than a minute analysed
  vals.sort((a, b) => a - b);
  const noise = percentile(vals, 0.1);
  const speech = percentile(vals, 0.9);
  const k = SILENCE_SENSITIVITY[o.sensitivity] || SILENCE_SENSITIVITY.normal;
  let thr = noise + (speech - noise) * k;
  // No dynamics at all: either everything is silent (a muted microphone) or nothing is.
  if (speech - noise < 6) thr = speech < -55 ? 1 : -101;
  Object.assign(result, { noiseDb: noise, speechDb: speech, thresholdDb: thr });

  // Quiet runs in frames; unanalysed frames end a run.
  const runs = [];
  let a = -1;
  for (let i = 0; i <= env.length; i++) {
    const quiet = i < env.length && env.known(i) && env.db(i) < thr;
    if (quiet && a < 0) a = i;
    else if (!quiet && a >= 0) { runs.push([a, i]); a = -1; }
  }
  // Bridge a short louder blip (a cough, a door) between two long quiet runs. Quiet talk
  // also has short gaps between words, but there the quiet runs on either side are short,
  // so it stays speech.
  const bridge = Math.round(o.bridge / env.step);
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    let ok = prev && r[0] - prev[1] <= bridge && prev[1] - prev[0] >= 2 * bridge && r[1] - r[0] >= 2 * bridge;
    if (ok) for (let i = prev[1]; i < r[0]; i++) if (!env.known(i)) { ok = false; break; }
    if (ok) prev[1] = r[1]; else merged.push(r.slice());
  }
  for (const [s, e] of merged) {
    const start = s * env.step + o.pad;
    const end = Math.min(e * env.step, env.length * env.step) - o.pad;
    if (end - start >= o.minSec) result.silences.push({ start, end });
  }
  return result;
}

// Gaps of at least minSec between transcript cues (and before the first / after the last).
function silencesFromCues(cues, duration, opts) {
  const o = Object.assign({ minSec: 30, pad: SILENCE_PAD }, opts);
  const out = [];
  let lastEnd = 0;
  const gap = (a, b) => {
    const start = a + (a > 0 ? o.pad : 0);
    const end = b - o.pad;
    if (end - start >= o.minSec) out.push({ start, end });
  };
  for (const c of cues) {
    if (c.start > lastEnd) gap(lastEnd, c.start);
    lastEnd = Math.max(lastEnd, c.end);
  }
  if (isFinite(duration) && duration > lastEnd) gap(lastEnd, duration + o.pad);
  return out;
}

// Speech between the silences, split into pieces no longer than maxSec. A long piece is
// cut at the quietest analysed moment in the last half of each window.
function speechSpans(silences, duration, env, maxSec) {
  const spans = [];
  let t = 0;
  const push = (a, b) => {
    while (b - a > maxSec) {
      let cut = a + maxSec;
      if (env) {
        let best = Infinity;
        const from = Math.ceil((a + maxSec / 2) / env.step);
        const to = Math.min(Math.floor((a + maxSec) / env.step), env.length - 1);
        for (let i = from; i <= to; i++) {
          if (env.known(i) && env.db(i) < best) { best = env.db(i); cut = i * env.step; }
        }
      }
      spans.push({ start: a, end: cut });
      a = cut;
    }
    if (b > a) spans.push({ start: a, end: b });
  };
  for (const s of silences) {
    if (s.start > t) push(t, s.start);
    t = Math.max(t, s.end);
  }
  if (duration > t) push(t, duration);
  return spans;
}

// Index of the silence containing t, or -1. Silences are sorted and disjoint.
function silenceIndexAt(silences, t) {
  let lo = 0;
  let hi = silences.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (silences[mid].end <= t) lo = mid + 1;
    else if (silences[mid].start > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}

// ---- the controller used by the player ----

class SilenceAnalyzer {
  // opts: { lesson, video, masterUrl, disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.masterUrl = opts.masterUrl;
    this.onChange = opts.onChange || (() => {});
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.source = 'pending';     // pending | transcript | audio | unavailable
    this.reason = '';
    this.progress = 0;
    this.silences = [];
    this.cues = null;
    this.track = null;
    this.env = null;
    this.options = { minSec: 30, sensitivity: 'normal' };
    this.stats = null;
  }

  setOptions(o) {
    Object.assign(this.options, o);
    this.recompute();
  }

  // Called once the transcript is known ([] when there is none).
  start(cues) {
    if (cues && cues.length && !store.get('silenceFromAudio', false)) {
      this.cues = cues;
      this.source = 'transcript';
      this.progress = 1;
      this.recompute();
      return;
    }
    if (!this.masterUrl) { this.fail('noAudio'); return; }
    this.source = 'audio';
    this.runAudio().catch((e) => {
      if (this.ac.signal.aborted) return;
      console.warn(TAG, 'silence analysis stopped:', e && e.message ? e.message : e);
      this.fail('error');
    });
  }

  fail(reason) {
    this.source = 'unavailable';
    this.reason = reason;
    this.silences = [];
    this.onChange();
  }

  recompute() {
    const dur = this.duration();
    if (this.source === 'transcript') {
      this.silences = silencesFromCues(this.cues, dur, { minSec: this.options.minSec });
    } else if (this.source === 'audio' && this.env) {
      const r = findSilences(this.env, this.options);
      this.silences = r.silences;
      this.stats = { noiseDb: r.noiseDb, speechDb: r.speechDb, thresholdDb: r.thresholdDb };
    } else return;
    this.onChange();
  }

  duration() {
    const v = this.video.duration;
    return isFinite(v) && v > 0 ? v : this.lesson.duration;
  }

  async runAudio() {
    const signal = this.ac.signal;
    if (navigator.connection && navigator.connection.saveData) { this.fail('saveData'); return; }
    const key = 'silence-env:' + this.lesson.mediaId;
    const cached = this.lesson.mediaId ? await idbCache.get(key) : undefined;
    await this.gate.wait(cached ? 0 : 8000); // let playback start first
    const track = await new HlsAudioTrack(this.masterUrl).open(signal);
    this.track = track;
    const data = cached && cached.v === 1 && cached.step === ENV_STEP ? cached.data : null;
    this.env = new Envelope(track.duration, data);
    this.progress = this.env.coverage();
    this.recompute();

    // Upcoming audio first, then the rest from the beginning.
    const n = track.chunkCount;
    const from = track.chunkAt(this.video.currentTime || 0);
    const order = [];
    for (let k = 0; k < n; k++) order.push((from + k) % n);
    let sinceSave = 0;
    for (const i of order) {
      const span = track.chunkSpan(i);
      if (this.env.coverageOf(span.start, span.end) > 0.9) continue;
      await this.gate.turn(2000, 400);
      const chunk = await track.readChunk(i, signal);
      await idle();
      if (signal.aborted) return;
      this.env.fill(chunk.start, chunk.pcm, chunk.rate);
      this.progress = this.env.coverage();
      if (++sinceSave >= 5) {
        sinceSave = 0;
        this.save(key);
        this.recompute();
      }
    }
    this.progress = 1;
    this.save(key);
    this.recompute();
  }

  save(key) {
    if (this.lesson.mediaId) idbCache.put(key, { v: 1, step: ENV_STEP, data: this.env.data, at: Date.now() });
  }

}

// ---- 56-slides.js ----
// ===================================================================================
// Slide chapters: find where the screen view changes to a new slide.
//
// Sources, best first:
//   1. Chapter or slide data from Echo360 itself. None of the recordings checked so far had
//      any (cfg.chapters, slide decks and scenes were all empty), so this is not used yet.
//   2. Keyframes of the screen view. Every 10 s HLS segment starts with a keyframe; reading
//      just the start of each segment (about 20 KB at 360p, 15 MB for two hours) and
//      decoding it with WebCodecs gives the whole lecture at 10 s resolution. Each change is
//      then pinned to about 1 s by decoding the one segment it happened in. Downloads only
//      run while playback has enough buffer, and the result is cached in IndexedDB.
//   3. Echo360's preview thumbnails (one per minute), when WebCodecs is not available.
//      They are also shown at once while the keyframes are being read.
//
// Which view is the screen: slides, code and documents have large flat areas, camera
// pictures do not (sensor noise), so the view with the most flat area is used.
//
// Change detection compares tiny 32 x 18 versions of two frames. Small changes (mouse
// pointer, laser pointer, ink added to a slide, a small animation, scrolling code) touch
// only a small share of the pixels and are not a new slide. A run of quick changes (scrolling
// code, flicking through slides) becomes one chapter instead of many.
//
// Reusable pieces (slide text recognition will read sharper keyframes the same way):
//   HlsVideoReader   open(), segments, segmentAt(t), keyframe(i) -> VideoFrame,
//                    frames(i, stepSec, onFrame)
//   frameSignature(img), frameDistance(a, b), sameView(a, b)
//   buildScenes(samples, duration, opts) -> [{ start, end, rep }]
//   SlideAnalyzer    chapters: [{ start, end, precise, repTime, thumb }], screenIndex, reader
// ===================================================================================

const SIG_W = 32;
const SIG_H = 18;
const KEYFRAME_PROBE_BYTES = 24 * 1024;  // moof (~2.5 KB) + a 360p keyframe (~17 KB), usually
const SCENE_MIN_SEC = 20;                // shorter scenes in a row are one chapter
const SCENE_REVISIT_SEC = 180;           // going back to a view shown this recently is no new chapter
const SCENE_DETOUR_SEC = 60;             // a shorter excursion that comes back belongs to the chapter
const SCREEN_FLAT_MIN = 0.35;            // share of flat pixels that marks a screen view
const CHAPTER_THUMB_W = 192;

// ---- fragmented MP4 ----

function mp4Boxes(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr) break;
    out.push({ type, start: p, body: p + hdr, end: Math.min(p + size, end), size });
    p += size;
  }
  return out;
}

function mp4Find(dv, start, end, path) {
  let box = { body: start, end };
  for (const type of path) {
    box = mp4Boxes(dv, box.body, box.end).find((b) => b.type === type);
    if (!box) return null;
  }
  return box;
}

// Init segment of an H.264 track -> what VideoDecoder.configure() needs.
function parseVideoInit(buf) {
  const dv = new DataView(buf);
  const stsd = mp4Find(dv, 0, dv.byteLength, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  const mdhd = mp4Find(dv, 0, dv.byteLength, ['moov', 'trak', 'mdia', 'mdhd']);
  if (!stsd || !mdhd) throw new Error('unexpected init segment');
  const entry = mp4Boxes(dv, stsd.body + 8, stsd.end)[0];
  if (!entry || (entry.type !== 'avc1' && entry.type !== 'avc3')) throw new Error('not H.264: ' + (entry && entry.type));
  const avcC = mp4Boxes(dv, entry.body + 78, entry.end).find((b) => b.type === 'avcC');
  if (!avcC) throw new Error('no avcC');
  const hex = (o) => dv.getUint8(avcC.body + o).toString(16).padStart(2, '0');
  const v = dv.getUint8(mdhd.body);
  return {
    codec: entry.type + '.' + hex(1) + hex(2) + hex(3),
    description: new Uint8Array(buf.slice(avcC.body, avcC.end)),
    timescale: dv.getUint32(mdhd.body + (v ? 20 : 12)),
    width: dv.getUint16(entry.body + 24),
    height: dv.getUint16(entry.body + 26),
  };
}

// Samples of the first track fragment, in decode order: [{ offset, size, time, key }] with
// offsets relative to the start of `buf` and time in timescale units (presentation time).
// Samples whose bytes are not in `buf` are still listed (the caller checks the size).
function parseFragment(buf, segmentOffset) {
  const dv = new DataView(buf);
  const moof = mp4Boxes(dv, 0, dv.byteLength).find((b) => b.type === 'moof');
  if (!moof) throw new Error('no moof');
  const traf = mp4Find(dv, moof.body, moof.end, ['traf']);
  const kids = mp4Boxes(dv, traf.body, traf.end);
  const tfhd = kids.find((b) => b.type === 'tfhd');
  const tfdt = kids.find((b) => b.type === 'tfdt');
  const trun = kids.find((b) => b.type === 'trun');
  if (!tfhd || !trun) throw new Error('unexpected fragment');
  const hf = dv.getUint32(tfhd.body) & 0xffffff;
  let p = tfhd.body + 8;
  let base = moof.start;
  if (hf & 0x1) { base = Number(dv.getBigUint64(p)) - (segmentOffset || 0); p += 8; }
  if (hf & 0x2) p += 4;
  let defDur = 0;
  let defSize = 0;
  let defFlags = 0;
  if (hf & 0x8) { defDur = dv.getUint32(p); p += 4; }
  if (hf & 0x10) { defSize = dv.getUint32(p); p += 4; }
  if (hf & 0x20) { defFlags = dv.getUint32(p); p += 4; }
  let t = 0;
  if (tfdt) t = dv.getUint8(tfdt.body) ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);
  const rf = dv.getUint32(trun.body) & 0xffffff;
  const version = dv.getUint8(trun.body);
  const count = dv.getUint32(trun.body + 4);
  p = trun.body + 8;
  let offset = base;
  if (rf & 0x1) { offset = base + dv.getInt32(p); p += 4; }
  let firstFlags = null;
  if (rf & 0x4) { firstFlags = dv.getUint32(p); p += 4; }
  const samples = [];
  for (let i = 0; i < count; i++) {
    let dur = defDur;
    let size = defSize;
    let flags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
    let cto = 0;
    if (rf & 0x100) { dur = dv.getUint32(p); p += 4; }
    if (rf & 0x200) { size = dv.getUint32(p); p += 4; }
    if (rf & 0x400) { flags = dv.getUint32(p); p += 4; }
    if (rf & 0x800) { cto = version ? dv.getInt32(p) : dv.getUint32(p); p += 4; }
    // sample_is_non_sync_sample is bit 16 of the flags.
    samples.push({ offset, size, time: t + cto, key: !(flags & 0x10000) });
    offset += size;
    t += dur;
  }
  return { samples, end: offset };
}

// ---- reading frames from an HLS video stream ----

// Variant URIs of a master playlist with their heights, lowest first.
function videoVariants(master, base) {
  const out = [];
  const lines = String(master).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = parseAttrs(lines[i].slice(18));
    const uri = (lines.slice(i + 1).find((l) => l && !l.startsWith('#')) || '').trim();
    const h = a.RESOLUTION ? +a.RESOLUTION.split('x')[1] : 0;
    if (uri) out.push({ uri: new URL(uri, base).href, height: h, bandwidth: +a.BANDWIDTH || 0 });
  }
  return out.sort((x, y) => x.height - y.height || x.bandwidth - y.bandwidth);
}

class HlsVideoReader {
  // maxHeight: the tallest rendition to use (the smallest one if none is small enough).
  // minHeight (optional): use the smallest rendition at least this tall instead (the
  // tallest one if none is).
  constructor(masterUrl, maxHeight, minHeight) {
    this.masterUrl = masterUrl;
    this.maxHeight = maxHeight || 360;
    this.minHeight = minHeight || 0;
    this.segments = [];
    this.info = null;
    this.bytes = 0;          // downloaded so far
    this.lastNeed = 0;       // bytes the last keyframe needed
  }

  static supported() {
    return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
  }

  async open(signal) {
    const master = await (await fetchOk(this.masterUrl, { signal })).text();
    let url = this.masterUrl;
    if (/#EXT-X-STREAM-INF/.test(master)) {
      const vs = videoVariants(master, this.masterUrl);
      let pick;
      if (this.minHeight) {
        pick = vs.find((v) => v.height >= this.minHeight) || vs[vs.length - 1];
      } else {
        const fit = vs.filter((v) => v.height && v.height <= this.maxHeight);
        pick = fit.length ? fit[fit.length - 1] : vs[0];
      }
      if (!pick) throw new Error('no video variant');
      url = pick.uri;
    }
    const pl = parseMediaPlaylist(await (await fetchOk(url, { signal })).text(), url);
    if (!pl.init || !pl.segments.length || pl.segments.some((s) => s.length === null)) throw new Error('unsupported playlist layout');
    this.segments = pl.segments;
    const init = await fetchRange(pl.init.url, pl.init.offset, pl.init.length, signal);
    this.info = parseVideoInit(init);
    const cfg = { codec: this.info.codec, description: this.info.description };
    const ok = await VideoDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (!ok.supported) throw new Error('decoder not supported: ' + this.info.codec);
    const last = this.segments[this.segments.length - 1];
    this.duration = last.start + last.dur;
    return this;
  }

  segmentAt(t) {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // Decodes encoded samples; onFrame(frame) is called in presentation order and the frame
  // is closed right after it returns.
  async decode(chunks, onFrame) {
    let failed = null;
    const dec = new VideoDecoder({
      output: (frame) => { try { if (!failed) onFrame(frame); } catch (e) { failed = e; } finally { frame.close(); } },
      error: (e) => { failed = failed || e; },
    });
    try {
      dec.configure({ codec: this.info.codec, description: this.info.description, optimizeForLatency: true });
      for (const c of chunks) dec.decode(c);
      await dec.flush();
    } finally {
      if (dec.state !== 'closed') dec.close();
    }
    if (failed) throw failed;
  }

  // First frame of segment i, as a signature-ready callback: fn(frame) is called once.
  async keyframe(i, signal, fn) {
    const s = this.segments[i];
    // A keyframe grows with the picture (about 20 KB at 360p) and its content; asking for a
    // little more than the last one needed usually saves a second request.
    const base = Math.round(KEYFRAME_PROBE_BYTES * Math.max(1, ((this.info && this.info.height) || 360) / 360) ** 2);
    const probe = Math.max(base, Math.round((this.lastNeed || 0) * 1.2));
    let buf = await fetchRange(s.url, s.offset, Math.min(s.length, probe), signal);
    this.bytes += buf.byteLength;
    const frag = parseFragment(buf, s.offset);
    const k = frag.samples[0];
    if (!k || !k.key) throw new Error('segment does not start with a keyframe');
    this.lastNeed = k.offset + k.size;
    if (k.offset + k.size > buf.byteLength) {
      // Only the rest of it.
      const more = await fetchRange(s.url, s.offset + buf.byteLength, Math.min(s.length, k.offset + k.size) - buf.byteLength, signal);
      this.bytes += more.byteLength;
      const all = new Uint8Array(buf.byteLength + more.byteLength);
      all.set(new Uint8Array(buf), 0);
      all.set(new Uint8Array(more), buf.byteLength);
      buf = all.buffer;
    }
    const ts = this.info.timescale;
    const chunk = new EncodedVideoChunk({ type: 'key', timestamp: Math.round((k.time / ts) * 1e6), data: new Uint8Array(buf, k.offset, k.size) });
    let got = false;
    await this.decode([chunk], (f) => { if (!got) { got = true; fn(f, k.time / ts); } });
    if (!got) throw new Error('no frame decoded');
  }

  // Every frame of segment i at least stepSec apart: fn(frame, seconds).
  async frames(i, stepSec, signal, fn) {
    const s = this.segments[i];
    const buf = await fetchRange(s.url, s.offset, s.length, signal);
    const frag = parseFragment(buf, s.offset);
    const ts = this.info.timescale;
    const chunks = frag.samples
      .filter((x) => x.offset + x.size <= buf.byteLength)
      .map((x, j) => new EncodedVideoChunk({ type: j === 0 || x.key ? 'key' : 'delta', timestamp: Math.round((x.time / ts) * 1e6), data: new Uint8Array(buf, x.offset, x.size) }));
    let next = -Infinity;
    await this.decode(chunks, (f) => {
      const t = f.timestamp / 1e6;
      if (t + 1e-6 < next) return;
      next = t + stepSec;
      fn(f, t);
    });
  }
}

// ---- comparing frames ----

let sigCtx = null;
function sigContext() {
  if (!sigCtx) {
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(SIG_W, SIG_H) : Object.assign(document.createElement('canvas'), { width: SIG_W, height: SIG_H });
    sigCtx = c.getContext('2d', { willReadFrequently: true });
  }
  return sigCtx;
}

// 32 x 18 RGB thumbnail of any drawable (VideoFrame, ImageBitmap, <video>, <img>).
function frameSignature(img) {
  const g = sigContext();
  g.drawImage(img, 0, 0, SIG_W, SIG_H);
  return Uint8Array.from(g.getImageData(0, 0, SIG_W, SIG_H).data.filter((x, i) => i % 4 !== 3));
}

// corr: correlation of the two pictures; mad: mean absolute difference (0-255); changed:
// share of pixels whose brightness moved by more than 40.
function frameDistance(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  let mad = 0;
  let changed = 0;
  for (let i = 0; i < n; i += 3) {
    const la = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
    const lb = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
    if (Math.abs(la - lb) > 40) changed++;
  }
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; mad += Math.abs(a[i] - b[i]); }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  return { corr: saa && sbb ? sab / Math.sqrt(saa * sbb) : (saa === sbb ? 1 : 0), mad: mad / n, changed: changed / (n / 3) };
}

// Same slide? Measured on a real lecture (keyframes 10 s apart): ink added to a slide and
// scrolling or typing in a code editor change 6-15% of the pixels; a new slide changes at
// least 16%, switching between slides and an editor more than half.
function sameView(a, b) {
  const d = frameDistance(a, b);
  return d.changed < 0.16 || d.mad <= 8 || (d.corr >= 0.9 && d.mad <= 20);
}

// Stricter test for "back to the same picture" (see buildScenes).
function sameViewStrict(a, b) {
  const d = frameDistance(a, b);
  return d.changed < 0.06 || d.mad <= 6;
}

// Share of pixels that equal their right and lower neighbours: high for slides and code,
// low for camera pictures.
function flatShare(img) {
  const W = 160;
  const H = 90;
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  let n = 0;
  let tot = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      const l = d[i] + d[i + 1] + d[i + 2];
      tot++;
      if (Math.abs(l - d[i + 4] - d[i + 5] - d[i + 6]) <= 3 && Math.abs(l - d[i + W * 4] - d[i + W * 4 + 1] - d[i + W * 4 + 2]) <= 3) n++;
    }
  }
  return n / tot;
}

// ---- scenes ----

// samples: [{ t, sig }] in time order. Returns scenes [{ start, end, rep }] where rep is the
// sample that best shows the chapter: the last sample (ink and builds are complete there)
// of the view it stays on longest. A scene starts at its first sample; refinement moves
// it earlier.
//
// Lecturers often switch back and forth between a slide and a code editor or a question
// board. Coming back to something shown in the last few minutes is not a new chapter, and
// a short excursion (under detourSec) that comes back to the previous chapter becomes part
// of it. The "back to the same picture" test is stricter than the same-slide test, because
// different slides with the same layout can pass the latter. Of the remaining scenes,
// several short ones in a row are one chapter, and a single short one (a transition caught
// mid-way) joins the next.
function buildScenes(samples, duration, opts) {
  const o = Object.assign({ minSec: SCENE_MIN_SEC, revisitSec: SCENE_REVISIT_SEC, detourSec: SCENE_DETOUR_SEC, same: sameView, revisit: sameViewStrict }, opts);
  if (!samples.length) return [];
  const tAt = (k) => (k < samples.length ? samples[k].t : duration);
  // Runs of the same view.
  const runs = [{ a: 0, b: 0 }];
  for (let k = 1; k < samples.length; k++) {
    if (o.same(samples[k - 1].sig, samples[k].sig)) runs[runs.length - 1].b = k;
    else runs.push({ a: k, b: k });
  }
  const raw = [{ a: 0, b: runs[0].b, runs: [runs[0]] }];
  for (let i = 1; i < runs.length; i++) {
    const r = runs[i];
    const t0 = samples[r.a].t;
    let seen = -1;
    for (let j = i - 1; j >= 0 && seen < 0 && samples[runs[j].b].t >= t0 - o.revisitSec; j--) {
      if (o.revisit(samples[runs[j].b].sig, samples[r.a].sig) || o.revisit(samples[runs[j].a].sig, samples[r.a].sig)) seen = j;
    }
    const cur = raw[raw.length - 1];
    if (seen < 0) { raw.push({ a: r.a, b: r.b, runs: [r] }); continue; }
    cur.b = r.b;
    cur.runs.push(r);
    // Back to the chapter before a short excursion: the excursion joins that chapter.
    if (raw.length >= 2 && runs[seen].b < cur.a && t0 - samples[cur.a].t < o.detourSec) {
      const prev = raw[raw.length - 2];
      prev.b = cur.b;
      prev.runs.push(...cur.runs);
      raw.pop();
    }
  }
  const len = (r) => tAt(r.b + 1) - samples[r.a].t;
  const merged = [];
  for (let i = 0; i < raw.length; i++) {
    const r = { a: raw[i].a, b: raw[i].b, runs: raw[i].runs.slice() };
    const absorb = (x) => { r.b = x.b; r.runs.push(...x.runs); };
    if (len(r) < o.minSec) {
      // Absorb following short scenes into one busy stretch.
      let j = i;
      while (j + 1 < raw.length && len(raw[j + 1]) < o.minSec) j++;
      if (j > i) { for (let q = i + 1; q <= j; q++) absorb(raw[q]); i = j; } else if (i + 1 < raw.length) { absorb(raw[i + 1]); i++; }
    }
    merged.push(r);
  }
  return merged.map((r, i) => {
    let best = r.runs[0];
    for (const x of r.runs) if (tAt(x.b + 1) - samples[x.a].t >= tAt(best.b + 1) - samples[best.a].t) best = x;
    return {
      start: i === 0 ? 0 : samples[r.a].t,
      end: i + 1 < merged.length ? samples[merged[i + 1].a].t : duration,
      rep: best.b,
    };
  });
}

function chapterIndexAt(chapters, t) {
  let lo = 0;
  let hi = chapters.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chapters[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return k;
}

// A small copy of a frame, made synchronously (a VideoFrame is only valid in its callback).
function smallBitmap(img, w) {
  const c = new OffscreenCanvas(w, Math.round((w * 9) / 16));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function bitmapToBlob(canvas) {
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

// ---- the controller used by the player ----

class SlideAnalyzer {
  // opts: { lesson, video, disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.onChange = opts.onChange || (() => {});
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.state = 'pending';   // pending | thumbnails | keyframes | done | unavailable
    this.progress = 0;
    this.chapters = [];
    this.screenIndex = null;
    this.reader = null;
    this.urls = [];
    this.d.add(() => { for (const u of this.urls) URL.revokeObjectURL(u); });
  }

  start() {
    this.run().catch((e) => {
      if (this.ac.signal.aborted) return;
      console.warn(TAG, 'slide detection stopped:', e && e.message ? e.message : e);
      if (!this.chapters.length) { this.state = 'unavailable'; this.onChange(); }
    });
  }

  duration() {
    const v = this.video.duration;
    return isFinite(v) && v > 0 ? v : this.lesson.duration;
  }

  thumbUrl(blob) {
    if (!this.urlOf) this.urlOf = new Map();
    let u = this.urlOf.get(blob);
    if (!u) {
      u = URL.createObjectURL(blob);
      this.urlOf.set(blob, u);
      this.urls.push(u);
    }
    return u;
  }

  async run() {
    const signal = this.ac.signal;
    const key = 'slides:' + this.lesson.mediaId;
    const cached = this.lesson.mediaId ? await idbCache.get(key) : undefined;
    if (cached && cached.v === 1 && Array.isArray(cached.chapters)) {
      this.screenIndex = cached.screen;
      this.chapters = cached.chapters.map((c) => Object.assign({}, c, { thumb: c.blob ? this.thumbUrl(c.blob) : c.thumb }));
      this.state = 'done';
      this.progress = 1;
      this.onChange();
      return;
    }
    // Which view is the screen is needed early (quality settings are per view); it only
    // takes a few small thumbnails.
    const screen = await this.findScreen(signal);
    if (!screen) { this.state = 'unavailable'; this.onChange(); return; }
    this.screenIndex = screen.source.index;
    this.onChange();
    await this.gate.wait(5000); // let playback start first
    if (screen.thumbs) this.fromThumbnails(screen.thumbs);
    if (!HlsVideoReader.supported() || (navigator.connection && navigator.connection.saveData)) {
      if (this.chapters.length) { this.state = 'done'; this.progress = 1; this.onChange(); }
      return;
    }
    await this.fromKeyframes(screen.source, signal);
    this.save(key);
  }

  // The source whose thumbnails have the most flat area, if it looks like a screen.
  async findScreen(signal) {
    const sets = this.lesson.thumbnails || [];
    let best = null;
    for (const src of this.lesson.sources) {
      const set = sets.find((s) => s.sourceIndex === src.index);
      if (!set || !Array.isArray(set.timesInSeconds) || !set.timesInSeconds.length) continue;
      const ts = set.timesInSeconds;
      const vals = [];
      for (let k = 0; k < 6; k++) {
        const t = ts[Math.floor(((k + 0.5) * ts.length) / 6)];
        const img = await this.loadThumb(set, t, signal);
        vals.push(flatShare(img));
        img.close();
      }
      vals.sort((a, b) => a - b);
      const score = (vals[2] + vals[3]) / 2;
      if (!best || score > best.score) best = { source: src, set, score };
    }
    if (best && best.score >= SCREEN_FLAT_MIN) return { source: best.source, thumbs: best.set };
    // No thumbnails: a single source is assumed to be worth scanning.
    if (!best && this.lesson.sources.length === 1) return { source: this.lesson.sources[0], thumbs: null };
    return null;
  }

  async loadThumb(set, t, signal) {
    const r = await fetchOk(set.baseUri + '/' + t + '.' + set.extension, { signal });
    return createImageBitmap(await r.blob());
  }

  // Coarse chapters from the per-minute thumbnails: a change between two thumbnails is
  // placed half way between them.
  async fromThumbnailsAsync(set) {
    const samples = [];
    for (const t of set.timesInSeconds) {
      await this.gate.wait(0);
      const img = await this.loadThumb(set, t, this.ac.signal);
      samples.push({ t, sig: frameSignature(img) });
      img.close();
    }
    const scenes = buildScenes(samples, this.duration(), { minSec: 0 });
    this.chapters = scenes.map((s, i) => {
      const first = chapterSampleStart(samples, s);
      return {
        start: i === 0 ? 0 : (samples[first].t + samples[first - 1].t) / 2,
        end: s.end,
        precise: false,
        repTime: samples[s.rep].t,
        thumb: set.baseUri + '/' + samples[s.rep].t + '.' + set.extension,
      };
    });
    for (let i = 1; i < this.chapters.length; i++) this.chapters[i - 1].end = this.chapters[i].start;
    this.state = 'thumbnails';
    this.onChange();
  }

  fromThumbnails(set) {
    this.thumbsDone = this.fromThumbnailsAsync(set).catch((e) => { if (!this.ac.signal.aborted) console.warn(TAG, 'thumbnails:', e.message); });
  }

  async fromKeyframes(source, signal) {
    const reader = await new HlsVideoReader(source.v || source.av, 360).open(signal);
    this.reader = reader;
    if (this.thumbsDone) await this.thumbsDone;
    const n = reader.segments.length;
    const samples = [];
    if (store.get('debug', false)) this.samples = samples; // for tuning, development only
    const thumbs = new Map();
    let lastBuild = 0;
    for (let i = 0; i < n; i++) {
      await this.gate.turn(300, 120, 20);
      let sig = null;
      let pic = null;
      await reader.keyframe(i, signal, (f) => { sig = frameSignature(f); pic = smallBitmap(f, CHAPTER_THUMB_W); });
      samples.push({ t: reader.segments[i].start, sig });
      // Keep a small picture only for the last frame of each run of identical frames.
      if (thumbs.has(i - 1) && sameView(samples[i - 1].sig, sig)) thumbs.delete(i - 1);
      thumbs.set(i, await bitmapToBlob(pic));
      this.progress = ((i + 1) / n) * 0.8;
      if (i - lastBuild >= 30) {
        lastBuild = i;
        // With per-minute chapters on screen, partial results would only show fewer.
        if (this.state !== 'thumbnails') this.applyScenes(samples, thumbs, false);
        else this.onChange();
      }
    }
    this.state = 'keyframes';
    this.applyScenes(samples, thumbs, true);
    // Pin each change to about a second inside the segment where it happened.
    const chs = this.chapters;
    for (let c = 1; c < chs.length; c++) {
      const k = chs[c].firstSample;
      if (k <= 0) continue;
      await this.gate.turn(1000, 300, 30);
      const before = samples[k - 1].sig;
      let at = null;
      await reader.frames(k - 1, 1, signal, (f, t) => { if (at === null && !sameView(before, frameSignature(f))) at = t; });
      // Seeking exactly to a frame's timestamp can still show the frame before it.
      if (at !== null) at = Math.round((at + 0.05) * 100) / 100;
      if (at !== null && at < chs[c].start) {
        chs[c].start = at;
        chs[c - 1].end = at;
      }
      chs[c].precise = true;
      this.progress = 0.8 + (c / chs.length) * 0.2;
      if (c % 5 === 0) this.onChange();
    }
    this.state = 'done';
    this.progress = 1;
    this.onChange();
  }

  applyScenes(samples, thumbs, final) {
    const total = final ? this.duration() : samples[samples.length - 1].t + 10;
    const scenes = buildScenes(samples, total);
    this.chapters = scenes.map((s) => {
      const first = chapterSampleStart(samples, s);
      let blob = null;
      // The newest picture of this scene that is still kept.
      for (let k = s.rep; k >= first && !blob; k--) blob = thumbs.get(k) || null;
      return { start: s.start, end: s.end, precise: false, repTime: samples[s.rep].t, firstSample: first, blob, thumb: blob ? this.thumbUrl(blob) : '' };
    });
    this.onChange();
  }

  save(key) {
    if (!this.lesson.mediaId || this.state !== 'done') return;
    idbCache.put(key, {
      v: 1,
      screen: this.screenIndex,
      at: Date.now(),
      chapters: this.chapters.map((c) => ({ start: c.start, end: c.end, precise: c.precise, repTime: c.repTime, blob: c.blob || null, thumb: c.blob ? '' : c.thumb })),
    });
  }
}

// Index of the first sample of a scene.
function chapterSampleStart(samples, scene) {
  let k = scene.rep;
  while (k > 0 && samples[k - 1].t >= scene.start) k--;
  return k;
}

// ---- 57-slides-pane.js ----
// ===================================================================================
// Reading along with the lecturer's PDF, and the Slides tab of the side panel.
//
// SlideReader holds the reader's state (the page shown, whether it follows the lecture)
// and draws the page into any number of places: the small reader in the Slides tab and,
// when the user opens it there, the PDF view in the main picture area. Following turns to
// the page being talked about; paging by hand pauses it until "back to the page being
// talked about". After a while without a recognised page it says so instead of presenting
// an old page as current.
//
// SlidesPane is the tab: the slide files (add, remove), the small reader with the page's
// times on screen and a "wrong page?" menu, and the chapter list (folded away below the
// reader when there is a PDF). Without slide files it is just the chapter list.
// ===================================================================================

class SlideReader {
  constructor(player) {
    this.player = player;
    this.view = -1;
    this.follow = true;
    this.stale = false;
    this.sample = -1;
    this.targets = new Map();   // name -> { stage, active, token }
    this.infoListeners = new Set();
  }

  get deck() {
    const d = this.player.deck;
    return d && d.pages.length ? d : null;
  }

  // A place to draw pages into: `stage` gets the canvases (and a "not recognised" layer).
  addTarget(name, stage) {
    stage.append(h('div.rstale', { text: t('pageNotRecognised') }));
    this.targets.set(name, { stage, active: false, token: 0 });
  }

  setActive(name, on) {
    const tg = this.targets.get(name);
    if (!tg || tg.active === on) return;
    tg.active = on;
    if (on && this.deck) {
      if (this.view >= 0) this.drawInto(tg, this.view);
      this.update(this.player.video.currentTime, true);
    }
  }

  get active() {
    for (const tg of this.targets.values()) if (tg.active) return true;
    return false;
  }

  onInfo(fn) { this.infoListeners.add(fn); }

  info() { for (const fn of this.infoListeners) fn(); }

  // Called on time updates while some place shows the reader.
  update(t, force) {
    const deck = this.deck;
    if (!deck || !this.active) return;
    const sample = deck.sampleAt(t);
    // Long without a recognised page: do not keep presenting an old page as current.
    const stale = this.follow && deck.unrecognisedFor(t) > FOLLOW_STALE_SEC;
    const staleChanged = stale !== this.stale;
    this.stale = stale;
    for (const tg of this.targets.values()) tg.stage.classList.toggle('stale', stale);
    if (this.follow) {
      const p = deck.pageAt(t);
      if (p !== this.view || force) this.showPage(p >= 0 ? p : Math.max(0, this.view), force);
      else if (sample !== this.sample || staleChanged) this.info();
    } else if (force) this.showPage(this.view, true);
    this.sample = sample;
  }

  // Manual paging pauses following.
  turn(dir) {
    const deck = this.deck;
    if (!deck) return;
    this.follow = false;
    this.showPage(clamp(this.view + dir, 0, deck.pages.length - 1), true);
  }

  resumeFollow() {
    this.follow = true;
    this.update(this.player.video.currentTime, true);
  }

  showPage(i, force) {
    if (!this.deck || i < 0) return;
    const changed = i !== this.view;
    this.view = i;
    if (changed || force) for (const tg of this.targets.values()) if (tg.active) this.drawInto(tg, i);
    this.info();
  }

  // Draws page i into a place, with a short cross-fade over the previous page.
  drawInto(tg, i) {
    const deck = this.deck;
    const token = ++tg.token;
    const stage = tg.stage;
    const p = deck.pages[i];
    const dpr = window.devicePixelRatio || 1;
    // As wide as fits the place at the page's aspect ratio.
    const ar = p.ar || 0.5625;
    const w = stage.clientWidth || 320;
    const hgt = stage.clientHeight || w * ar;
    const width = Math.max(200, Math.min(w, hgt / ar)) * dpr;
    deck.render(i, width).then((src) => {
      if (token !== tg.token) return;
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      c.className = 'rpage';
      stage.append(c);
      requestAnimationFrame(() => c.classList.add('in'));
      const old = [...stage.querySelectorAll('canvas')].filter((x) => x !== c);
      setTimeout(() => { for (const x of old) x.remove(); }, 220);
    }).catch((e) => console.warn(TAG, 'render page:', e && e.message ? e.message : e));
  }

  // "Page 5 of 21 · file" for the page shown.
  label() {
    const deck = this.deck;
    const p = deck.pages[this.view];
    if (!p) return '';
    return t('pageOfN', { n: p.num, total: deck.pages.filter((x) => x.file === p.file).length })
      + (deck.files.length > 1 ? ' · ' + p.file.replace(/\.pdf$/i, '') : '');
  }

  // The following line: following (sure / unsure / stale), or a button back to it.
  // `compact` gives the short wording for the toolbar over the PDF view.
  followElement(compact) {
    const now = this.player.video.currentTime;
    if (!this.follow) return h('button.rback', { text: compact ? t('backToLectureShort') : t('backToLecture'), onclick: () => this.resumeFollow() });
    const state = this.stale ? 'Stale' : this.deck.knownAt(now) ? '' : 'Unsure';
    return h('span.rfollowing', { text: t('following' + state + (compact ? 'Short' : '')) });
  }
}

class SlidesPane {
  constructor(player, el) {
    this.player = player;
    this.el = el;
    this.visible = false;
    this.chapters = [];
    this.dirty = true;
    this.current = -1;
    this.cards = [];
    this.showChapters = false;
    this.d = new Disposer();
    this.reader = player.reader;
    this.deckBox = h('div.sdeck');
    this.readerBox = h('div.reader', { hidden: true });
    this.status = h('div.sstatus', { 'aria-live': 'polite' });
    this.chapToggle = h('button.chaptoggle', { hidden: true, onclick: () => { this.showChapters = !this.showChapters; this.render(); } });
    this.list = h('div.slist');
    el.append(this.deckBox, this.readerBox, this.chapToggle, this.status, this.list);
    this.buildReader();
    this.reader.onInfo(() => { if (this.visible) this.renderPageInfo(); });
    this.d.listen(this.list, 'click', (e) => {
      const card = e.target.closest('.scard');
      if (card) this.player.seek(this.chapters[+card.dataset.i].start);
    });
  }

  get deck() { return this.reader.deck; }

  buildReader() {
    const r = this.readerBox;
    const stage = h('div.rstage');
    this.reader.addTarget('side', stage);
    this.stage = stage;
    this.prevBtn = h('button.rnav', { 'aria-label': t('prevPage'), title: t('prevPage'), text: '‹', onclick: () => this.reader.turn(-1) });
    this.nextBtn = h('button.rnav', { 'aria-label': t('nextPage'), title: t('nextPage'), text: '›', onclick: () => this.reader.turn(1) });
    this.pageLabel = h('span.rlabel');
    this.mainBtn = h('button.rmain', { onclick: () => this.player.setPdfMain(!this.player.prefs.pdfMain) });
    this.followBox = h('div.rfollow');
    this.timesBox = h('div.rtimes');
    this.fixBox = h('details.rfix');
    r.append(stage, h('div.rbar', null, this.prevBtn, this.pageLabel, this.nextBtn), this.mainBtn, this.followBox, this.timesBox, this.fixBox);
  }

  setChapters(chapters, statusText) {
    this.chapters = chapters;
    this.statusText = statusText;
    this.dirty = true;
    if (this.visible) this.render();
  }

  // The transcript or the slide files changed.
  invalidate() {
    this.dirty = true;
    if (this.visible) this.render();
  }

  show(on) {
    this.visible = on;
    this.reader.setActive('side', on && !!this.deck);
    if (on) this.render();
  }

  renderDeck() {
    const deck = this.player.deck;
    const box = this.deckBox;
    box.textContent = '';
    if (!deck) return;
    const input = h('input', { type: 'file', accept: '.pdf,application/pdf', multiple: true, hidden: true });
    input.addEventListener('change', guard(() => { if (input.files.length) deck.addFiles(input.files); }));
    const files = h('div.sfiles');
    for (const f of deck.files) {
      files.append(h('span.sfile', null, h('span.sfname', { text: f.name, title: f.name }),
        h('button.sfremove', { title: t('removeFile', { name: f.name }), 'aria-label': t('removeFile', { name: f.name }), text: '✕', onclick: () => deck.removeFile(f.hash) })));
    }
    files.append(h('button.sfadd', { text: deck.files.length ? t('addMoreSlides') : t('addSlides'), onclick: () => input.click() }), input);
    let msg = '';
    if (deck.state === 'loading') msg = t('deckLoading');
    else if (deck.state === 'reading') msg = deck.ocr ? t('deckReading', { pct: Math.floor(deck.progress * 100) }) : t('deckWaiting');
    else if (deck.state === 'error') msg = t('deckError', { msg: deck.error });
    else if (!deck.files.length) msg = t('slidesLocal');
    box.append(files);
    if (msg) box.append(h('div.sdmsg', { text: msg }));
  }

  render() {
    this.status.textContent = this.statusText || '';
    this.renderDeck();
    const deck = this.deck;
    this.readerBox.hidden = !deck;
    this.reader.setActive('side', this.visible && !!deck);
    this.chapToggle.hidden = !deck;
    this.chapToggle.textContent = this.showChapters ? t('hideChapters') : t('showChapters', { n: this.chapters.length });
    const listShown = !deck || this.showChapters;
    this.list.hidden = !listShown;
    this.status.hidden = !listShown;
    if (deck) this.reader.update(this.player.video.currentTime, true);
    if (!listShown) return;
    if (!this.dirty) { this.update(this.player.video.currentTime, true); return; }
    this.dirty = false;
    const long = this.player.duration() >= 3600;
    const cues = this.player.cues;
    const index = cues && cues.length ? new CueIndex(cues) : null;
    const frag = document.createDocumentFragment();
    this.cards = this.chapters.map((c, i) => {
      let said = '';
      if (index) {
        // The sentence being spoken when the slide appears, or the next one.
        const k = index.started(c.start);
        const cue = k >= 0 && cues[k].end > c.start ? cues[k] : cues[k + 1];
        if (cue && cue.start < c.end) said = cue.text;
      }
      const img = c.thumb ? h('img', { src: c.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : h('div.noimg');
      const card = h('button.scard', { 'data-i': String(i) },
        img,
        h('div.smeta', null,
          h('div.stitle', null, h('span.sn', { text: t('slideN', { n: i + 1 }) }), h('span.st', { text: fmtTime(c.start, long) + (c.precise ? '' : ' ~') })),
          said ? h('div.ssaid', { text: said }) : null));
      frag.appendChild(card);
      return card;
    });
    this.list.textContent = '';
    this.list.appendChild(frag);
    this.current = -1;
    this.update(this.player.video.currentTime, true);
  }

  // Called on time updates: the chapter highlight (the reader updates itself).
  update(t, force) {
    if (!this.visible || document.hidden || !this.cards.length || this.list.hidden) return;
    const k = chapterIndexAt(this.chapters, t);
    if (k === this.current && !force) return;
    if (this.cards[this.current]) this.cards[this.current].classList.remove('cur');
    this.current = k;
    if (this.cards[k]) {
      this.cards[k].classList.add('cur');
      this.cards[k].scrollIntoView({ block: 'nearest' });
    }
  }

  renderPageInfo() {
    const deck = this.deck;
    const rd = this.reader;
    const i = rd.view;
    const p = deck && deck.pages[i];
    if (!p) return;
    this.pageLabel.textContent = rd.label();
    this.pageLabel.title = p.title || '';
    this.prevBtn.disabled = i <= 0;
    this.nextBtn.disabled = i >= deck.pages.length - 1;
    this.mainBtn.textContent = this.player.prefs.pdfMain ? t('pdfMainClose') : t('pdfMainOpen');

    this.followBox.textContent = '';
    this.followBox.append(rd.followElement());

    const long = this.player.duration() >= 3600;
    const times = deck.timesOf(i);
    this.timesBox.textContent = '';
    if (times.length) {
      this.timesBox.append(h('span.rtl', { text: t('shownAt') }));
      for (const r of times) this.timesBox.append(h('button.rtime', { text: fmtTime(r.start, long), onclick: () => { this.player.seek(r.start); rd.resumeFollow(); } }));
    } else if (deck.state === 'ready') {
      this.timesBox.append(h('span.rtl', { text: t('notFoundInRecording') }));
    }

    // Correction for the part being played.
    const fixed = deck.correctionAt(this.player.video.currentTime);
    this.fixBox.textContent = '';
    this.fixBox.append(h('summary', { text: t('wrongPage') }),
      h('button.rfixbtn', { text: t('useThisPage', { n: p.num }), onclick: () => { deck.correct(this.player.video.currentTime, i); this.fixBox.open = false; rd.resumeFollow(); } }),
      h('button.rfixbtn', { text: t('markNotSlide'), onclick: () => { deck.correct(this.player.video.currentTime, 'none'); this.fixBox.open = false; rd.resumeFollow(); } }));
    if (fixed) {
      this.fixBox.append(h('button.rfixbtn', { text: t('undoCorrection'), onclick: () => { deck.correct(this.player.video.currentTime, null); this.fixBox.open = false; rd.resumeFollow(); } }));
    }
  }

  dispose() {
    this.reader.setActive('side', false);
    this.d.dispose();
  }
}

// ---- 58-slide-ocr.js ----
// ===================================================================================
// Reading the text on the screen view, for following the lecturer's slides (M7.5).
//
// Runs only while the recording has slide files. Every 10 s HLS segment starts with a
// keyframe; the keyframes of the screen view are read at 720p (the smallest rendition at
// least that tall, or the tallest there is: text in 360p is not readable) and their text is
// recognised with Tesseract.js (pinned, from jsDelivr, loaded on first use).
//
// - A keyframe that looks like the previous one reuses its text: most of a lecture is the
//   same slide for many segments in a row. The comparison (at 160 x 90) uses the 360p
//   keyframe (about 20 KB); the 720p one (about 100 KB for a detailed screen) is only
//   downloaded where something changed.
// - Order: from the playback position onward; a seek starts again there; then the rest.
// - Pace: while playing, each reading is followed by a rest as long as it took (about half
//   of one core); while paused, readings follow each other. Downloads wait for the
//   playback buffer like all background work, and nothing runs with Data Saver on.
// - The texts are cached per recording (independent of the slide files) and a reading
//   continues where it stopped on the next visit.
//
// Cached record  ocr:<mediaId>  { v, screen, height, texts: [string], at: [text index per
// sample, -1 = not read, OCR_FAILED], stats }.
// For later features (M10 text recognition reuses the keyframes and their text):
//   reader.times[i], reader.texts, reader.at[i].
// ===================================================================================

const TESS_BASE = 'https://cdn.jsdelivr.net/npm/';
const TESS_FILES = {
  lib: 'tesseract.js@7.0.0/dist/tesseract.esm.min.js',
  worker: 'tesseract.js@7.0.0/dist/worker.min.js',
  core: 'tesseract.js-core@7.0.0',
  lang: '@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
};
const OCR_HEIGHT = 720;
const OCR_CMP_W = 160;
const OCR_CMP_H = 90;
const OCR_SAVE_EVERY = 10;     // readings between cache writes
const OCR_FAILED = -3;         // a sample whose keyframe could not be read

let tesseractPromise = null;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = import(TESS_BASE + TESS_FILES.lib).then((m) => m.default || m);
    tesseractPromise.catch(() => { tesseractPromise = null; });
  }
  return tesseractPromise;
}

// Brightness of a frame at 160 x 90.
function lumaThumb(g, img) {
  g.drawImage(img, 0, 0, OCR_CMP_W, OCR_CMP_H);
  const d = g.getImageData(0, 0, OCR_CMP_W, OCR_CMP_H).data;
  const out = new Uint8Array(OCR_CMP_W * OCR_CMP_H);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return out;
}

// Pixels of two 160 x 90 thumbnails whose brightness differs by more than OCR_PIXEL_DIFF.
// One pixel is an 8 x 8 block of a 720p frame: a word of slide text changes several of them
// by much more than that, while re-encoding the same picture changes them by a few levels.
const OCR_PIXEL_DIFF = 24;
function thumbChange(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > OCR_PIXEL_DIFF) n++;
  return n;
}

// The same text, if fewer pixels changed than a short word of text covers (about 3 x 6 at
// 160 x 90 for the smallest readable slide text): a mouse pointer, a blinking caret or the
// clock in a menu bar change fewer.
const OCR_SAME_MAX = 12;

class SlideTextReader {
  // opts: { lesson, video, source (the screen view), disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.source = opts.source;
    this.onChange = opts.onChange || (() => {});
    this.ac = new AbortController();
    opts.disposer.add(() => this.stop());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.reader = null;
    this.times = [];         // start of each sample (segment)
    this.texts = [];
    this.at = null;          // Int32Array: text index per sample, -1 = not read
    this.state = 'idle';     // idle | loading | reading | done | unavailable
    this.error = '';
    this.stats = { read: 0, same: 0, failed: 0, ms: 0, bytes: 0, wall: 0 };
    this.debug = store.get('debug', false) ? { changes: [] } : null;
    this.engine = null;
  }

  get key() { return 'ocr:' + this.lesson.mediaId + ':' + this.source.index; }

  done() {
    return this.at ? this.at.reduce((n, x) => n + (x !== -1 ? 1 : 0), 0) : 0;
  }

  progress() {
    return this.at && this.at.length ? this.done() / this.at.length : 0;
  }

  start() {
    this.run().catch((e) => {
      if (this.ac.signal.aborted) return;
      console.warn(TAG, 'slide text:', e && e.message ? e.message : e);
      this.state = 'unavailable';
      this.error = String((e && e.message) || e);
      this.onChange();
    });
  }

  stop() {
    this.ac.abort();
    if (this.engine) this.engine.then((w) => w.terminate()).catch(() => {});
    this.engine = null;
  }

  async run() {
    const signal = this.ac.signal;
    if (!HlsVideoReader.supported()) throw new Error('WebCodecs not available');
    if (navigator.connection && navigator.connection.saveData) throw new Error('Data Saver is on');
    this.state = 'loading';
    this.onChange();
    const url = this.source.v || this.source.av;
    this.reader = await new HlsVideoReader(url, Infinity, OCR_HEIGHT).open(signal);
    this.probe = await new HlsVideoReader(url, 360).open(signal);
    this.times = this.reader.segments.map((s) => s.start);
    if (this.probe.segments.length !== this.times.length) this.probe = this.reader;
    const n = this.times.length;
    const cached = this.lesson.mediaId ? await idbCache.get(this.key) : undefined;
    if (cached && cached.v === 1 && cached.height === this.reader.info.height && Array.isArray(cached.at) && cached.at.length === n) {
      this.texts = cached.texts;
      this.at = Int32Array.from(cached.at);
      Object.assign(this.stats, cached.stats || {});
    } else {
      this.at = new Int32Array(n).fill(-1);
    }
    if (this.done() === n) { this.state = 'done'; this.onChange(); return; }
    this.state = 'reading';
    this.onChange();
    const canvas = new OffscreenCanvas(this.reader.info.width, this.reader.info.height);
    const g = canvas.getContext('2d');
    const small = new OffscreenCanvas(OCR_CMP_W, OCR_CMP_H).getContext('2d', { willReadFrequently: true });
    // The previous sample of this pass, and the thumbnail of the last one whose text was
    // read: changes are measured against that, so that slow changes (ink added a little at
    // a time) still add up.
    let prev = -1;
    let ref = null;
    const bytes = () => this.reader.bytes + (this.probe !== this.reader ? this.probe.bytes : 0);
    let unsaved = 0;
    const t0 = performance.now();
    const wall0 = this.stats.wall;
    for (let i = this.next(); i >= 0; i = this.next()) {
      await this.gate.turn(200, 0, 20);
      let thumb = null;
      let full = false;
      const bytes0 = bytes();
      try {
        await this.probe.keyframe(i, signal, (f) => { thumb = lumaThumb(small, f); });
      } catch (e) {
        if (signal.aborted) throw e;
      }
      const change = thumb && prev === i - 1 && ref ? thumbChange(ref, thumb) : -1;
      const same = change >= 0 && change < OCR_SAME_MAX;
      if (this.debug) this.debug.changes[i] = change;
      if (thumb && !same) {
        try {
          await this.reader.keyframe(i, signal, (f) => { g.drawImage(f, 0, 0, canvas.width, canvas.height); full = true; });
        } catch (e) {
          if (signal.aborted) throw e;
        }
      }
      this.stats.bytes += bytes() - bytes0;
      if (!thumb || (!same && !full)) {
        this.at[i] = OCR_FAILED;
        this.stats.failed++;
        ref = null;
      } else if (same) {
        this.at[i] = this.at[i - 1];
        this.stats.same++;
      } else {
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const a = performance.now();
        const text = await this.recognize(blob);
        const ms = performance.now() - a;
        this.at[i] = this.addText(text);
        ref = thumb;
        this.stats.read++;
        this.stats.ms += Math.round(ms);
        // Half pace while playing: rest as long as the reading took.
        if (!this.video.paused) await this.gate.wait(ms);
      }
      prev = ref ? i : -1;
      this.stats.wall = wall0 + Math.round(performance.now() - t0);
      if (++unsaved >= OCR_SAVE_EVERY) { unsaved = 0; this.save(); }
      this.onChange();
    }
    this.state = 'done';
    this.save();
    this.onChange();
  }

  addText(text) {
    this.texts.push(text);
    return this.texts.length - 1;
  }

  // The next sample to read: the first unread one from the playback position on, else the
  // first unread one. -1 when all are read.
  next() {
    const at = this.at;
    const here = this.reader.segmentAt(this.video.currentTime || 0);
    for (let i = here; i < at.length; i++) if (at[i] === -1) return i;
    for (let i = 0; i < here; i++) if (at[i] === -1) return i;
    return -1;
  }

  async recognize(blob) {
    if (!this.engine) {
      this.engine = loadTesseract().then((T) => T.createWorker('eng', 1, {
        workerPath: TESS_BASE + TESS_FILES.worker,
        corePath: TESS_BASE + TESS_FILES.core,
        langPath: TESS_BASE + TESS_FILES.lang,
      }));
      this.engine.catch(() => { this.engine = null; });
    }
    const w = await this.engine;
    if (this.ac.signal.aborted) throw new Error('aborted');
    return String((await w.recognize(blob)).data.text || '');
  }

  save() {
    if (!this.lesson.mediaId || !this.at) return;
    idbCache.put(this.key, { v: 1, screen: this.source.index, height: this.reader.info.height, texts: this.texts, at: Array.from(this.at), stats: this.stats, savedAt: Date.now() });
  }
}

// ---- 58-slide-text.js ----
// ===================================================================================
// Which page of the lecturer's slide files is on screen, from the text on screen.
//
// Pure functions on strings and numbers (the reading of the screen is in 59-slide-ocr.js).
//
//   1. Words. The text recognised in each distinct screen picture is compared with each
//      page's text (tf-idf cosine). Words on many pages (course name, footer) count little;
//      words on many screen pictures (the viewer's toolbar, tab titles, a file path) count
//      little too, whatever the software.
//   2. Evidence. How a score should be read is learnt from the lecture itself: the second
//      best page of a picture is always a wrong page, so the second best scores show what
//      "wrong" looks like in this lecture; the best scores are a mix of that and "right",
//      whose share and spread are fitted to them. A score then counts as the log of how
//      much more likely it is under "right" than under "wrong". A picture with little text
//      gives little evidence either way.
//   3. Sequence. A hidden Markov model over the pictures in time order decides all pages
//      at once (Viterbi). States: every page, and "not a slide" (remembering the last page,
//      so coming back to it is cheap). Staying or moving on one page is usual; going back,
//      jumping and leaving the slides are rarer; a jump to another file is rarer still.
//      Pages with little text are placed by their neighbours.
// ===================================================================================

const SLIDE_STOP = new Set(('the and for are but not you all any can had her was one our out has have this that with from they will would there their '
  + 'what about which when your then them these some into more than only other such also each just like been were said very where while here '
  + 'should could does using used use get got let its how why who may might must shall ours yours his him she hers').split(' '));

function slideWords(text) {
  return (String(text || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !SLIDE_STOP.has(w));
}

function wordBag(words) {
  const b = new Map();
  for (const w of words) b.set(w, (b.get(w) || 0) + 1);
  return b;
}

// scores[f * P + p]: cosine between picture f and page p. explained[f * P + p]: share of
// the picture's text that is on page p (each word weighted by how rare it is among the
// pictures, so the viewer's own words count little): a slide on screen, even zoomed in,
// explains much of what is readable; a code editor showing the slide's code next to a file
// tree, menus and other code does not. words[f]: distinct page words in picture f.
function textScores(pageTexts, frameTexts) {
  const P = pageTexts.length;
  const F = frameTexts.length;
  const pdf = new Map();
  const pageBags = pageTexts.map((t) => {
    const b = wordBag(slideWords(t));
    for (const w of b.keys()) pdf.set(w, (pdf.get(w) || 0) + 1);
    return b;
  });
  const idf = (w) => Math.log((P + 1) / (pdf.get(w) + 0.5));
  // Inverted index of the pages' weighted words.
  const post = new Map();
  const pnorm = new Float64Array(P);
  pageBags.forEach((b, p) => {
    for (const [w, c] of b) {
      const x = (1 + Math.log(c)) * idf(w);
      if (x <= 0) continue;
      pnorm[p] += x * x;
      let l = post.get(w);
      if (!l) post.set(w, (l = []));
      l.push(p, x);
    }
  });
  for (let p = 0; p < P; p++) pnorm[p] = Math.sqrt(pnorm[p]) || 1;
  const raw = new Int32Array(F);
  const allBags = frameTexts.map((t, f) => { const ws = slideWords(t); raw[f] = ws.length; return wordBag(ws); });
  const frameBags = allBags.map((b) => new Map([...b].filter(([w]) => post.has(w))));
  const fdf = new Map();
  for (const b of allBags) for (const w of b.keys()) fdf.set(w, (fdf.get(w) || 0) + 1);
  // Share of the information a word carries among the pictures: 1 for a word on one
  // picture, near 0 for a word on all of them.
  const lf = Math.log(F + 1);
  const fw = (w) => (F > 1 ? Math.log((F + 1) / fdf.get(w)) / lf : 1);
  const scores = new Float32Array(F * P);
  const explained = new Float32Array(F * P);
  const words = new Int32Array(F);
  const acc = new Float64Array(P);
  frameBags.forEach((b, f) => {
    acc.fill(0);
    let all = 0;
    for (const w of allBags[f].keys()) all += fw(w) ** 2;
    if (all > 0) {
      for (const w of b.keys()) {
        const x = fw(w) ** 2 / all;
        const l = post.get(w);
        for (let k = 0; k < l.length; k += 2) explained[f * P + l[k]] += x;
      }
    }
    let n2 = 0;
    for (const [w, c] of b) {
      const x = (1 + Math.log(c)) * idf(w) * fw(w);
      if (x <= 0) continue;
      n2 += x * x;
      const l = post.get(w);
      for (let k = 0; k < l.length; k += 2) acc[l[k]] += x * l[k + 1];
    }
    words[f] = b.size;
    const n = Math.sqrt(n2) || 1;
    for (let p = 0; p < P; p++) scores[f * P + p] = acc[p] / (n * pnorm[p]);
  });
  return { scores, explained, words, raw, P, F, pageWords: Int32Array.from(pageBags, (b) => [...b.keys()].filter((w) => idf(w) > 0).length) };
}

// Cosine similarity between every two pages (P x P), from their text alone.
function pageSimilarity(pageTexts) {
  const r = textScores(pageTexts, pageTexts);
  return r.scores;
}

// ---- evidence ----

const EVIDENCE_GRID = 101;

// Log-likelihood ratio "this page is on screen" vs "it is not", learnt from the lecture's
// own scores (see the top of the file), from two measures of a picture and a page: the
// cosine and the share of the picture's text explained by the page. Each has a normal
// distribution under "wrong", fitted to every picture's second best page (always a wrong
// page) together with the best pages it explains, and one under "right", fitted to the
// best pages it explains; the share of "right" is fitted along (EM). Returns
// { llr(score, explained), right, wrong } (means and spreads of both measures).
function scoreModel(ts, pageSim) {
  const { scores, explained, words, P, F } = ts;
  const best = [];
  const second = [];
  for (let f = 0; f < F; f++) {
    if (!words[f]) continue;
    let b = -1;
    let bi = -1;
    for (let p = 0; p < P; p++) if (scores[f * P + p] > b) { b = scores[f * P + p]; bi = p; }
    // Pages at least as close to the best page as the picture is cannot be told apart
    // from it: they are not "wrong".
    let si = -1;
    for (let p = 0; p < P; p++) if (p !== bi && pageSim[bi * P + p] < b && (si < 0 || scores[f * P + p] > scores[f * P + si])) si = p;
    best.push([b, explained[f * P + bi]]);
    second.push(si >= 0 ? [scores[f * P + si], explained[f * P + si]] : [0, 0]);
  }
  const fit = (xs, ws, d) => {
    let sw = 0;
    let sx = 0;
    let sxx = 0;
    xs.forEach((x, i) => { const w = ws ? ws[i] : 1; sw += w; sx += w * x[d]; sxx += w * x[d] * x[d]; });
    const mean = sw ? sx / sw : 0;
    return { mean, sd: Math.max(Math.sqrt(Math.max(0, sxx / (sw || 1) - mean * mean)), 0.01), w: sw };
  };
  const pdf = (d, x) => Math.exp(-0.5 * ((x - d.mean) / d.sd) ** 2) / d.sd;
  const fit2 = (xs, ws) => [fit(xs, ws, 0), fit(xs, ws, 1)];
  const pdf2 = (m, x) => pdf(m[0], x[0]) * pdf(m[1], x[1]);
  let wrong = fit2(second);
  let right = [{ mean: Math.max(0, ...best.map((x) => x[0])), sd: 0.1 }, { mean: Math.max(0, ...best.map((x) => x[1])), sd: 0.1 }];
  let share = 0.5;
  const resp = new Float64Array(best.length);
  const ones = second.map(() => 1);
  for (let it = 0; it < 200 && best.length; it++) {
    best.forEach((x, i) => {
      const a = share * pdf2(right, x);
      const b = (1 - share) * pdf2(wrong, x);
      resp[i] = a + b > 0 ? a / (a + b) : (x[0] > wrong[0].mean ? 1 : 0);
    });
    const w = resp.reduce((t, x) => t + x, 0);
    share = w / best.length;
    if (w < 0.5) { share = 0; break; }
    right = fit2(best, resp);
    wrong = fit2(second.concat(best), ones.concat(Array.from(resp, (x) => 1 - x)));
  }
  // Per measure, on a grid, made non-decreasing: a higher value is never weaker evidence,
  // and a value above the typical right one is no stronger than it.
  const n = EVIDENCE_GRID;
  const grid = (r, q) => {
    const g = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = Math.min(i / (n - 1), r.mean);
      const v = share > 0 ? Math.log(pdf(r, x)) - Math.log(pdf(q, x)) : -25;
      g[i] = Math.max(i ? g[i - 1] : -Infinity, isFinite(v) ? v : -25);
    }
    return g;
  };
  const g0 = grid(right[0], wrong[0]);
  const g1 = grid(right[1], wrong[1]);
  const at = (g, x) => g[Math.max(0, Math.min(n - 1, Math.round(x * (n - 1))))];
  const llr = (s, e) => at(g0, s) + at(g1, e);
  const sum = (m) => ({ score: [m[0].mean, m[0].sd], explained: [m[1].mean, m[1].sd] });
  return { llr, right: Object.assign({ share }, sum(right)), wrong: sum(wrong) };
}

// Evidence for each picture and page: ev[f * P + p] (log-likelihood ratio against "not a
// slide"). A page without any text gives no evidence: where it was shown follows from the
// pages around it. A picture with nothing readable at all (a camera, a black screen) is
// taken as not showing any page: a page on screen always comes with some text, if only a
// title or the viewer around it.
function slideEvidence(ts, model) {
  const { scores, explained, P, F, pageWords, raw } = ts;
  const ev = new Float32Array(F * P);
  const none = model.llr(0, 0);
  for (let f = 0; f < F; f++) {
    for (let p = 0; p < P; p++) ev[f * P + p] = !raw[f] ? none : pageWords[p] ? model.llr(scores[f * P + p], explained[f * P + p]) : 0;
  }
  return ev;
}

// ---- sequence ----

// Log-probabilities of moving between two pictures in a row (the second picture differs
// from the first, so something changed on screen).
const SLIDE_MOVES = {
  stay: Math.log(0.45),      // same page (ink, pointer, a build step)
  next: Math.log(0.30),      // next page
  back: Math.log(0.05),      // previous page
  jump: Math.log(0.04),      // any other page of the same file (spread over the file)
  file: Math.log(0.01),      // a page of another file (spread over that file)
  off: Math.log(0.15),       // something that is not a slide
  offStay: Math.log(0.60),   // still not a slide
  offBack: Math.log(0.20),   // back to the page shown before
  offNext: Math.log(0.10),   // back to the slides, one page on
  offJump: Math.log(0.07),   // back to the slides at another page of the same file
  offFile: Math.log(0.03),   // back to the slides in another file
};

// ev: evidence per picture (F x P); fileOf[p]: file of page p; seq[t]: picture shown at
// step t (time order, one step per distinct picture); force[t] (optional): the user's
// correction for step t (a page, FORCE_OFF for "not a slide", -1 for none). Returns per
// step a page index or -1 (not a slide).
const FORCE_OFF = -2;

function decodeSlides(ev, P, fileOf, seq, force) {
  const S = 2 * P + 1;    // pages, "not a slide" after page p, "not a slide" before any page
  const NONE = 2 * P;
  const T = seq.length;
  const files = [];
  for (let p = 0; p < P; p++) (files[fileOf[p]] ||= []).push(p);
  const nf = files.length;
  const M = SLIDE_MOVES;
  const back = new Int32Array(T * S);
  const emit = (t, V) => {
    const f = seq[t];
    if (f >= 0) for (let p = 0; p < P; p++) V[p] += ev[f * P + p];
    const k = force ? force[t] : -1;
    if (k >= 0) { for (let s = 0; s < S; s++) if (s !== k) V[s] = -Infinity; } else if (k === FORCE_OFF) for (let p = 0; p < P; p++) V[p] = -Infinity;
  };
  let V = new Float64Array(S).fill(-Infinity);
  for (let p = 0; p < P; p++) V[p] = -Math.log(2 * P);
  V[NONE] = -Math.log(2);
  if (T) emit(0, V);
  const fileBest = new Float64Array(nf);
  const fileArg = new Int32Array(nf);
  const offBest = new Float64Array(nf);
  const offArg = new Int32Array(nf);
  // Best and second best file, for moves into another file.
  const top = (arr) => {
    let a = -1;
    let b = -1;
    for (let k = 0; k < nf; k++) if (a < 0 || arr[k] > arr[a]) { b = a; a = k; } else if (b < 0 || arr[k] > arr[b]) b = k;
    return [a, b];
  };
  for (let t = 1; t < T; t++) {
    const N = new Float64Array(S).fill(-Infinity);
    const B = back.subarray(t * S, (t + 1) * S);
    fileBest.fill(-Infinity);
    offBest.fill(-Infinity);
    for (let p = 0; p < P; p++) {
      const k = fileOf[p];
      if (V[p] > fileBest[k]) { fileBest[k] = V[p]; fileArg[k] = p; }
      if (V[P + p] > offBest[k]) { offBest[k] = V[P + p]; offArg[k] = P + p; }
    }
    const [fa, fb] = top(fileBest);
    const [oa, ob] = top(offBest);
    for (let q = 0; q < P; q++) {
      const k = fileOf[q];
      const n = files[k].length;
      const same = (r) => r >= 0 && r < P && fileOf[r] === k;
      let best = V[q] + M.stay;
      let arg = q;
      const from = (s, v) => { if (v > best) { best = v; arg = s; } };
      if (same(q - 1)) { from(q - 1, V[q - 1] + M.next); from(P + q - 1, V[P + q - 1] + M.offNext); }
      if (same(q + 1)) from(q + 1, V[q + 1] + M.back);
      from(P + q, V[P + q] + M.offBack);
      from(fileArg[k], fileBest[k] + M.jump - Math.log(n));
      from(offArg[k], offBest[k] + M.offJump - Math.log(n));
      const of = fa !== k ? fa : fb;
      if (of >= 0) from(fileArg[of], fileBest[of] + M.file - Math.log(n));
      const oo = oa !== k ? oa : ob;
      if (oo >= 0) from(offArg[oo], offBest[oo] + M.offFile - Math.log(n));
      from(NONE, V[NONE] + M.offJump - Math.log(P));
      N[q] = best;
      B[q] = arg;
      const a = V[q] + M.off;
      const b = V[P + q] + M.offStay;
      N[P + q] = a >= b ? a : b;
      B[P + q] = a >= b ? q : P + q;
    }
    N[NONE] = V[NONE] + M.offStay;
    B[NONE] = NONE;
    emit(t, N);
    V = N;
  }
  let s = 0;
  for (let i = 1; i < S; i++) if (V[i] > V[s]) s = i;
  const out = new Int32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    out[t] = s < P ? s : -1;
    if (t > 0) s = back[t * S + s];
  }
  return out;
}

// ---- one lecture ----

// input: { pageTexts: [string], fileOf: [file index per page], texts: [string] (each
// distinct picture read), at: [per 10 s sample: index into texts, -1 = not read yet],
// force: [per sample: page, FORCE_OFF or -1] (optional) }.
// Returns { pages: Int32Array per sample (page index, -1 = not a slide, -2 = not read yet),
// model }.
function followLecture(input) {
  const P = input.pageTexts.length;
  const at = input.at;
  const force = input.force || [];
  const out = new Int32Array(at.length).fill(-2);
  if (!P || !input.texts.length) return { pages: out, model: null };
  const ts = textScores(input.pageTexts, input.texts);
  const model = scoreModel(ts, pageSimilarity(input.pageTexts));
  const ev = slideEvidence(ts, model);
  // One step per run of samples showing the same picture (with the same correction).
  const seq = [];
  const fs = [];
  const stepOf = new Int32Array(at.length).fill(-1);
  for (let i = 0; i < at.length; i++) {
    if (at[i] < 0) continue;
    const k = force[i] == null ? -1 : force[i];
    const last = seq.length - 1;
    if (last >= 0 && seq[last] === at[i] && fs[last] === k && stepOf[i - 1] === last) { stepOf[i] = last; continue; }
    seq.push(at[i]);
    fs.push(k);
    stepOf[i] = seq.length - 1;
  }
  const states = decodeSlides(ev, P, Int32Array.from(input.fileOf), seq, fs);
  for (let i = 0; i < at.length; i++) if (stepOf[i] >= 0) out[i] = states[stepOf[i]];
  return { pages: out, model: { right: model.right, wrong: model.wrong } };
}

// ---- the Worker ----

// Source of a Worker running followLecture, assembled from the functions above so the code
// that runs is exactly the code in this file.
function slideTextWorkerSource() {
  const fns = [slideWords, wordBag, textScores, pageSimilarity, scoreModel, slideEvidence, decodeSlides, followLecture];
  return '"use strict";\n'
    + 'const SLIDE_STOP = new Set(' + JSON.stringify([...SLIDE_STOP]) + ');\n'
    + 'const SLIDE_MOVES = ' + JSON.stringify(SLIDE_MOVES) + ';\n'
    + 'const EVIDENCE_GRID = ' + EVIDENCE_GRID + ';\n'
    + 'const FORCE_OFF = ' + FORCE_OFF + ';\n'
    + fns.map((f) => f.toString()).join('\n\n') + '\n'
    + 'self.onmessage = (e) => {\n'
    + '  const t0 = Date.now();\n'
    + '  try { const r = followLecture(e.data.input); r.ms = Date.now() - t0; self.postMessage({ id: e.data.id, ok: true, result: r }, [r.pages.buffer]); }\n'
    + '  catch (err) { self.postMessage({ id: e.data.id, ok: false, error: String((err && err.message) || err) }); }\n'
    + '};\n';
}

// One Worker for a player's lifetime; run(input) resolves with followLecture's result.
class SlideTextWorker {
  constructor(disposer) {
    this.worker = null;
    this.seq = 0;
    this.waiting = new Map();
    disposer.add(() => this.close());
  }

  run(input) {
    if (!this.worker) {
      const url = URL.createObjectURL(new Blob([slideTextWorkerSource()], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
      this.worker.onmessage = (e) => {
        const w = this.waiting.get(e.data.id);
        if (!w) return;
        this.waiting.delete(e.data.id);
        if (e.data.ok) w.resolve(e.data.result); else w.reject(new Error(e.data.error));
      };
      this.worker.onerror = (e) => {
        for (const w of this.waiting.values()) w.reject(new Error(e.message || 'worker error'));
        this.waiting.clear();
      };
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, input });
    });
  }

  close() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error('closed'));
    this.waiting.clear();
  }
}

// ---- 59-slide-deck.js ----
// ===================================================================================
// The lecturer's slide files (PDF) for a recording: loading, local storage, following the
// lecture, and the user's corrections.
//
// The PDF is the user's: they can page through it freely and remove it at any time.
// Following the lecture only turns the page for them until they take over.
//
// Which page is on screen comes from the text on the screen view, every 10 s across the
// lecture: 58-slide-ocr.js reads it, 58-slide-text.js decides the pages (in a Worker).
//
// Files never leave the browser: they are kept in IndexedDB (by SHA-256), remembered per
// recording. pdf.js is loaded from jsDelivr (pinned) only when a recording has slide files.
//
// Stored records:
//   deck:<mediaId>        { files: [{ hash, name }], fixes: [{ a, b, page: <page key> | 'none' }] }
//   deckfile:<hash>       Blob of the PDF
//   deckref:<hash>        [mediaId] recordings using the file (deleted with the last one)
// A correction covers a part of the lecture (a to b, in seconds); a page key is
// "<hash prefix>:<page>", so it survives reordering files.
//
// For later features (slide text as vocabulary for transcription, chapter titles):
// controller.pages[i] = { key, file, num, title, text }.
// ===================================================================================

const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/';
const FOLLOW_MIN_SEC = 15;       // a quick look at another page (shorter than this) does not turn the page
const FOLLOW_STALE_SEC = 120;    // after this long without a recognised page, say so
const FOLLOW_UPDATE_MS = 15000;  // while reading, pages are decided again at most this often
const DECK_RENDER_CACHE = 6;      // rendered pages kept

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_BASE + 'pdf.min.mjs').then((lib) => {
      // A module worker from a blob that imports the pinned worker script: a cross-origin
      // worker URL cannot be used directly.
      const url = URL.createObjectURL(new Blob(['import "' + PDFJS_BASE + 'pdf.worker.min.mjs";'], { type: 'text/javascript' }));
      lib.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
      return lib;
    });
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The page's title: the largest text in the top 40% of the page.
function pageTitle(items, pageHeight) {
  let size = 0;
  for (const it of items) if (it.str.trim() && it.transform[5] > pageHeight * 0.6) size = Math.max(size, it.height);
  if (!size) return '';
  return items.filter((it) => it.str.trim() && it.transform[5] > pageHeight * 0.6 && Math.abs(it.height - size) < 1)
    .map((it) => it.str.trim()).join(' ').replace(/\s+/g, ' ').slice(0, 120);
}

function renderPdfPage(page, width) {
  const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const c = document.createElement('canvas');
  c.width = Math.round(width);
  c.height = Math.round(vp.height);
  return page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise.then(() => c);
}

// The page to show at each sample while following. pages[i]: from followLecture (a page,
// -1 not a slide, -2 not read yet); times[i]: when sample i starts; end: when the last one
// ends. Where no page is on screen the page shown before stays. A quick look at another
// page (a stretch shorter than minSec between two stretches of the same page) does not
// turn the page. Before the first page, that page is shown. Returns page indexes (-1 only
// when no page is known at all).
function followSamples(times, pages, minSec, end) {
  const min = minSec == null ? FOLLOW_MIN_SEC : minSec;
  const n = pages.length;
  const tEnd = end == null ? (n ? times[n - 1] + 10 : 0) : end;
  // Stretches of one page: [{ p, a, b }] (samples a..b), ended by anything else.
  const runs = [];
  for (let i = 0; i < n; i++) {
    const p = pages[i];
    if (p < 0) continue;
    const last = runs[runs.length - 1];
    if (last && last.p === p && last.b === i - 1) last.b = i; else runs.push({ p, a: i, b: i });
  }
  const keep = runs.filter((r, k) => {
    const len = (r.b + 1 < n ? times[r.b + 1] : tEnd) - times[r.a];
    return !(len < min && k > 0 && k + 1 < runs.length && runs[k - 1].p === runs[k + 1].p && runs[k - 1].p !== r.p);
  });
  const out = new Int32Array(n);
  let k = 0;
  let cur = keep.length ? keep[0].p : -1;
  for (let i = 0; i < n; i++) {
    while (k < keep.length && keep[k].a <= i) { cur = keep[k].p; k++; }
    out[i] = cur;
  }
  return out;
}

class SlideDeckController {
  // opts: { lesson, video, slides (SlideAnalyzer: which view is the screen), disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.slides = opts.slides;
    this.onChange = opts.onChange || (() => {});
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.files = [];          // [{ hash, name }]
    this.docs = [];           // pdf.js loading tasks of the open documents, per file
    this.pages = [];          // [{ key, file, num, title, text, doc, ar }]
    this.fixes = [];          // the user's corrections [{ a, b, page }]
    this.ocr = null;          // SlideTextReader
    this.worker = new SlideTextWorker(this.d);
    this.decided = null;      // per sample: page, -1 not a slide, -2 not read (followLecture)
    this.shown = null;        // per sample: page to show while following
    this.decidedAt = 0;
    this.deciding = null;
    this.state = 'empty';     // empty | loading | reading | ready | error
    this.error = '';
    this.job = null;
    this.rendered = new Map(); // "index@width" -> canvas
    this.d.add(() => this.closeDocs());
  }

  get key() { return 'deck:' + this.lesson.mediaId; }

  get progress() { return this.ocr ? this.ocr.progress() : 0; }

  // Closes the open documents (through their loading tasks, which own them in pdf.js).
  closeDocs() {
    for (const task of this.docs) task.destroy().catch(() => {});
    this.docs = [];
    this.rendered.clear();
  }

  async restore() {
    if (!this.lesson.mediaId) return;
    const rec = await idbCache.get(this.key);
    if (!rec || !Array.isArray(rec.files) || !rec.files.length) return;
    this.files = rec.files;
    this.fixes = Array.isArray(rec.fixes) ? rec.fixes : [];
    await this.reload();
  }

  saveRecord() {
    if (this.lesson.mediaId) idbCache.put(this.key, { files: this.files, fixes: this.fixes });
  }

  // Adds PDF files (from a drop or a file picker). Returns how many were PDFs.
  async addFiles(fileList) {
    const pdfs = [...fileList].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) return 0;
    for (const f of pdfs) {
      const buf = await f.arrayBuffer();
      const hash = await sha256Hex(buf);
      if (this.files.some((x) => x.hash === hash)) continue;
      await idbCache.put('deckfile:' + hash, new Blob([buf], { type: 'application/pdf' }));
      const refs = (await idbCache.get('deckref:' + hash)) || [];
      if (!refs.includes(this.lesson.mediaId)) await idbCache.put('deckref:' + hash, refs.concat(this.lesson.mediaId));
      this.files.push({ hash, name: f.name });
    }
    this.saveRecord();
    await this.reload();
    return pdfs.length;
  }

  async removeFile(hash) {
    this.files = this.files.filter((f) => f.hash !== hash);
    const prefix = hash.slice(0, 12) + ':';
    this.fixes = this.fixes.filter((x) => !String(x.page).startsWith(prefix));
    this.saveRecord();
    // The file itself is deleted when no other recording uses it.
    const refs = ((await idbCache.get('deckref:' + hash)) || []).filter((m) => m !== this.lesson.mediaId);
    if (refs.length) await idbCache.put('deckref:' + hash, refs);
    else { await idbCache.del('deckref:' + hash); await idbCache.del('deckfile:' + hash); }
    await this.reload();
  }

  // Opens all files and reads the pages' titles and text, then follows the lecture.
  async reload() {
    const job = {};
    this.job = job;
    this.closeDocs();
    this.pages = [];
    this.decided = null;
    this.shown = null;
    if (!this.files.length) {
      if (this.ocr) { this.ocr.stop(); this.ocr = null; }
      this.state = 'empty';
      this.onChange();
      return;
    }
    this.state = 'loading';
    this.onChange();
    try {
      const lib = await loadPdfJs();
      const pages = [];
      for (const f of this.files) {
        const blob = await idbCache.get('deckfile:' + f.hash);
        if (!blob) continue;
        const task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
        const doc = await task.promise;
        if (this.job !== job) { task.destroy().catch(() => {}); return; }
        this.docs.push(task);
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const tc = await page.getTextContent();
          const [x0, y0, x1, y1] = page.view;
          pages.push({
            key: f.hash.slice(0, 12) + ':' + n, file: f.name, num: n, doc, ar: (y1 - y0) / (x1 - x0),
            title: pageTitle(tc.items, y1 - y0),
            text: tc.items.map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim(),
          });
        }
      }
      if (this.job !== job) return;
      this.pages = pages;
      this.state = 'reading';
      this.startReading();
      this.decide(true);
      this.onChange();
    } catch (e) {
      if (this.ac.signal.aborted || this.job !== job) return;
      console.warn(TAG, 'slide file:', e && e.message ? e.message : e);
      this.state = 'error';
      this.error = String((e && e.message) || e);
      this.onChange();
    }
  }

  // Starts reading the screen once it is known which view that is (from the slide
  // analysis; a recording with one view uses that one).
  startReading() {
    if (this.ocr || !this.pages.length) return;
    const sources = this.lesson.sources;
    const idx = this.slides && this.slides.screenIndex != null ? this.slides.screenIndex : sources.length === 1 ? sources[0].index : null;
    if (idx == null) return;
    const source = sources.find((s) => s.index === idx);
    if (!source) return;
    this.ocr = new SlideTextReader({
      lesson: this.lesson, video: this.video, source, disposer: this.d,
      onChange: () => this.readingChanged(),
    });
    this.ocr.start();
  }

  // Called when the slide analysis changes (the screen view becomes known).
  screenKnown() {
    if (this.pages.length && !this.ocr) { this.startReading(); this.onChange(); }
  }

  readingChanged() {
    const r = this.ocr;
    if (!r) return;
    if (r.state === 'unavailable') { this.state = 'error'; this.error = r.error; this.onChange(); return; }
    const finished = r.state === 'done';
    if (finished && this.state === 'reading') this.state = 'ready';
    this.decide(finished);
    this.onChange();
  }

  // Decides the pages again from everything read so far (at most every FOLLOW_UPDATE_MS
  // while reading, unless `now`).
  decide(now) {
    const r = this.ocr;
    if (!r || !r.at || !this.pages.length) return;
    if (this.deciding) { this.again = this.again || now; return; }
    if (!now && performance.now() - this.decidedAt < FOLLOW_UPDATE_MS) return;
    this.decidedAt = performance.now();
    const fileOf = this.pages.map((p) => this.files.findIndex((f) => p.key.startsWith(f.hash.slice(0, 12))));
    const input = {
      pageTexts: this.pages.map((p) => p.text),
      fileOf,
      texts: r.texts,
      at: Array.from(r.at),
      force: this.forces(r.times),
    };
    const job = this.job;
    this.deciding = this.worker.run(input).then((res) => {
      if (this.job !== job) return;
      this.decided = res.pages;
      this.recompute();
      if (store.get('debug', false)) this.lastModel = res.model;
      this.onChange();
    }).catch((e) => {
      if (!this.ac.signal.aborted) console.warn(TAG, 'slide following:', e && e.message ? e.message : e);
    }).finally(() => {
      this.deciding = null;
      if (this.again) { this.again = false; this.decide(true); }
    });
  }

  // The corrections as a value per sample (page index, FORCE_OFF or -1).
  forces(times) {
    const out = new Array(times.length).fill(-1);
    for (const x of this.fixes) {
      const v = x.page === 'none' ? FORCE_OFF : this.indexOfKey(x.page);
      if (v === -1) continue;
      for (let i = 0; i < times.length; i++) if (times[i] >= x.a - 0.5 && times[i] < x.b - 0.5) out[i] = v;
    }
    return out;
  }

  recompute() {
    const r = this.ocr;
    this.shown = r && this.decided ? followSamples(r.times, this.decided, FOLLOW_MIN_SEC, this.lesson.duration || undefined) : null;
  }

  // Page i rendered `width` pixels wide (cached).
  async render(i, width) {
    const k = i + '@' + Math.round(width);
    let c = this.rendered.get(k);
    if (!c) {
      const page = await this.pages[i].doc.getPage(this.pages[i].num);
      c = await renderPdfPage(page, width);
      this.rendered.set(k, c);
      if (this.rendered.size > DECK_RENDER_CACHE) this.rendered.delete(this.rendered.keys().next().value);
    }
    return c;
  }

  indexOfKey(k) {
    return k ? this.pages.findIndex((p) => p.key === k) : -1;
  }

  // Index of the sample playing at time t (-1 before reading has started).
  sampleAt(t) {
    const r = this.ocr;
    if (!r || !r.times.length) return -1;
    return r.reader.segmentAt(t);
  }

  // Page to show at time t while following (-1 when nothing is known yet). Samples are
  // 10 s apart; when the page changes between two of them and the slide analysis found
  // the change in between (to about a second), the page turns there.
  pageAt(t) {
    const k = this.sampleAt(t);
    if (!this.shown || k < 0) return -1;
    const times = this.ocr.times;
    if (k + 1 < this.shown.length && this.shown[k + 1] !== this.shown[k]) {
      const chs = this.slides ? this.slides.chapters : [];
      const c = chapterIndexAt(chs, times[k + 1] - 0.01);
      if (c > 0 && chs[c].precise && chs[c].start > times[k] && t >= chs[c].start) return this.shown[k + 1];
    }
    return this.shown[k];
  }

  // Whether the page at time t was recognised for that very part, rather than carried
  // over from an earlier part.
  knownAt(t) {
    const k = this.sampleAt(t);
    return !!this.decided && k >= 0 && this.decided[k] >= 0;
  }

  // Seconds since a page was last recognised at time t (0 while recognised, Infinity if
  // never). Following stops claiming a page after FOLLOW_STALE_SEC.
  unrecognisedFor(t) {
    const k = this.sampleAt(t);
    if (!this.decided || k < 0) return Infinity;
    if (this.decided[k] >= 0) return 0;
    const times = this.ocr.times;
    for (let j = k - 1; j >= 0; j--) if (this.decided[j] >= 0) return Math.max(0, t - times[j + 1]);
    return Infinity;
  }

  // When page i was on screen: [{ start, end }].
  timesOf(i) {
    const out = [];
    if (!this.decided) return out;
    const times = this.ocr.times;
    const end = (j) => (j + 1 < times.length ? times[j + 1] : this.lesson.duration || times[j] + 10);
    for (let j = 0; j < this.decided.length; j++) {
      if (this.decided[j] !== i) continue;
      const last = out[out.length - 1];
      if (last && last.endSample === j - 1) { last.end = end(j); last.endSample = j; } else out.push({ start: times[j], end: end(j), endSample: j });
    }
    return out;
  }

  // The part of the lecture around time t that shows one thing: the stretch of samples
  // with the same decision. { a, b } in seconds, or null.
  partAt(t) {
    const k = this.sampleAt(t);
    if (!this.decided || k < 0) return null;
    const times = this.ocr.times;
    const v = this.decided[k];
    let a = k;
    let b = k;
    while (a > 0 && this.decided[a - 1] === v) a--;
    while (b + 1 < this.decided.length && this.decided[b + 1] === v) b++;
    return { a: times[a], b: b + 1 < times.length ? times[b + 1] : this.lesson.duration || times[b] + 10 };
  }

  // The user's correction for the part playing at time t: a page index, 'none' (not a
  // slide) or null (back to automatic).
  correct(t, value) {
    if (value === null) {
      this.fixes = this.fixes.filter((x) => !(x.a <= t && t < x.b));
    } else {
      const part = this.correctionPart(t) || this.partAt(t);
      if (!part) return;
      this.fixes = this.fixes.filter((x) => x.b <= part.a || x.a >= part.b);
      this.fixes.push({ a: part.a, b: part.b, page: value === 'none' ? 'none' : this.pages[value].key });
    }
    this.saveRecord();
    this.decide(true);
    this.onChange();
  }

  correctionPart(t) {
    return this.fixes.find((x) => x.a <= t && t < x.b) || null;
  }

  correctionAt(t) {
    const x = this.correctionPart(t);
    return x ? x.page : null;
  }
}

// ---- 60-cpufix.js ----
// ===================================================================================
// Fallback: CPU fix for the original player (styled-components 4.x). Same logic as the
// standalone "Echo360 player CPU fix" script; only started when the original player runs.
//   1. Static global styles are injected once instead of on every render.
//   2. Components that churn through class names (the progress bar bakes the current
//      percentage into its CSS) get their rules in a small sheet of ours, where unused
//      classes are deleted, so the main stylesheet stops growing.
//   3. timeupdate events reach the page at most once per second during normal playback.
// ===================================================================================

const cpuFix = (function () {
  const CHURN_THRESHOLD = 20;
  const KEEP_NEWEST = 4;
  const TIMEUPDATE_MIN_INTERVAL_MS = 1000;
  const state = { gs: false, cs: false, throttleOn: false, disabled: { gs: false, cs: false } };
  let started = false;

  function disable(part, err) {
    if (state.disabled[part]) return;
    state.disabled[part] = true;
    console.warn(TAG, 'cpu-fix part "' + part + '" disabled after an error', err);
  }

  function patchGlobalStyle(proto) {
    const origRender = proto.renderStyles;
    const origRemove = proto.removeStyles;
    const rendered = new WeakMap();
    proto.renderStyles = function (ctx, ss) {
      let skip = false;
      let mark = false;
      if (!state.disabled.gs) {
        try {
          if (this.isStatic === true && ss && typeof ss.hasId === 'function') {
            const set = rendered.get(ss);
            skip = !!set && set.has(this) && ss.hasId(this.componentId);
            mark = !skip;
          }
        } catch (e) { disable('gs', e); skip = mark = false; }
      }
      if (skip) return undefined;
      const result = origRender.apply(this, arguments);
      if (mark) {
        let set = rendered.get(ss);
        if (!set) rendered.set(ss, (set = new WeakSet()));
        set.add(this);
      }
      return result;
    };
    proto.removeStyles = function (ss) {
      try { const set = rendered.get(ss); if (set) set.delete(this); } catch (e) { /* ignore */ }
      return origRemove.apply(this, arguments);
    };
  }

  const own = { sheet: null, namesById: new Map(), names: new Set() };
  function ownSheet() {
    if (own.sheet && own.sheet.ownerNode && own.sheet.ownerNode.isConnected) return own.sheet;
    const el = document.createElement('style');
    el.setAttribute('data-echo360-lite-cpu-fix', '');
    document.head.appendChild(el);
    own.sheet = el.sheet;
    own.names.clear();
    own.namesById.clear();
    return own.sheet;
  }
  function isLocalSheet(ss) {
    const tags = ss && ss.tags;
    if (!Array.isArray(tags) || tags.length === 0) return false;
    return tags.every((tg) => tg && tg.styleTag && tg.styleTag.ownerDocument === document);
  }
  function classRegex(name) { return new RegExp('\\.' + name.replace(/[^\w-]/g, '\\$&') + '(?![\\w-])'); }
  function evict(list) {
    const sheet = own.sheet;
    const keep = [];
    const drop = [];
    list.forEach((name, i) => {
      if (i >= list.length - KEEP_NEWEST || document.getElementsByClassName(name).length > 0) keep.push(name);
      else drop.push(name);
    });
    if (!drop.length) return;
    const res = drop.map(classRegex);
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      if (res.some((re) => re.test(sheet.cssRules[i].cssText))) sheet.deleteRule(i);
    }
    drop.forEach((n) => own.names.delete(n));
    list.length = 0;
    list.push(...keep);
  }
  function addRules(id, name, rules) {
    const sheet = ownSheet();
    for (const r of rules) { try { sheet.insertRule(r, sheet.cssRules.length); } catch (e) { /* ignore */ } }
    own.names.add(name);
    let list = own.namesById.get(id);
    if (!list) own.namesById.set(id, (list = []));
    list.push(name);
    if (list.length > KEEP_NEWEST) evict(list);
  }
  function patchComponentStyle(proto) {
    const origGen = proto.generateAndInjectStyles;
    const churn = new Map();
    proto.generateAndInjectStyles = function (ctx, ss) {
      if (state.disabled.cs) return origGen.apply(this, arguments);
      const id = this.componentId;
      let st;
      try {
        st = churn.get(id);
        if (!st) churn.set(id, (st = { seen: new Set(), active: false }));
        if (st.active && isLocalSheet(ss)) {
          let captured = null;
          const proxy = new Proxy(ss, {
            get(target, key) {
              if (key === 'hasNameForId') return (cid, name) => (cid === id ? own.names.has(name) : target.hasNameForId(cid, name));
              if (key === 'inject') {
                return (cid, rules, name) => {
                  if (cid === id && typeof name === 'string' && Array.isArray(rules)) captured = { rules, name };
                  else target.inject(cid, rules, name);
                };
              }
              const val = target[key];
              return typeof val === 'function' ? val.bind(target) : val;
            },
          });
          const name = origGen.call(this, ctx, proxy);
          if (captured) addRules(id, captured.name, captured.rules);
          return name;
        }
      } catch (e) { disable('cs', e); return origGen.apply(this, arguments); }
      const name = origGen.apply(this, arguments);
      try {
        if (!st.active && this.isStatic === false && typeof name === 'string') {
          st.seen.add(name);
          if (st.seen.size > CHURN_THRESHOLD) { st.active = true; st.seen = null; }
        }
      } catch (e) { /* ignore */ }
      return name;
    };
  }

  function installThrottle() {
    const last = new WeakMap();
    window.addEventListener('timeupdate', (e) => {
      const v = e.target;
      if (!state.throttleOn || !e.isTrusted || !(v instanceof HTMLMediaElement)) return;
      const now = performance.now();
      const ct = v.currentTime;
      const prev = last.get(v);
      const expected = prev ? prev.media + ((now - prev.wall) / 1000) * (v.playbackRate || 1) : NaN;
      if (!prev || v.paused || v.seeking || v.ended || !(Math.abs(ct - expected) < 1) || now - prev.wall >= TIMEUPDATE_MIN_INTERVAL_MS) {
        last.set(v, { wall: now, media: ct });
        return;
      }
      e.stopImmediatePropagation();
    }, true);
  }

  function scan() {
    let gsProto = null;
    let csProto = null;
    for (const el of document.querySelectorAll('body, body *')) {
      const c = el._reactRootContainer;
      const root = c && (c._internalRoot || c);
      if (!root || !root.current) continue;
      const stack = [root.current];
      while (stack.length && !(gsProto && csProto)) {
        const f = stack.pop();
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
        const gs = f.stateNode && f.stateNode.state && f.stateNode.state.globalStyle;
        if (!gsProto && gs && typeof gs.componentId === 'string' && typeof gs.isStatic === 'boolean') {
          const p = Object.getPrototypeOf(gs);
          if (p && ['renderStyles', 'removeStyles', 'createStyles'].every((k) => typeof p[k] === 'function')) gsProto = p;
        }
        const cs = f.memoizedProps && f.memoizedProps.forwardedComponent && f.memoizedProps.forwardedComponent.componentStyle;
        if (!csProto && cs && typeof cs.componentId === 'string' && typeof cs.isStatic === 'boolean' && Array.isArray(cs.rules)) {
          const p = Object.getPrototypeOf(cs);
          if (p && typeof p.generateAndInjectStyles === 'function' && p.generateAndInjectStyles.length === 2) csProto = p;
        }
      }
    }
    return { gsProto, csProto };
  }

  // Polls once a second (at most 60 s) until the original player's styled-components
  // internals are found and patched, then stops.
  function start() {
    if (started) return;
    started = true;
    installThrottle();
    const t0 = Date.now();
    const timer = setInterval(() => {
      const el = document.querySelector('style[data-styled-version]');
      const ver = el && el.getAttribute('data-styled-version');
      if (ver && !/^4\./.test(ver)) { clearInterval(timer); console.info(TAG, 'cpu-fix inactive: styled-components ' + ver); return; }
      if (ver) {
        try {
          const { gsProto, csProto } = scan();
          if (gsProto && !state.gs) { patchGlobalStyle(gsProto); state.gs = true; }
          if (csProto && !state.cs) { patchComponentStyle(csProto); state.cs = true; }
        } catch (e) { clearInterval(timer); console.warn(TAG, 'cpu-fix scan failed', e); return; }
      }
      if (state.gs && state.cs) {
        state.throttleOn = true;
        clearInterval(timer);
        console.info(TAG, 'cpu-fix active on the original player');
      } else if (Date.now() - t0 > 60000) {
        clearInterval(timer);
        console.info(TAG, 'cpu-fix inactive: player internals not found');
      }
    }, 1000);
  }

  return { start, state };
})();

// ---- 90-main.js ----
// ===================================================================================
// Bootstrap
// ===================================================================================

(function main() {
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

})();
