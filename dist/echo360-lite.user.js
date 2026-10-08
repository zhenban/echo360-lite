// ==UserScript==
// @name         Echo360 Lite Player
// @namespace    echo360-lite
// @version      0.13.1
// @description  Replaces the Echo360 lecture player with a lightweight native player (far lower CPU use). Falls back to the original player automatically if anything is not recognised.
// @license      MIT
// @match        https://echo360.net.au/lesson/*
// @match        https://echo360.net.au/section/*/home
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// ==/UserScript==

/* global Hls */
(function () {
  'use strict';

  const VERSION = '0.13.1';

// ---- 00-util.js ----
// ===================================================================================
// Utilities
// ===================================================================================

const TAG = '[Echo360 Lite]';
const NS = 'echo360lite:';
const HlsLib = typeof Hls !== 'undefined' ? Hls : window.Hls;

// After a backup has been restored, this page must not write its older data back over
// it (it reloads right away; until then writes are dropped).
const storageLock = { frozen: false };

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
    if (storageLock.frozen) return;
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

// Errors in our own code come in two kinds.
//  - Core playback (the streams, the clock video's events, the layout): the page is handed
//    back to the original player (`unexpected.handler`, installed by the bootstrap, runs at
//    most once). Code reports these with reportUnexpected / guardCore.
//  - Everything else (menus, panels, tags, zoom, analyses, ...): logged, the user gets one
//    unobtrusive notice per feature, and the feature's own resources may be released
//    (Disposer.feature). Playback goes on. This is what guard() does by default.
// guard() also catches rejections of the Promise an async callback returns.
const unexpected = { handler: null };
const featureErrors = { notify: null, seen: new Set() };

function reportUnexpected(err) {
  console.error(TAG, 'unexpected error', err);
  const h = unexpected.handler;
  unexpected.handler = null;
  if (h) { try { h(err); } catch (e) { /* ignore */ } }
}

function reportFeatureError(name, err) {
  const what = name || 'player';
  console.error(TAG, 'error in ' + what + ':', err);
  logEvent('error', what + ': ' + ((err && err.message) || err));
  if (featureErrors.seen.has(what)) return;
  featureErrors.seen.add(what);
  if (featureErrors.notify) { try { featureErrors.notify(what, err); } catch (e) { /* ignore */ } }
}

// fn wrapped so that an exception (or the rejection of the Promise it returns) goes to
// onError, by default a non-fatal feature error.
function guard(fn, onError) {
  const report = onError || ((e) => reportFeatureError(null, e));
  return function guarded() {
    try {
      const r = fn.apply(this, arguments);
      if (r && typeof r.then === 'function' && typeof r.catch === 'function') r.catch(report);
      return r;
    } catch (e) {
      report(e);
      return undefined;
    }
  };
}

// Core playback: an error hands the page back to the original player.
function guardCore(fn) {
  return guard(fn, reportUnexpected);
}

// Runs fn (a feature's setup) and turns the feature off instead of failing the player.
function featureGuard(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((e) => reportFeatureError(name, e));
    return r;
  } catch (e) {
    reportFeatureError(name, e);
    return undefined;
  }
}

// One log format: "[Echo360 Lite] ..." in the console. Warnings and errors always (and kept
// for diagnostics); information only with localStorage["echo360lite:debug"] = true.
const log = {
  info(...a) { if (store.get('debug', false)) console.info(TAG, ...a); },
  warn(...a) { console.warn(TAG, ...a); logEvent('warn', a.map(logText).join(' ')); },
  error(...a) { console.error(TAG, ...a); logEvent('error', a.map(logText).join(' ')); },
};
function logText(x) { return x && x.message ? x.message : typeof x === 'string' ? x : String(x); }

// Recent warnings and errors (no content, no addresses), for "copy diagnostics".
const LOG_KEEP = 40;
const eventLog = [];
function logEvent(level, text) {
  eventLog.push({ t: new Date().toISOString().slice(11, 19), level, text: String(text).slice(0, 300) });
  if (eventLog.length > LOG_KEEP) eventLog.shift();
}

// Owns every timer, listener, observer and child resource of a component so that one
// dispose() call releases all of them (used when switching recordings and when handing
// over to the original player). Listener and timer callbacks are wrapped with guard().
class Disposer {
  // opts: { onError } (where errors of its listeners and timers go; inherited by children)
  constructor(opts) {
    this.fns = [];
    this.disposed = false;
    this.onError = (opts && opts.onError) || null;
  }

  guarded(fn) {
    return guard(fn, this.onError);
  }

  add(fn) {
    if (this.disposed) { try { fn(); } catch (e) { /* ignore */ } return fn; }
    this.fns.push(fn);
    return fn;
  }

  listen(target, type, fn, opts) {
    const g = this.guarded(fn);
    target.addEventListener(type, g, opts);
    this.add(() => target.removeEventListener(type, g, opts));
    return g;
  }

  interval(fn, ms) {
    const id = setInterval(this.guarded(fn), ms);
    this.add(() => clearInterval(id));
    return id;
  }

  timeout(fn, ms) {
    const id = setTimeout(this.guarded(fn), ms);
    this.add(() => clearTimeout(id));
    return id;
  }

  observe(observer) {
    this.add(() => observer.disconnect());
    return observer;
  }

  child(opts) {
    const d = new Disposer(Object.assign({ onError: this.onError }, opts));
    this.add(() => d.dispose());
    return d;
  }

  // Resources of one optional feature: an error in its listeners or timers is reported
  // once, and the feature's resources are released (the feature stops; playback goes on).
  feature(name) {
    let d = null;
    d = this.child({ onError: (e) => { reportFeatureError(name, e); if (d) d.dispose(); } });
    return d;
  }

  // Resources of core playback: an error hands over to the original player.
  core() {
    return this.child({ onError: reportUnexpected });
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
    notesPrivate: 'Notes and bookmarks are private to you. Your instructor can see your "didn\'t understand" marks. Tags are only visible to you and stay on this device.',
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
    slidesNone: 'No slide changes were found automatically in this recording.',
    screenView: 'Screen:',
    viewN: 'View {n}',
    screenUse: 'Find the slides in view {n}',
    screenFound: 'found automatically',
    screenGuessed: 'best guess: choose the other view if the slides are wrong',
    screenChosen: 'chosen by you',
    screenAuto: 'Automatic',
    addSlides: 'Add the slide PDF…',
    addMoreSlides: 'Add another PDF…',
    slidesLocal: 'Add the lecturer\'s slide PDF to read along: it turns to the page being talked about. The file stays on this device.',
    removeFile: 'Remove {name}',
    deckLoading: 'Opening the slide files…',
    deckReading: 'Reading the slides on screen: {pct}%',
    deckWaiting: 'Waiting to find the screen view…',
    deckLangLoading: 'Getting text recognition for {lang} ({mb} MB, once)…',
    deckError: 'Could not read the slide file ({msg}).',
    deckSaveFailed: 'Could not store {name} on this device ({msg}). Is the disk full?',
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
    blankTip: 'black screen and silence {time}',
    blackTip: 'black screen {time}',
    skipBlank: 'Skip empty part ({time}) \u203a',
    skippedBlank: 'Skipped {time} of black screen and silence',
    contentEnded: 'The lecture has ended (black screen and silence from here).',
    contentEndSkip: 'Skip to the end',
    contentEndStop: 'Stop here',
    skipSilence: 'Skip silence ({time}) \u203a',
    skippedSilence: 'Skipped {time} of silence',
    audioNoWebAudio: 'Audio processing is not available in this browser.',
    audioNativeHls: 'Audio processing needs Media Source Extensions, which this browser is not using for this video.',
    speed: 'Playback speed',
    fullscreen: 'Full screen (F)',
    resumedAt: 'Resumed at {time}',
    startOver: 'Start over',
    authExpiredTitle: 'Playback access expired',
    authExpiredText: 'Echo360\'s video access has expired and could not be renewed. Reload the page to continue from where you are.',
    authLoginExpiredText: 'Your Echo360 sign-in has expired. Reload the page to sign in again; playback continues from where you are.',
    sessionRenewing: 'Refreshing the session…',
    featureFailed: 'Something went wrong in {name}; it is off for now. Playback is not affected.',
    tagExam: 'Exam',
    tagAssignment: 'Assignment',
    tagConfused: 'Didn\'t get it',
    tagsPrivate: 'Tags are only visible to you: they stay on this device and are never sent to Echo360. All recordings of this course share them.',
    tagsFor: 'Tags',
    newTag: 'New tag…',
    addTag: 'Add tag',
    addTagShort: '+ Tag',
    tagColor: 'Change colour',
    tagName: 'Tag name',
    manageTags: 'Tags…',
    filterTags: 'Filter by tag',
    allTags: 'All tags',
    untagged: 'No tag',
    done: 'Done',
    keysTitle: 'Keyboard shortcuts',
    keyPlay: 'Play / pause',
    keySeek5: 'Back / forward 5 s',
    keySeek10: 'Back / forward 10 s',
    keyVolume: 'Volume',
    keyMute: 'Mute',
    keyFullscreen: 'Full screen',
    keySwap: 'Swap views',
    keySpeed: 'Slower / faster',
    keyCaptions: 'Captions',
    keyTranscript: 'Transcript',
    keyBookmark: 'Bookmark',
    keyTag: 'Tag the note or bookmark here (bookmarks this moment if there is none)',
    keyFlag: '"Didn\'t understand" flag',
    keySlide: 'Previous / next slide',
    keyCopyFrame: 'Copy the current picture',
    keyCopyCaptions: 'Copy what was just said',
    keyZoom: 'Zoom in / out (main picture; or the mouse wheel over any picture, drag to move)',
    keyZoomReset: 'Whole picture again (or double-click)',
    keyLoop: 'Loop: set start / end (A-B), or right-click the progress bar',
    keyLoopClear: 'End the loop',
    keyHelp: 'This list',
    moreMenu: 'More',
    cachesMeasuring: 'Analysis results on this device: measuring…',
    cachesSize: 'Analysis results on this device: {mb} MB ({n})',
    cachesUnknown: 'Analysis results on this device: unknown',
    cachesClear: 'Clear',
    cachesCleared: 'Cleared {n} results; they are made again when needed',
    cachesInfo: 'Slide chapters, silences and slide text found for each recording, so they are instant next time. Not your notes, tags or slide files. Unused results go after 60 days.',
    diagMenu: 'Copy diagnostics…',
    diagTitle: 'Diagnostics',
    diagInfo: 'For a bug report: versions, the state of each feature and recent warnings. No sign-in data, addresses, names, notes or posts. This is exactly what will be copied:',
    diagCopy: 'Copy',
    diagCopied: 'Diagnostics copied',
    keyExport: 'Export notes and bookmarks, backup',
    exportMenu: 'Export…',
    exportInfo: 'Notes and bookmarks with their times and tags, as Markdown (for Obsidian and other notes apps). Each time links back to that moment. The video and its address are never included.',
    exportPictures: 'With the slide page shown at each note (as pictures in a zip)',
    exportPicturesNoPdf: 'Slide pictures need the slide PDF (Slides tab)',
    exportLecture: 'Export this recording',
    exportCourse: 'Export the whole course',
    exportCourseProgress: 'Reading {k} of {n}…',
    exportedLecture: 'Exported {n} notes and bookmarks ({p} slide pictures)',
    exportedCourse: 'Exported {n} recordings with notes',
    exportedNothing: 'No notes or bookmarks in this course yet',
    exportFailed: 'Export failed ({msg})',
    backupInfo: 'Tags, slide files and corrections, what you watched and your settings only exist in this browser. A backup file brings them to another browser (or back after clearing browser data).',
    backupPdfs: 'Include the PDF files (bigger file)',
    backupMake: 'Download backup',
    backupRestore: 'Restore from a backup…',
    backupMade: 'Backup saved ({n} items)',
    backupRestored: 'Restored {n} items. Reloading…',
    backupInvalid: 'This is not an Echo360 Lite backup file',
    mdRecorded: 'Recorded {date}',
    mdOpen: 'Open in Echo360',
    mdNothing: 'No notes or bookmarks.',
    mdNoTime: '(no time)',
    mdFooter: 'Exported from Echo360 Lite on {date}. Tags are your private local tags.',
    keyPopout: 'Floating window (keeps playing on top of other windows)',
    popout: 'Floating window',
    popoutHere: 'Playing in a floating window.',
    popoutBack: 'Back to this page',
    popoutFailed: 'Could not open a floating window ({msg})',
    listWatched: '{pct}% watched',
    listWatchedTitle: 'Watched {pct}% on this device',
    listLastAt: 'last at {time}',
    listLastAtTitle: 'last stopped at {time} (Echo360, any device)',
    lastStopped: 'You stopped here last time (Echo360)',
    loopStart: 'Loop start (drag)',
    loopEnd: 'Loop end (drag)',
    loopClear: 'End loop',
    loopFromHere: 'Loop from here',
    loopToHere: 'Loop to here',
    loopStartSet: 'Loop starts at {time}; press O at the end',
    loopSet: 'Looping {from}–{to}',
    loopCleared: 'Loop ended',
    loopOutside: 'Outside the loop {from}–{to}',
    keyEscape: 'Close menus',
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

function tr(key, vars) {
  let s = (STRINGS[LANG] && STRINGS[LANG][key]) || STRINGS.en[key] || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

// ---- 02-tuning.js ----
// ===================================================================================
// Tuning: every number that sets how the analyses, playback and background work behave, in
// one place, with its unit, what it does and why it holds beyond the recordings it was
// checked on. Values that depend on the recording are not here: they are learnt from it
// (the chapter threshold, the silence threshold, the slide evidence model, the language
// of the slides). Product choices without a "right" value (speeds offered, caption sizes,
// tag colours) stay with their feature.
//
// Checked on: ELEC2134 (3 h, slides in a browser PDF viewer, circuit drawings), COMP2511
// (2 h, slides, code editor, video calls, black screen at the end), COMP1521 (2 h, slides
// and terminal), MATH1081 (2 h, printed notes under a camera with handwriting). The
// labelled ones are replayed by the unit tests (test/fixtures).
// ===================================================================================

// ---- background work (61-media-io.js BackgroundGate) ----
// Background downloads wait until playback has this much buffered ahead: two thirds of what
// the player itself keeps (STREAM_MAX_BUFFER_SEC), so they never take bandwidth playback
// is waiting for. Pauses between steps are in milliseconds, [while playing, while paused].
const BG_MIN_BUFFER_SEC = 20;
const BG_START_DELAY_MS = 5000;        // before an analysis starts its downloads: playback starts first

// ---- slide chapters (64-slides.js) ----
// Seconds between the keyframes compared. Echo360's segments are 10 s long, so this reads
// every keyframe there; with shorter segments the cost stays one keyframe per this many
// seconds, with longer ones every keyframe is read. A resolution choice: refinement pins
// each change to about a second anyway.
const CHAPTER_STEP_SEC = 10;
const CHAPTER_PACE_MS = [300, 120];    // between keyframes (about 20 KB each)
const CHAPTER_REFINE_PACE_MS = [1000, 300];   // between refinements (a whole segment each)
// Frames are compared as brightness pictures this size: one pixel is a 2 x 2 block at
// 360p, 8 x 8 at 720p, so a changed line of slide text changes several pixels.
const THUMB_W = 160;
const THUMB_H = 90;
// A pixel has changed if its brightness moved by more than this (0-255). Re-encoding the
// same picture moves a pixel by a few levels; a letter of slide text drawn or removed by
// far more (dark on light or light on dark both differ by over 100). Sits well between.
const PIXEL_DIFF = 24;
// Fewer changed pixels than a short word of the smallest readable slide text covers (about
// 3 x 6 at 160 x 90) is the same picture: a mouse pointer, a blinking caret, the clock in a
// menu bar change fewer. Above it, how many changed pixels make a new picture is learnt
// per recording (learnThreshold).
const SAME_TEXT_MAX = 12;
// An (almost) one-coloured picture (black screen, "no signal", a blank slide): nearly every
// 5 x 5 block of the brightness picture within compression noise of the median. A small
// logo or a cursor may differ.
const UNIFORM_NOISE = 10;              // brightness levels of compression noise in a block mean
const UNIFORM_SHARE = 0.985;           // blocks that must be that close
// Which view is the screen (findScreen): the chosen view's values beat another view's in at
// least this share of pairs (a probability of superiority; 0.5 would be a coin toss) for
// the choice to count as clear. Not clear is not a failure: the most likely view is used
// and the user can choose another.
const SCREEN_CLEARLY = 0.75;
const SCREEN_PROBES = 6;               // keyframe pairs (or preview pictures) compared per view, spread over the recording
// Brightness levels a pixel of a still picture moves when it is encoded again (measured:
// 94-100% of a still screen's pixels within 2 between keyframes 10 s apart).
const STILL_LEVELS = 2;
const FLAT_LEVELS = 3;                 // brightness (sum of R, G, B) within which neighbours are "equal" (compression noise)
const CHAPTER_THUMB_W = 192;           // width of chapter pictures (the list shows them at about 96 CSS px)
// Segments (or chunks) in a row that cannot be read before an analysis stops (one is
// skipped: a dropped request or a damaged segment; several in a row is the network gone).
const ANALYSIS_MAX_FAILS = 5;

// ---- reading the screen (66-slide-ocr.js) ----
// Text recognition reads the smallest rendition at least this tall (or the tallest):
// slide text in 360p is not readable, 720p reads body text of slides shown full screen.
const OCR_HEIGHT = 720;
const OCR_PACE_MS = [200, 0];          // between samples; while playing a reading also rests as long as it took
const OCR_SAVE_EVERY = 10;             // readings between cache writes

// ---- which slide is on screen (67-slide-text.js) ----
// The evidence model (scoreModel) is fitted to each lecture. These only set its numerics:
// the grid its log-likelihood ratios are tabulated on (scores are 0-1, so a step of 0.01),
// the smallest spread a fitted distribution may have (one grid step, so a distribution is
// never narrower than the grid can show), the floor of a log-likelihood ratio (a page
// that cannot be right gets this instead of minus infinity, so that a forced correction
// can still choose it) and the most EM rounds (it converges in a few dozen).
const EVIDENCE_GRID = 101;
const EVIDENCE_MIN_SD = 1 / (EVIDENCE_GRID - 1);
const EVIDENCE_FLOOR = -25;
const EVIDENCE_EM_ROUNDS = 200;
// How lecturers move through slides: prior chances for the sequence model, per step from
// one picture to the next different one (so independent of how often the screen is
// sampled). They describe lecturing, not a course: mostly staying or moving on,
// sometimes going back, rarely jumping or changing file. The evidence from the text on
// screen outweighs them wherever it is clear; they decide only where the screen says
// little (a page without text, a blurry camera picture).
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

// ---- following the slides (68-slide-deck.js) ----
// A look at another page shorter than this (one sample) between two stretches of the same
// page does not turn the page.
const FOLLOW_MIN_SEC = 1.5 * CHAPTER_STEP_SEC;
const FOLLOW_STALE_SEC = 120;          // after this long without a recognised page, the reader says so (a product choice)
const FOLLOW_UPDATE_MS = 15000;        // while reading, pages are decided again at most this often (each run takes 0.1-1 s)
const DECK_RENDER_BUDGET = 40e6;       // rendered pages kept, in pixels (about 160 MB at 4 bytes a pixel)
const PAGE_TITLE_TOP = 0.4;            // a page's title is the largest text in this top share of the page
const PAGE_AR_DEFAULT = 9 / 16;        // height / width of a page not opened yet (slides are mostly 16:9)

// ---- silence (62-silence.js) ----
// Speech recognisers and loudness measures need nothing above 8 kHz: 16 kHz holds it.
const AUDIO_RATE = 16000;
const CHUNK_SEC = 60;                  // audio per request and decode (whole segments, about 350 KB)
const ENV_STEP = 0.1;                  // envelope resolution in seconds
const SPEECH_BAND_HZ = [150, 4000];    // the band of speech: rumble (air conditioning, projector fans) and hiss count as quiet
// The silence threshold is learnt per recording: a point between its noise floor and its
// speech level, taken as these percentiles of its levels (a lecture is mostly speech with
// pauses, so the 10th percentile is a pause and the 90th speech, whatever the volume).
const SILENCE_NOISE_PCT = 0.1;
const SILENCE_SPEECH_PCT = 0.9;
const SILENCE_SENSITIVITY = { low: 0.2, normal: 0.3, high: 0.4 };   // where between the two (user setting)
// With less than this between noise and speech (dB) there is no speech to tell apart: a
// muted microphone if it is all quieter than SILENCE_MUTED_DB, else nothing is silent.
const SILENCE_MIN_RANGE_DB = 6;
const SILENCE_MUTED_DB = -55;
const SILENCE_PAD = 0.5;               // seconds kept at each edge so skipping never clips speech
const SILENCE_BRIDGE = 1.5;            // a louder blip shorter than this (s) inside a pause stays silent
const SILENCE_MIN_CHOICES = [15, 30, 60, 120];   // shortest silence offered for skipping (s, user setting)
const SILENCE_START_DELAY_MS = 8000;   // before the first audio download: playback starts first
const SILENCE_PACE_MS = [2000, 400];   // between chunks (about 350 KB each)

// ---- audio processing (60-audio.js) ----
// Standard voice processing, set by ear on lecture recordings and checked by measurement:
// a recording 20 dB too quiet comes out at about -20 dBFS RMS without clipping, normal
// recordings are nearly unchanged, input above full scale is held about 4 dB below it.
const LEVEL_TARGET_DB = -20;           // target short-term RMS after levelling
const LEVEL_MAX_GAIN_DB = 18;          // never boost more than this
const LEVEL_TICK_MS = 500;             // how often the levelling gain is adjusted
const LEVEL_STEP_DB = [-1.5, 0.75];    // largest change per tick: down faster than up (no pumping)
const LEVEL_SMOOTHING = 0.85;          // weight of the past in the level average (about 3 s)
const LEVEL_SILENT_POW = 1e-8;         // below this mean power (-80 dBFS) the gain is left alone
const LIMIT_THRESHOLD_DB = -6;
const LIMIT_TRIM_DB = -3;              // offsets the compressor's built-in makeup gain
const VOICE_FILTERS = {
  highpassHz: 100, highpassQ: 0.7,     // below the voice: hum and handling noise
  presenceHz: 3000, presenceQ: 0.9, presenceDb: 4,   // consonants, for intelligibility
};
const LEVELLER = { threshold: -34, knee: 12, ratio: 3.5, attack: 0.02, release: 0.4 };
const LIMITER = { knee: 0, ratio: 20, attack: 0.001, release: 0.1 };

// ---- playback (35-stream.js, 38-sync.js, 40-player.js) ----
// Bandwidth assumed before hls.js has measured any: what the browser reports, else a
// broadband guess (the first segments of the top rendition are then fetched; hls.js steps
// down after a few seconds if that was too optimistic).
const STREAM_START_BPS = () => {
  const c = typeof navigator !== 'undefined' && navigator.connection;
  return c && c.downlink > 0 ? c.downlink * 1e6 : 5e6;
};
const STREAM_MAX_BUFFER_SEC = 30;      // ahead of the playhead (hls.js default)
const STREAM_BACK_BUFFER_SEC = 60;     // kept behind it, for short jumps back
// Share of the measured bandwidth the quality may use (stay below, step up): hls.js'
// defaults for the main view; the second view leaves room for it.
const STREAM_BW_FACTOR = { main: [0.95, 0.85], low: [0.7, 0.6] };
const STREAM_NET_RETRIES = 4;          // network errors retried (1, 2, 3, 4 s apart) before giving up
const STREAM_MEDIA_RECOVERIES = 2;     // decoder errors recovered before giving up
const SYNC_TOLERANCE = 0.08;           // seconds of drift between the views that are ignored
const SYNC_SEEK_AT = 1.0;              // seconds of drift corrected by seeking instead of nudging
const SYNC_MAX_NUDGE = 0.1;            // max relative rate change while catching up
const STALL_CHECK_MS = 2000;           // how often the stall watchdog looks
const STALL_SEC = 12;                  // playing, not seeking, time unmoved this long: restart loading
const POSITION_SAVE_EVERY = 5;         // watchdog ticks between saves of the resume position (10 s)
const RENEW_REFUSAL_MS = 30000;        // a refusal this soon after a renewal is not fixed by renewing again
const CONTROLS_HIDE_MS = 2500;         // controls hide after this long without the pointer moving
const DOUBLE_CLICK_MS = 200;           // a click is single once no second one follows within this
const DRAG_SEEK_MS = 200;              // seeking at most this often while dragging the progress bar
const RESUME_END_SEC = 10;             // a resume point this close to the end starts over instead (nothing left to watch)

// ---- session (36-session.js) ----
const SESSION_RETRY_MS = [2000, 5000]; // waits before the two retries of a failed renewal
const SESSION_DEFAULT_RENEW_MS = 3600000;   // when Echo360 does not say (it says 1 h; access lasts about 2 h)
const SESSION_MIN_RENEW_MS = 60000;    // never renew more often than this

// ---- page and course list (10-adapter-echo360.js, 80-course-list.js, 90-main.js) ----
const CUE_DEFAULT_MS = 3000;           // length of a transcript line without an end time
const LIST_CONCURRENT = 2;             // course page: player requests at a time
const LIST_GAP_MS = 150;               // and between them
const LIST_DEBOUNCE_MS = 300;          // redraws of the list waited for before labelling
const LIST_DONE_PCT = 99;              // watched share shown as complete
const BOOT_CHECK_MS = 8000;            // the page's own player not started this long after load: check why

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
  // once the document is complete. We catch that function so we receive the JSON and can
  // decide whether the original ever runs. The Echo object is wrapped in a Proxy, so the
  // function is caught however it gets there: assigned, defined with defineProperty (as
  // bundlers do), or already present when this runs; and so is an Echo object assigned
  // later. Only a call made through a reference to the object kept from before it was
  // assigned to window.Echo would pass by; the page's inline bootstrap uses the global.
  intercept(onBoot) {
    const NAME = 'echoPlayerV2FullApp';
    let original = null;

    function launcher(arg) {
      const self = this;
      return onBoot(arg, (a) => (original ? original.call(self, a) : undefined));
    }
    function wrap(obj) {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
      if (typeof obj[NAME] === 'function') original = obj[NAME];
      return new Proxy(obj, {
        get(target, key, receiver) {
          if (key === NAME) {
            // Defined on the object itself by code holding it directly: adopted now, when
            // the page calls it through the global Echo.
            const own = Reflect.get(target, key);
            if (typeof own === 'function' && own !== launcher) original = own;
            return original ? launcher : undefined;
          }
          return Reflect.get(target, key, receiver);
        },
        set(target, key, value) {
          if (key === NAME) { original = value; return true; }
          return Reflect.set(target, key, value);
        },
        defineProperty(target, key, desc) {
          if (key === NAME && ('value' in desc || desc.get)) {
            original = 'value' in desc ? desc.value : desc.get.call(target);
            return true;
          }
          return Reflect.defineProperty(target, key, desc);
        },
        has(target, key) { return key === NAME ? !!original : Reflect.has(target, key); },
        getOwnPropertyDescriptor(target, key) {
          if (key === NAME) return original ? { value: launcher, writable: true, enumerable: true, configurable: true } : undefined;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    }

    let echo = wrap(window.Echo || {});
    Object.defineProperty(window, 'Echo', {
      configurable: true,
      enumerable: true,
      get() { return echo; },
      set(v) { echo = wrap(v); },
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
      courseName: (cfg.sectionInfo && cfg.sectionInfo.course && (cfg.sectionInfo.course.courseName || cfg.sectionInfo.course.courseIdentifier)) || '',
      // How often the page renews the video access cookies (see 36-session.js).
      sessionRenewMs: typeof cfg.cookieRenewalIntervalMillis === 'number' ? cfg.cookieRenewalIntervalMillis : null,
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
          .map((c) => ({ start: c.startMs / 1000, end: (typeof c.endMs === 'number' ? c.endMs : c.startMs + CUE_DEFAULT_MS) / 1000, text: c.content.trim(), speaker: c.speaker || '' }));
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
      log.info('DRY RUN (not sent):', method, rec.url, rec.body || '');
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
  popout: '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="11" y="11" width="8" height="6" rx="1" fill="currentColor"/>',
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
  more: '<circle cx="5.5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="18.5" cy="12" r="1.8" fill="currentColor"/>',
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
/* Tags (local, private) */
.itags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.tagchip, .tagopt { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 6px; border-radius: 10px;
  background: rgba(255,255,255,.08); color: inherit; font: inherit; font-size: 12px; border: 0; cursor: pointer; }
.tagchip i, .tagopt i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.tagopt { opacity: .6; } .tagopt.on { opacity: 1; background: rgba(255,255,255,.18); }
.tagopt:hover, .tagchip:hover { background: rgba(255,255,255,.16); }
.tagpick { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; border-radius: 8px; background: rgba(0,0,0,.25); }
.tagnew { flex-basis: 100%; display: flex; gap: 8px; align-items: center; }
.tagnew input { flex: 1; min-width: 0; }
.addtag { font-size: 12px; }
.tagman { padding: 10px 12px; margin-bottom: 10px; border-radius: 10px; background: rgba(255,255,255,.045); display: flex; flex-direction: column; gap: 8px; }
.tagrow { display: flex; gap: 8px; align-items: center; }
.tagrow input { flex: 1; min-width: 0; }
.tagswatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4); cursor: pointer; flex: none; padding: 0; }
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
.mk-laststop { top: -1px; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px; background: rgba(255,255,255,.75); box-shadow: none; }
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
.tip .pv { display: block; width: 176px; aspect-ratio: 16 / 9; object-fit: contain; margin: 2px 0 4px; border-radius: 4px; background: #000; }
.tip .pv[hidden] { display: none; }
.pane[data-pane=slides] { overflow-y: auto; padding: 0 12px 16px; overscroll-behavior: contain; }
.sstatus { padding: 4px 2px 8px; font-size: 12px; opacity: .65; }
.sscreen { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 2px 8px; font-size: 12px; }
.sscreen:empty { display: none; }
.sscreen > span { opacity: .65; }
.sview { padding: 2px 8px; border-radius: 10px; border: 1px solid rgba(255,255,255,.25); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.sview.on { background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.5); }
.slist { display: flex; flex-direction: column; gap: 8px; }
.scard { display: flex; gap: 10px; align-items: flex-start; width: 100%; padding: 6px; border-radius: 10px; text-align: left; }
.scard:hover { background: rgba(255,255,255,.07); }
.scard.cur { background: rgba(79,140,255,.18); box-shadow: inset 0 0 0 1px rgba(79,140,255,.6); }
.scard img, .scard .noimg { flex: none; width: 128px; aspect-ratio: 16 / 9; border-radius: 6px; background: #222; object-fit: contain; }
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
.endnote { position: absolute; z-index: 5; right: 14px; bottom: 96px; display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 14px;
  border-radius: 18px; background: var(--panel); box-shadow: 0 4px 16px rgba(0,0,0,.4); font-size: 13px; }
.endnote[hidden] { display: none; }
.endnote button { height: 28px; padding: 0 12px; border-radius: 14px; background: rgba(255,255,255,.12); }
.endnote .endclose { width: 28px; padding: 0; background: none; opacity: .7; }
.sils i.empty { opacity: 1; filter: brightness(1.4); }
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
.rpages { position: absolute; inset: 0; }
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
/* The bar's background (a gradient over the picture) lets clicks through: only its buttons
   and title take them, so toolbars and windows near the top stay usable. */
.top { pointer-events: none; }
.top > * { pointer-events: auto; }
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
/* Session renewal in progress: a small label in the corner, never over the controls. */
.sessionhint { position: absolute; right: 12px; top: 60px; z-index: 5; display: flex; align-items: center; gap: 8px;
  padding: 5px 12px 5px 9px; border-radius: 14px; background: rgba(20,20,24,.82); color: #eee; font-size: 12px;
  pointer-events: none; }
.sessionhint[hidden] { display: none; }
.sessionhint i { width: 10px; height: 10px; border-radius: 50%; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff;
  animation: spin .9s linear infinite; }
.toast { position: absolute; z-index: 5; left: 50%; bottom: 96px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px;
  padding: 9px 10px 9px 16px; border-radius: 12px; background: var(--panel); font-size: 13px; box-shadow: 0 8px 30px rgba(0,0,0,.4); max-width: calc(100% - 28px); }
.toast[hidden] { display: none; }
.toast button { color: var(--accent); font-weight: 600; padding: 4px 8px; border-radius: 6px; }
.toast button:hover { background: rgba(255,255,255,.08); }
.error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.7); }
.error[hidden] { display: none; }
.error .card { max-width: 420px; margin: 16px; padding: 20px 22px; border-radius: 14px; background: #1b1b20; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
.error .card h2 { margin: 0 0 8px; font-size: 16px; }
.error .card p { margin: 0 0 16px; opacity: .8; }
.error .card .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
/* Watched before (this device): faint, under the buffer and the other marks */
.wat { position: absolute; inset: 0; pointer-events: none; }
.wat i { position: absolute; top: 0; bottom: 0; background: rgba(255,255,255,.16); }
/* A-B loop band on the progress bar */
.loopband { position: absolute; top: 2px; height: 14px; z-index: 2; border-radius: 4px; pointer-events: none;
  background: rgba(246,195,67,.22); box-shadow: inset 0 0 0 1.5px rgba(246,195,67,.9); min-width: 2px; }
.loopband[hidden] { display: none; }
.loopband.open { background: none; }
.loopband .lh { position: absolute; top: -3px; width: 8px; height: 20px; margin-left: -4px; border-radius: 3px; background: #f6c343;
  pointer-events: auto; cursor: ew-resize; touch-action: none; }
.loopband .la { left: 0; } .loopband .lb { left: 100%; }
.loopband.open .lb { display: none; }
.loopband .lx { position: absolute; right: -6px; top: -22px; width: 18px; height: 18px; padding: 0; border-radius: 50%; font-size: 11px; line-height: 18px;
  text-align: center; background: #f6c343; color: #111; pointer-events: auto; }
.loopmenu { right: auto; min-width: 180px; }
/* Zoom: overview of the visible part, and the hand while dragging. */
.zmap { position: absolute; z-index: 3; border: 1px solid rgba(255,255,255,.75); border-radius: 4px; background: rgba(0,0,0,.4);
  pointer-events: none; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
.zmap[hidden] { display: none; }
.zmap i { position: absolute; border: 1.5px solid #fff; background: rgba(255,255,255,.2); border-radius: 2px; }
.views .zoomed { cursor: grab; }
.views .panning { cursor: grabbing; }
.keyhelp, .diagbox { position: absolute; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.6); }
.keyhelp[hidden], .diagbox[hidden] { display: none; }
.khcard { max-width: min(640px, calc(100% - 32px)); max-height: calc(100% - 32px); overflow: auto; padding: 18px 22px; border-radius: 14px;
  background: #1b1b20; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
.khcard h2 { margin: 0 0 12px; font-size: 16px; }
.khlist { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 13px; margin-bottom: 14px; }
.khlist kbd { display: inline-block; min-width: 1.4em; padding: 1px 6px; margin-right: 3px; border-radius: 5px; text-align: center;
  background: rgba(255,255,255,.12); font: 12px/1.6 ui-monospace, monospace; }
.khcard .actions { display: flex; justify-content: flex-end; gap: 8px; }
.diaginfo { margin: 0 0 10px; font-size: 13px; opacity: .75; }
.diagtext { max-height: 50vh; overflow: auto; margin: 0 0 14px; padding: 10px 12px; border-radius: 8px; background: rgba(255,255,255,.06);
  font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }
.moremenu { min-width: 260px; }
.moremenu .row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; font-size: 13px; }
.moremenu .row .grow { flex: 1; opacity: .8; }
.moremenu .row button { width: auto; padding: 4px 10px; background: rgba(255,255,255,.1); }
.kbtn { font-weight: 700; min-width: 32px; justify-content: center; }
.error .card button { height: 34px; padding: 0 14px; border-radius: 8px; background: rgba(255,255,255,.1); }
.error .card button.primary { background: var(--accent); color: #fff; }
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
        <button class="pnav pprev" title="${tr('prevPage')}" aria-label="${tr('prevPage')}">‹</button>
        <span class="plabel"></span>
        <button class="pnav pnext" title="${tr('nextPage')}" aria-label="${tr('nextPage')}">›</button>
        <span class="pfollow"></span>
        <button class="pnav pswap" title="${tr('pdfSwap')}" aria-label="${tr('pdfSwap')}">⇄</button>
        <button class="pnav pdfclose" title="${tr('pdfMainClose')}" aria-label="${tr('pdfMainClose')}">✕</button>
      </div>
    </div>
    <div class="divider" role="separator" aria-orientation="vertical" aria-label="${tr('resizeViews')}" tabindex="0"></div>
    <div class="pipframe" title="${tr('pipHint')}"><div class="grip" title="${tr('resizePip')}"></div></div>
  </div>
  <div class="captions" hidden><span></span></div>
  <div class="center"><div class="spinner"></div></div>
  <div class="sessionhint" role="status" hidden><i></i><span>${tr('sessionRenewing')}</span></div>
  <div class="top">
    <a class="back" title="${tr('back')}" aria-label="${tr('back')}">${svg('back')}</a>
    <div class="title"></div>
    <span class="pausehint" aria-hidden="true">${svg('pause')}<span>${tr('pausedHint')}</span></span>
 <button class="chip tbtn" data-open="transcript" hidden aria-pressed="false" title="${tr('transcriptKey')}">${svg('transcript')}<span class="lbl">${tr('transcript')}</span></button>
    <button class="chip tbtn" data-open="slides" hidden aria-pressed="false" title="${tr('slidesKey')}">${svg('slides')}<span class="lbl">${tr('slides')}</span></button>
    <button class="chip tbtn" data-open="notes" hidden aria-pressed="false" title="${tr('notes')}">${svg('notes')}<span class="lbl">${tr('notes')}</span></button>
    <button class="chip tbtn" data-open="discussion" hidden aria-pressed="false" title="${tr('discussion')}">${svg('discussion')}<span class="lbl">${tr('discussion')}</span></button>
    <button class="chip kbtn" title="${tr('keysTitle')} (?)" aria-label="${tr('keysTitle')}">?</button>
    <button class="chip orig" title="${tr('originalPlayerTitle')}">${tr('originalPlayer')}</button>
  </div>
  <div class="bottom">
    <div class="seek" role="slider" aria-label="${tr('seek')}" tabindex="0">
      <div class="rail"><div class="wat"></div><div class="bar buf"></div><div class="sils"></div><div class="chaps"></div><div class="bar hov"></div><div class="bar fill"></div></div>
      <div class="imarks"></div>
      <div class="marks"></div>
      <div class="knob-track"><div class="knob"></div></div>
      <div class="tip"><img class="pv" alt="" hidden><span class="tt">0:00</span></div>
    </div>
    <div class="row">
      <button class="btn play" title="${tr('play')}" aria-label="${tr('play')}">${svg('play')}</button>
      <button class="btn rew hide-sm" title="${tr('rewind')}" aria-label="${tr('rewind')}">${svg('back10')}</button>
      <button class="btn fwd hide-sm" title="${tr('forward')}" aria-label="${tr('forward')}">${svg('fwd10')}</button>
      <div class="vol">
        <button class="btn mute" title="${tr('mute')}" aria-label="${tr('mute')}">${svg('volume')}</button>
        <input class="volume hide-sm" type="range" min="0" max="1" step="0.01" aria-label="${tr('volume')}">
      </div>
      <div class="time"><span class="cur">0:00</span> / <span class="dur">0:00</span></div>
      <div class="spacer"></div>
      <button class="btn bmbtn hide-sm" hidden title="${tr('bookmarkKey')}" aria-label="${tr('bookmark')}">${svg('bookmark')}</button>
      <button class="btn flagbtn hide-sm" hidden title="${tr('flagKey')}" aria-label="${tr('flag')}" aria-pressed="false">${svg('flag')}</button>
      <button class="btn copybtn" title="${tr('copy')}" aria-label="${tr('copy')}" aria-haspopup="menu">${svg('copy')}</button>
      <button class="btn audiobtn hide-sm" title="${tr('audio')}" aria-label="${tr('audio')}" aria-haspopup="menu">${svg('audio')}</button>
      <button class="btn ccbtn" hidden title="${tr('captionsKey')}" aria-label="${tr('captions')}" aria-haspopup="menu">${svg('cc')}</button>
      <button class="btn swap" title="${tr('swapViews')}" aria-label="${tr('swapViews')}">${svg('swap')}</button>
      <button class="btn layout" title="${tr('layout')}" aria-label="${tr('layout')}" aria-haspopup="menu">${svg('layoutSide')}</button>
      <button class="qbtn hide-sm" title="${tr('quality')}" aria-label="${tr('quality')}" aria-haspopup="menu"></button>
      <button class="speed" title="${tr('speed')}" aria-label="${tr('speed')}">1x</button>
      <button class="btn popbtn" hidden aria-pressed="false" title="${tr('popout')} (W)" aria-label="${tr('popout')}">${svg('popout')}</button>
      <button class="btn fs" title="${tr('fullscreen')}" aria-label="${tr('fullscreen')}">${svg('fullscreen')}</button>
      <button class="btn morebtn" title="${tr('moreMenu')}" aria-label="${tr('moreMenu')}" aria-haspopup="menu">${svg('more')}</button>
    </div>
  </div>
  <div class="menu qualitymenu" hidden role="menu"></div>
  <div class="menu speedmenu" hidden role="menu"><div class="head">${tr('speed')}</div></div>
  <div class="menu layoutmenu" hidden role="menu"><div class="head">${tr('layout')}</div>
    <button role="menuitemradio" data-layout="side">${svg('layoutSide')}${tr('layoutSide')}</button>
    <button role="menuitemradio" data-layout="pip">${svg('layoutPip')}${tr('layoutPip')}</button>
    <button role="menuitemradio" data-layout="single">${svg('layoutSingle')}${tr('layoutSingle')}</button>
  </div>
  <div class="menu ccmenu" hidden role="menu"><div class="head">${tr('captions')}</div>
    <button class="opt cctoggle" role="menuitemcheckbox" aria-checked="false"><span>${tr('showCaptions')}</span><span class="state"></span></button>
    <button class="opt cchidepaused" role="menuitemcheckbox" aria-checked="true"><span>${tr('hideCaptionsPaused')}</span><span class="state"></span></button>
    <div class="head">${tr('captionSize')}</div>
    <div class="sizes">
      <button role="menuitemradio" data-size="s">S</button><button role="menuitemradio" data-size="m">M</button><button role="menuitemradio" data-size="l">L</button><button role="menuitemradio" data-size="xl">XL</button>
    </div>
  </div>
  <div class="menu copymenu" hidden role="menu"><div class="head">${tr('copy')}</div>
    <button class="opt" role="menuitem" data-copy="frame"><span class="row1"><span>${tr('copyFrame')}</span><span class="key">P</span></span><span class="desc">${tr('copyFrameDesc')}</span></button>
    <button class="opt" role="menuitem" data-copy="captions"><span class="row1"><span>${tr('copyCaptions')}</span><span class="key">A</span></span><span class="desc">${tr('copyCaptionsDesc')}</span></button>
    <div class="sub">${tr('copyCaptionsSpan')}</div>
    <div class="choices copyspan">${[30, 60, 120, 300].map((s) => `<button role="menuitemradio" data-span="${s}">${s < 60 ? s + 's' : s / 60 + 'm'}</button>`).join('')}</div>
  </div>
  <div class="menu moremenu" hidden role="menu"></div>
  <div class="diagbox" hidden role="dialog" aria-label="${tr('diagTitle')}"><div class="khcard"><h2>${tr('diagTitle')}</h2>
    <p class="diaginfo">${tr('diagInfo')}</p><pre class="diagtext"></pre>
    <div class="actions"><button class="pbtn diagcopy">${tr('diagCopy')}</button><button class="pbtn diagclose">${tr('close')}</button></div></div></div>
  <div class="menu audiomenu" hidden role="menu"><div class="head">${tr('audio')}</div>
    <div class="why" hidden></div>
    <button class="opt" role="menuitemcheckbox" data-audio="level" aria-checked="false"><span class="row1"><span>${tr('audioLevel')}</span><span class="state"></span></span><span class="desc">${tr('audioLevelDesc')}</span></button>
    <button class="opt" role="menuitemcheckbox" data-audio="voice" aria-checked="false"><span class="row1"><span>${tr('audioVoice')}</span><span class="state"></span></span><span class="desc">${tr('audioVoiceDesc')}</span></button>
    <button class="opt" role="menuitemcheckbox" data-audio="mono" aria-checked="false"><span class="row1"><span>${tr('audioMono')}</span><span class="state"></span></span><span class="desc">${tr('audioMonoDesc')}</span></button>
    <div class="sep"></div>
    <div class="head">${tr('silence')}</div>
    <div class="silstatus"></div>
    <button class="opt" role="menuitemcheckbox" data-sil="auto" aria-checked="false"><span class="row1"><span>${tr('silenceAuto')}</span><span class="state"></span></span><span class="desc">${tr('silenceAutoDesc')}</span></button>
    <div class="sub">${tr('silenceMin')}</div>
    <div class="choices silmin">${SILENCE_MIN_CHOICES.map((s) => `<button role="menuitemradio" data-min="${s}">${s < 60 ? s + 's' : s / 60 + 'm'}</button>`).join('')}</div>
    <div class="sens"><div class="sub">${tr('silenceSensitivity')}</div>
    <div class="choices silsens"><button role="menuitemradio" data-sens="low">${tr('low')}</button><button role="menuitemradio" data-sens="normal">${tr('normal')}</button><button role="menuitemradio" data-sens="high">${tr('high')}</button></div></div>
  </div>
  <button class="skipsil fade" tabindex="-1"></button>
  <div class="endnote" hidden role="status"><span>${tr('contentEnded')}</span>
    <button class="endskip">${tr('contentEndSkip')}</button><button class="endstop">${tr('contentEndStop')}</button>
    <button class="endclose" aria-label="${tr('close')}">✕</button></div>
  <div class="toast" hidden><span class="msg"></span><button class="act"></button></div>
  <div class="dropzone" hidden>${tr('dropSlides')}</div>
  <div class="error" hidden><div class="card"><h2></h2><p></p><div class="actions"></div></div></div>
  <div class="keyhelp" hidden role="dialog" aria-label="${tr('keysTitle')}"><div class="khcard"><h2>${tr('keysTitle')}</h2><div class="khlist"></div>
    <div class="actions"><button class="pbtn khclose">${tr('close')}</button></div></div></div>
</div>
<aside class="panel" hidden aria-label="${tr('sidebarTabs')}">
  <div class="presize" title="${tr('resizePanel')}"></div>
  <div class="phead">
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="transcript" hidden>${tr('transcript')}</button>
      <button role="tab" data-tab="slides" hidden>${tr('slides')}</button>
      <button role="tab" data-tab="notes" hidden>${tr('notes')}</button>
      <button role="tab" data-tab="discussion" hidden>${tr('discussion')}</button>
    </div>
    <button class="btn panelclose" title="${tr('closePanel')}" aria-label="${tr('closePanel')}">${svg('close')}</button>
  </div>
  <div class="pextras" hidden><div class="msg"></div><button class="link">${tr('openInOriginal')}</button></div>
  <section class="pane" data-pane="transcript" hidden>
    <div class="psearch">
      <input class="tsearch" type="search" placeholder="${tr('searchTranscript')}" aria-label="${tr('searchTranscript')}">
      <span class="tcount" aria-live="polite"></span>
      <button class="btn tprev" title="${tr('prevMatch')}" aria-label="${tr('prevMatch')}">${svg('up')}</button>
      <button class="btn tnext" title="${tr('nextMatch')}" aria-label="${tr('nextMatch')}">${svg('down')}</button>
    </div>
    <div class="tlist" tabindex="0"></div>
    <button class="tback" hidden>${tr('backToCurrent')}</button>
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

// ---- 36-session.js ----
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
// mediaSession.renew() is what fetchOk() (61-media-io.js) calls for background downloads.
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

// ---- 38-sync.js ----
// ===================================================================================
// Keeps a muted follower <video> in step with the clock <video> (the one with audio).
//   - play / pause / seek / rate changes are mirrored immediately;
//   - while the clock buffers, the follower waits;
//   - a 1 s check while playing nudges the follower's rate for small drift and seeks it
//     for large drift. The check only runs while the clock is playing.
// ===================================================================================

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
    this.timer = setInterval(guardCore(() => this.check()), 1000);
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

// ---- 39-prefs.js ----
// ===================================================================================
// Settings: the defaults and one validation for everything that reads them back (the
// player at start, a backup restore). Each field is checked for type and range; anything
// else falls back to its default and unknown fields are dropped, so a damaged or foreign
// value can never stop the player from starting.
// ===================================================================================

const COPY_SPANS = [30, 60, 120, 300];

function prefDefaults() {
  return {
    primary: null, layout: 'side', ratio: 0.5, pipw: 0.26, corner: 'br', rate: 1, volume: 1, muted: false,
    captions: false, capSize: 'm', capHidePaused: true, panel: false, tab: 'transcript', panelw: 360,
    audio: { level: false, voice: false, mono: false },
    silence: { auto: false, min: 30, sens: 'normal' },
    copySpan: 60,
    pdfMain: false, pdfFirst: false,
    quality: { screen: 'auto', camera: 'auto' },
  };
}

function sanitizePrefs(raw) {
  const d = prefDefaults();
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : def);
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const oneOf = (v, list, def) => (list.includes(v) ? v : def);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const audio = obj(r.audio);
  const silence = obj(r.silence);
  const quality = obj(r.quality);
  const height = (v) => (v === 'auto' || (Number.isInteger(v) && v > 0 && v <= 4320) ? v : 'auto');
  return {
    primary: Number.isInteger(r.primary) && r.primary >= 0 ? r.primary : d.primary,
    layout: oneOf(r.layout, LAYOUTS, d.layout),
    ratio: num(r.ratio, 0.2, 0.8, d.ratio),
    pipw: num(r.pipw, 0.15, 0.6, d.pipw),
    corner: oneOf(r.corner, CORNERS, d.corner),
    rate: num(r.rate, 0.25, 4, d.rate),
    volume: num(r.volume, 0, 1, d.volume),
    muted: bool(r.muted, d.muted),
    captions: bool(r.captions, d.captions),
    capSize: oneOf(r.capSize, Object.keys(CAPTION_SIZES), d.capSize),
    capHidePaused: bool(r.capHidePaused, d.capHidePaused),
    panel: bool(r.panel, d.panel),
    tab: oneOf(r.tab, SIDEBAR_TABS, d.tab),
    panelw: num(r.panelw, 260, 2000, d.panelw),
    audio: { level: bool(audio.level, false), voice: bool(audio.voice, false), mono: bool(audio.mono, false) },
    silence: {
      auto: bool(silence.auto, false),
      min: oneOf(silence.min, SILENCE_MIN_CHOICES, d.silence.min),
      sens: oneOf(silence.sens, Object.keys(SILENCE_SENSITIVITY), d.silence.sens),
    },
    copySpan: oneOf(r.copySpan, COPY_SPANS, d.copySpan),
    pdfMain: bool(r.pdfMain, d.pdfMain),
    pdfFirst: bool(r.pdfFirst, d.pdfFirst),
    quality: { screen: height(quality.screen), camera: height(quality.camera) },
  };
}

// A saved position ({ t, at }) or null.
function sanitizePos(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.t !== 'number' || !isFinite(raw.t) || raw.t < 0) return null;
  return { t: raw.t, at: typeof raw.at === 'number' && isFinite(raw.at) ? raw.at : 0 };
}

// localStorage entries a backup may restore, with their validation. Development
// switches (debug, dryRun, ...) are never restored.
const BACKUP_LOCAL = [
  { match: (k) => k === 'prefs', clean: sanitizePrefs },
  { match: (k) => /^pos:[\w:.-]{1,200}$/.test(k), clean: sanitizePos },
];

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
    this.levelsByRole = {};
    this.skips = [];          // skippable stretches (updateSkips)
    this.contentEnd = null;
    this.played = new PlayedRanges();
    this.lastSecond = -1;
    this.lastP = -1;
    this.lastB = -1;
    this.dragging = false;
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
    // Optional features: one failing to start is turned off, the others and playback go on.
    featureGuard('silence detection', () => this.setupSilence());
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
    this.clock.quality = this.qualityFor(pos);
    this.clock.priority = this.roleOf(pos) === 'camera' ? 'low' : 'high';
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
    if (!v.videoWidth) { this.toast(tr('copyFailed', { msg: 'no picture yet' })); return; }
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    // The clipboard item is created synchronously (within the user action) from a promise.
    const blob = new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      .then(() => this.toast(tr('copiedFrame', { w: c.width, h: c.height })))
      .catch((e) => this.toast(tr('copyFailed', { msg: (e && e.message) || e })));
  }

  // Copies what was said in the last copySpan seconds, in whole sentences, with the
  // lecture's name and the time range.
  copyCaptions() {
    if (!this.cues || !this.cues.length) { this.toast(tr('copyNoCaptions')); return; }
    const x = captionExcerpt(this.cues, this.video.currentTime, this.prefs.copySpan || 60);
    if (!x) { this.toast(tr('copyNoCaptions')); return; }
    const long = this.duration() >= 3600;
    const from = fmtTime(x.start, long);
    const to = fmtTime(x.end, long);
    const text = this.lesson.title + '\n' + from + '–' + to + '\n\n' + x.text + '\n';
    navigator.clipboard.writeText(text)
      .then(() => this.toast(tr('copiedCaptions', { from, to })))
      .catch((e) => this.toast(tr('copyFailed', { msg: (e && e.message) || e })));
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
    for (const [stream, elem, pos] of pairs) {
      if (pos < 0 || !stream.uri) continue;
      let cap = 0;
      if (this.layout === 'pip' && elem.dataset.slot === 'secondary' && this.roleOf(pos) === 'camera') {
        cap = Math.ceil(elem.clientHeight * (window.devicePixelRatio || 1));
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
    this.$('.qbtn').textContent = h ? h + 'p' : tr('qualityAuto');
    if (!this.$('.qualitymenu').hidden) this.renderQualityMenu();
  }

  renderQualityMenu() {
    const menu = this.$('.qualitymenu');
    menu.textContent = '';
    menu.append(el('div.head', { text: tr('quality') }));
    const roles = this.dual ? ['screen', 'camera'] : [this.roleOf(0)];
    for (const role of roles) {
      const pos = this.sources.findIndex((s, i) => this.roleOf(i) === role);
      if (pos < 0) continue;
      const stream = pos === this.clockPos ? this.clock : pos === this.followerPos ? this.follower : null;
      const playing = stream && stream.height ? stream.height + 'p' : '';
      if (this.dual) menu.append(el('div.sub', { text: tr(role === 'screen' ? 'qualityScreen' : 'qualityCamera') + (playing ? ' \u00b7 ' + tr('qualityNow', { q: playing }) : '') }));
      else if (playing) menu.append(el('div.sub', { text: tr('qualityNow', { q: playing }) }));
      const want = this.prefs.quality[role];
      const heights = (this.levelsByRole[role] || []).slice().sort((a, b) => b - a);
      const opts = [['auto', tr('qualityAutoBest')]].concat(heights.map((x) => [x, x + 'p']));
      for (const [val, label] of opts) {
        menu.append(el('button', { role: 'menuitemradio', 'aria-checked': String(want === val), 'data-role': role, 'data-q': String(val), text: label }));
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
      this.silenceTick(ct);
      if (this.slidesPane) this.slidesPane.update(ct);
      if (this.reader) this.reader.update(ct);
    };
    on('timeupdate', () => { invalidate(); onTime(); });
    on('seeked', onTime);
    on('progress', invalidate);
    on('durationchange', () => { this.render(true); if (this.loop) this.loop.render(); this.renderWatched(); this.updateMarkers(); this.updateSkips(); this.renderChapterMarks(); });
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

  // Time label, progress and buffer bars. Runs at most once per frame and only while the
  // controls are visible; wake() forces a refresh when they reappear.
  render(force) {
    if (this.destroyed) return;
    if (!force && this.stage.classList.contains('idle')) return;
    const v = this.video;
    const dur = this.duration();
    const ct = this.clock.position();
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

  // ---- floating window (Document Picture-in-Picture) ----

  canPopout() { return typeof window.documentPictureInPicture === 'object' && !!window.documentPictureInPicture; }

  // Moves the whole player (both views, controls, captions, side panel) into a floating
  // window and back. Nothing is rebuilt: the same elements, streams and audio graph move.
  async togglePopout() {
    if (this.popout) { this.popout.close(); return; }
    // A second press while the window is being opened does nothing (no second window).
    if (this.popoutOpening) return;
    this.popoutOpening = true;
    try { await this.openPopout(); } finally { this.popoutOpening = false; }
  }

  async openPopout() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    const r = this.host.getBoundingClientRect();
    let pip;
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: Math.round(Math.min(960, r.width * 0.6)), height: Math.round(Math.min(600, r.height * 0.6)) });
    } catch (e) {
      this.toast(tr('popoutFailed', { msg: (e && e.message) || e }));
      return;
    }
    if (this.destroyed) { pip.close(); return; }
    const playing = !this.video.paused;
    const holder = el('div.e3l-holder', { style: 'display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:' + Math.round(r.height) + 'px;background:#111;color:#ccc;font:14px system-ui,sans-serif' },
      el('span', { text: tr('popoutHere') }),
      el('button', { text: tr('popoutBack'), style: 'padding:6px 12px;border-radius:8px;border:0;cursor:pointer', onclick: () => pip.close() }));
    const doc = pip.document;
    const css = this.host.style.cssText;
    const keys = (e) => this.onKey(e);
    const resize = () => { if (!this.destroyed) { this.applyQuality(); this.redrawPdf(); } };
    // Putting the player back. Registered before anything moves, so a failure half-way
    // (or the window closing at any point) always brings the player back to the page.
    let back = false;
    const putBack = () => {
      if (back) return;
      back = true;
      doc.removeEventListener('keydown', keys, true);
      pip.removeEventListener('resize', resize);
      this.popout = null;
      // The player was destroyed meanwhile (handed over to the original player): only the
      // placeholder goes; the old player must not come back over the original one.
      if (this.destroyed) { holder.remove(); return; }
      const still = !this.video.paused;
      this.host.classList.remove('in-popout');
      this.host.style.cssText = css;
      if (holder.isConnected) holder.replaceWith(this.host);
      if (still && this.video.paused) this.video.play().catch(() => {});
      this.$('.popbtn').setAttribute('aria-pressed', 'false');
      this.applyQuality();
      this.redrawPdf();
    };
    pip.addEventListener('pagehide', putBack, { once: true });
    this.popout = pip;
    try {
      this.host.replaceWith(holder);
      doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
      doc.title = this.lesson.title;
      this.host.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
      doc.body.append(this.host);
      this.host.classList.add('in-popout');
      doc.addEventListener('keydown', keys, true);
      pip.addEventListener('resize', resize);
      // Moving can pause the elements in some browsers: carry on as before.
      if (playing && this.video.paused) this.video.play().catch(() => {});
      this.$('.popbtn').setAttribute('aria-pressed', 'true');
    } catch (e) {
      putBack();
      try { pip.close(); } catch (err) { /* already closed */ }
      throw e;
    }
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
    }), CONTROLS_HIDE_MS);
  }

  bindControls() {
    this.d.listen(this.$('.kbtn'), 'click', (e) => { e.stopPropagation(); this.showKeys(true); });
    this.d.listen(this.$('.diagclose'), 'click', (e) => { e.stopPropagation(); this.$('.diagbox').hidden = true; });
    this.d.listen(this.$('.diagcopy'), 'click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(this.$('.diagtext').textContent)
        .then(() => this.toast(tr('diagCopied')), (err) => this.toast(tr('copyFailed', { msg: (err && err.message) || err })));
    });
    // Old analysis results are cleaned up in the background, once the page has settled.
    this.d.timeout(() => analysisCaches.prune().catch(() => {}), 60000);
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
    // On teardown: close the window; its pagehide (sync or later) only removes the
    // placeholder, since the player is destroyed by then.
    d.add(() => { if (this.popout) { try { this.popout.close(); } catch (e) { /* closed */ } } });
    d.listen($('.swap'), 'click', () => this.swapViews());
    d.listen($('.orig'), 'click', () => this.opts.onFallback('user'));
    d.listen(document, 'fullscreenchange', () => {
      this.setButton('.fs', document.fullscreenElement ? 'exitFullscreen' : 'fullscreen', tr('fullscreen'));
    });

    // Menus (speed, layout): one open at a time, closed by any click elsewhere.
    const menus = [[$('.speed'), $('.speedmenu')], [$('.layout'), $('.layoutmenu')], [$('.ccbtn'), $('.ccmenu')], [$('.audiobtn'), $('.audiomenu')], [$('.qbtn'), $('.qualitymenu')], [$('.copybtn'), $('.copymenu')], [$('.morebtn'), $('.moremenu')]];
    for (const [btn, menu] of menus) {
      d.listen(btn, 'click', (e) => {
        e.stopPropagation();
        const open = menu.hidden;
        for (const [, m] of menus) m.hidden = true;
        if (open && menu.classList.contains('qualitymenu')) this.renderQualityMenu();
        if (open && menu.classList.contains('copymenu')) this.renderCopyMenu();
        if (open && menu.classList.contains('moremenu')) this.renderMoreMenu();
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
    d.listen($('.panelclose'), 'click', () => this.sidebar.close());
    d.listen($('.bmbtn'), 'click', (e) => { if (this.notes) this.notes.addBookmark(e); });
    d.listen($('.flagbtn'), 'click', (e) => { if (this.notes) this.notes.toggleFlag(e); });
    d.listen($('.pextras button'), 'click', () => this.opts.onFallback('extras'));
    this.bindPanelResize();
    d.listen(this.root, 'click', (e) => {
      if (e.target.closest('.menu, .speed, .layout, .ccbtn, .audiobtn, .qbtn, .copybtn, .morebtn')) return;
      for (const [, m] of menus) m.hidden = true;
      if (this.loop) this.loop.menu.hidden = true;
    });
    this.loop = new ABLoop(this, this.d.feature('A-B loop'));

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
      const sil = nearMarker ? null : this.skips[silenceIndexAt(this.skips, f * dur)];
      tipText.textContent = nearMarker
        ? fmtTime(nearMarker.time, dur >= 3600) + ' \u00b7 ' + (nearMarker.label.length > 70 ? nearMarker.label.slice(0, 67) + '\u2026' : nearMarker.label)
        : fmtTime(f * dur, dur >= 3600) + (sil ? ' \u00b7 ' + tr(sil.kind + 'Tip', { time: fmtTime(sil.end - sil.start) }) : '');
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
        if (now - lastSeekAt > DRAG_SEEK_MS) { lastSeekAt = now; v.currentTime = f * this.duration(); }
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
        for (const elem of pipEls()) elem.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
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
        for (const elem of pipEls()) elem.style.transform = '';
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
          if (!this.$('.diagbox').hidden) this.$('.diagbox').hidden = true;
          else if (!this.$('.keyhelp').hidden) this.showKeys(false);
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
    toggle.querySelector('.state').textContent = on ? tr('on') : tr('off');
    for (const b of this.root.querySelectorAll('.ccmenu .sizes button')) b.setAttribute('aria-checked', String(b.dataset.size === this.prefs.capSize));
    const hide = this.$('.cchidepaused');
    hide.setAttribute('aria-checked', String(!!this.prefs.capHidePaused));
    hide.querySelector('.state').textContent = this.prefs.capHidePaused ? tr('on') : tr('off');
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
    if (a.uniform !== this.knownUniform) { this.knownUniform = a.uniform; this.updateSkips(); }
    // The screen view is known now: the per-view quality settings may apply differently.
    if (a.screenIndex !== this.knownScreen) {
      this.knownScreen = a.screenIndex;
      this.applyQuality();
      if (this.deck) this.deck.screenKnown();
    }
    this.renderChapterMarks();
    // The tab also holds the slide reader: it is there once the analysis has an answer,
    // even when no chapters were found.
    if (!this.slidesPane && !a.chapters.length && a.state !== 'done' && a.state !== 'unavailable') return;
    if (a.state === 'unavailable' && this.deck) this.deck.screenKnown();
    if (!this.slidesPane) {
      this.slidesPane = new SlidesPane(this, this.$('.pane[data-pane=slides]'));
      this.d.add(() => this.slidesPane.dispose());
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
    const elem = this.$('.chaps');
    elem.textContent = '';
    const dur = this.duration();
    if (!dur || !this.slides) return;
    const frag = document.createDocumentFragment();
    for (const c of this.slides.chapters) {
      if (c.start <= 0 || c.start >= dur) continue;
      const i = document.createElement('i');
      i.style.left = ((c.start / dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    elem.appendChild(frag);
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
      disposer: this.d.feature('silence detection'),
      onChange: () => { if (!this.destroyed) { this.updateSkips(); this.renderSilenceMenu(); } },
    });
    this.silence.options = { minSec: p.min, sensitivity: p.sens };
    this.silIdx = -1;
    this.silAutoSkipped = new Set();
    this.d.add(() => { clearTimeout(this.skipTimer); clearTimeout(this.endTimer); });
    this.d.listen(this.$('.endskip'), 'click', (e) => { e.stopPropagation(); this.hideEnd(); this.seek(this.duration()); });
    this.d.listen(this.$('.endstop'), 'click', (e) => { e.stopPropagation(); this.hideEnd(); this.video.pause(); });
    this.d.listen(this.$('.endclose'), 'click', (e) => { e.stopPropagation(); this.hideEnd(); });
    const btn = this.$('.skipsil');
    this.d.listen(btn, 'click', (e) => {
      e.stopPropagation();
      const s = this.skips[this.silIdx];
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

  // Stretches that can be skipped (silences, empty screen) and where the content ends.
  updateSkips() {
    const sil = this.silence;
    const uniform = this.slides ? this.slides.uniform : [];
    const audioKnown = !!sil && (sil.source === 'transcript' || sil.source === 'audio');
    this.skips = skipStretches(sil ? sil.silences : [], uniform, audioKnown, this.prefs.silence.min);
    const dur = this.duration();
    this.contentEnd = dur ? contentEndAt(this.skips, dur) : null;
    if (this.watched) this.watched.contentEnd = this.contentEnd && this.contentEnd < dur ? this.contentEnd : null;
    this.renderSilences();
  }

  renderSilences() {
    const elem = this.$('.sils');
    elem.textContent = '';
    const dur = this.duration();
    if (!dur) return;
    const frag = document.createDocumentFragment();
    for (const s of this.skips) {
      const i = document.createElement('i');
      if (s.kind !== 'silence') i.className = 'empty';
      i.style.left = ((s.start / dur) * 100).toFixed(3) + '%';
      i.style.width = (((Math.min(s.end, dur) - s.start) / dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    elem.appendChild(frag);
    // New results (the analysis refines them as it goes) must not pop the button up again.
    this.silIdx = silenceIndexAt(this.skips, this.video.currentTime);
  }

  renderSilenceMenu() {
    const a = this.silence;
    const p = this.prefs.silence;
    const total = a.silences.reduce((n, s) => n + s.end - s.start, 0);
    const found = a.silences.length
      ? tr(a.source === 'transcript' ? 'silenceFromTranscript' : 'silenceFound', { n: a.silences.length, time: fmtTime(total) })
      : tr('silenceNone', { min: p.min < 60 ? p.min + ' s' : p.min / 60 + ' min' });
    let status;
    if (a.source === 'pending') status = tr('silenceWaiting');
    else if (a.source === 'unavailable') status = tr(a.reason === 'saveData' ? 'silenceSaveData' : 'silenceUnavailable');
    else if (a.source === 'audio' && a.progress < 1) status = tr('silenceAnalysing', { pct: Math.floor(a.progress * 100) }) + (a.silences.length ? ' ' + found : '');
    else status = found;
    const menu = this.$('.audiomenu');
    menu.querySelector('.silstatus').textContent = status;
    const auto = menu.querySelector('[data-sil=auto]');
    auto.setAttribute('aria-checked', String(p.auto));
    auto.querySelector('.state').textContent = p.auto ? tr('on') : tr('off');
    for (const b of menu.querySelectorAll('.silmin button')) b.setAttribute('aria-checked', String(+b.dataset.min === p.min));
    for (const b of menu.querySelectorAll('.silsens button')) b.setAttribute('aria-checked', String(b.dataset.sens === p.sens));
    // Sensitivity only matters when the audio itself is measured.
    menu.querySelector('.sens').hidden = a.source !== 'audio';
  }

  // On every time update: entering a silence offers to skip it (or skips it, if the user
  // turned that on). Only playback running into a silence skips automatically; seeking
  // into one just shows the button.
  silenceTick(ct) {
    const list = this.skips;
    if (!list.length && this.silIdx === -1) return;
    const prev = this.silIdx;
    const i = silenceIndexAt(list, ct);
    if (i === prev) return;
    this.silIdx = i;
    const s = list[i];
    if (!s) { this.hideSkip(); this.hideEnd(); return; }
    const ranInto = !this.video.seeking && !this.dragging && ct - s.start < 2;
    // The empty stretch at the end: the lecture is over.
    if (s.start === this.contentEnd) { this.hideSkip(); if (ranInto || ct - s.start < 15) this.showEnd(); return; }
    if (s.end - ct < 5) { this.hideSkip(); return; }
    // An empty screen with unknown audio is never skipped automatically.
    if (this.prefs.silence.auto && s.kind !== 'black' && ranInto && !this.silAutoSkipped.has(s.start)) {
      this.silAutoSkipped.add(s.start);
      const from = ct;
      this.hideSkip();
      this.seek(s.end);
      this.toast(tr(s.kind === 'blank' ? 'skippedBlank' : 'skippedSilence', { time: fmtTime(s.end - from) }), tr('undo'), () => this.seek(from));
      return;
    }
    this.showSkip(s, ct);
  }

  showSkip(s, ct) {
    const btn = this.$('.skipsil');
    btn.textContent = tr(s.kind === 'silence' ? 'skipSilence' : 'skipBlank', { time: fmtTime(s.end - ct) });
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

  // "The lecture has ended": jump to the end (finishing it) or stop here.
  showEnd() {
    const box = this.$('.endnote');
    box.hidden = false;
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(guard(() => this.hideEnd()), 20000);
  }

  hideEnd() {
    this.$('.endnote').hidden = true;
    clearTimeout(this.endTimer);
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

  // Stretches watched on this device (earlier visits and this one), faint on the rail.
  renderWatched() {
    const dur = this.duration();
    const elem = this.$('.wat');
    if (!dur || !this.watched.ready) return;
    elem.textContent = '';
    const frag = document.createDocumentFragment();
    for (const [a, b] of this.watched.ranges()) {
      const i = document.createElement('i');
      i.style.left = ((a / dur) * 100).toFixed(3) + '%';
      i.style.width = (((Math.min(b, dur) - a) / dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    elem.appendChild(frag);
  }

  // Keyboard zoom on the main picture (the primary slot), around its centre; 0 resets.
  zoomMain(factor) {
    const slot = this.root.querySelector('.views [data-slot=primary]');
    const elem = slot && (slot.tagName === 'VIDEO' ? slot : slot.querySelector('.rpages'));
    if (!elem) return;
    if (!factor) { this.zoom.reset(elem); return; }
    this.zoom.zoomAt(elem, factor, 0.5, 0.5);
  }

  // The ⋯ menu: analysis results stored on this device (size, clear), diagnostics, keys.
  renderMoreMenu() {
    const m = this.$('.moremenu');
    m.textContent = '';
    const size = el('span.grow', { text: tr('cachesMeasuring') });
    const clear = el('button', { text: tr('cachesClear') });
    clear.addEventListener('click', guard(async (e) => {
      e.stopPropagation();
      clear.disabled = true;
      const n = await analysisCaches.clear();
      size.textContent = tr('cachesCleared', { n });
    }));
    m.append(el('div.head', { text: 'Echo360 Lite ' + VERSION }),
      el('div.row', { title: tr('cachesInfo') }, size, clear),
      el('button', { text: tr('diagMenu'), onclick: (e) => { e.stopPropagation(); m.hidden = true; this.showDiagnostics(); } }),
      el('button', { text: tr('keysTitle') + ' (?)', onclick: (e) => { e.stopPropagation(); m.hidden = true; this.showKeys(true); } }));
    analysisCaches.usage().then((u) => {
      size.textContent = tr('cachesSize', { mb: (u.bytes / 1e6).toFixed(u.bytes < 1e7 ? 1 : 0), n: u.count });
    }).catch(() => { size.textContent = tr('cachesUnknown'); });
  }

  showDiagnostics() {
    this.$('.diagtext').textContent = diagnosticsText(this);
    this.$('.diagbox').hidden = false;
    this.$('.diagcopy').focus();
  }

  showKeys(on) {
    const box = this.$('.keyhelp');
    if (on) {
      const list = box.querySelector('.khlist');
      list.textContent = '';
      for (const [keys, label] of KEY_HELP) {
        list.append(el('div', null, ...keys.map((k) => el('kbd', { text: k }))), el('div', { text: tr(label) }));
      }
    }
    box.hidden = !on;
    if (on) box.querySelector('.khclose').focus();
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

// ---- 50-zoom.js ----
// ===================================================================================
// Zoom and pan inside a view (the screen video, the camera, or the PDF in the picture
// area): the wheel or a trackpad pinch zooms around the pointer, dragging pans, a double
// click returns to the whole picture. The element keeps its place in the layout; only a
// transform and a clip are set on it, so playback, Web Audio and the layouts are untouched.
// While zoomed in, a small overview in the view's corner shows which part is visible.
// ===================================================================================

const ZOOM_MAX = 8;

class Zoomer {
  // host: the element the views live in (.views); opts.onChange() after any change.
  constructor(host, disposer, opts) {
    this.host = host;
    this.d = disposer;
    this.onChange = (opts && opts.onChange) || (() => {});
    this.canZoom = (opts && opts.canZoom) || (() => true);
    this.state = new Map();     // element -> { s, cx, cy }
    this.drag = null;
    this.dragged = false;       // a pan just ended (the click that follows is not a play toggle)
    this.map = el('div.zmap', { hidden: true, 'aria-hidden': 'true' }, el('i'));
    this.mapFor = null;
    host.append(this.map);
    this.bind();
    // Sizes change with the layout, the divider and the window: keep the view in place.
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this.refresh());
      ro.observe(host);
      this.d.add(() => ro.disconnect());
    }
  }

  // The zoomable element at an event's target (a video or the PDF stage).
  targetOf(elem) {
    if (!elem || !elem.closest) return null;
    const stage = elem.tagName === 'VIDEO' ? null : elem.closest('.pstage');
    const t = elem.tagName === 'VIDEO' ? elem : stage && stage.querySelector('.rpages');
    return t && this.host.contains(t) && this.canZoom(t) ? t : null;
  }

  get(elem) { return this.state.get(elem) || { s: 1, cx: 0.5, cy: 0.5 }; }

  zoomed(elem) { return this.get(elem).s > 1.001; }

  // Zooms `el` by `factor` keeping the point at (fx, fy) (fractions of the element) still.
  zoomAt(elem, factor, fx, fy) {
    const z = this.get(elem);
    const s = clamp(z.s * factor, 1, ZOOM_MAX);
    // The content point under the pointer before, and where it must stay.
    const px = z.cx + (fx - 0.5) / z.s;
    const py = z.cy + (fy - 0.5) / z.s;
    this.set(elem, s, px - (fx - 0.5) / s, py - (fy - 0.5) / s);
  }

  set(elem, s, cx, cy) {
    const half = 0.5 / s;
    const z = { s, cx: clamp(cx, half, 1 - half), cy: clamp(cy, half, 1 - half) };
    if (s <= 1.001) this.state.delete(elem); else this.state.set(elem, z);
    this.apply(elem);
    this.onChange();
  }

  reset(elem) { if (this.state.has(elem)) this.set(elem, 1, 0.5, 0.5); }

  resetAll() { for (const elem of [...this.state.keys()]) this.reset(elem); }

  apply(elem) {
    const z = this.get(elem);
    if (z.s <= 1.001) {
      elem.style.transform = '';
      elem.style.clipPath = '';
      elem.style.transformOrigin = '';
      elem.classList.remove('zoomed');
    } else {
      const W = elem.offsetWidth;
      const H = elem.offsetHeight;
      const tx = W / 2 - z.s * z.cx * W;
      const ty = H / 2 - z.s * z.cy * H;
      elem.style.transformOrigin = '0 0';
      elem.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + z.s.toFixed(4) + ')';
      // The clip is in the element's own (unscaled) coordinates: the visible part only.
      const l = -tx / z.s;
      const tp = -ty / z.s;
      elem.style.clipPath = 'inset(' + tp.toFixed(1) + 'px ' + (W - l - W / z.s).toFixed(1) + 'px ' + (H - tp - H / z.s).toFixed(1) + 'px ' + l.toFixed(1) + 'px)';
      elem.classList.add('zoomed');
    }
    this.renderMap(elem);
  }

  // Re-applies after the element was resized (layout change, divider, window).
  refresh() { for (const elem of this.state.keys()) this.apply(elem); }

  renderMap(elem) {
    const m = this.map;
    if (!this.zoomed(elem)) {
      if (this.mapFor === elem) { m.hidden = true; this.mapFor = null; }
      return;
    }
    this.mapFor = elem;
    const z = this.get(elem);
    const W = elem.offsetWidth;
    const H = elem.offsetHeight;
    // Where the view is inside the host, without the zoom transform (a video is placed in
    // the host directly; the PDF pages inside an untransformed stage).
    let x = elem.offsetLeft;
    let y = elem.offsetTop;
    if (elem.tagName !== 'VIDEO') {
      const r = elem.parentElement.getBoundingClientRect();
      const hr = this.host.getBoundingClientRect();
      x = r.left - hr.left;
      y = r.top - hr.top;
    }
    const mw = Math.min(140, W * 0.25);
    const mh = (mw * H) / W;
    m.hidden = false;
    m.style.width = mw + 'px';
    m.style.height = mh + 'px';
    // Bottom right of the view, clear of the title bar, toolbars and the controls.
    m.style.left = (x + W - mw - 12) + 'px';
    m.style.top = Math.max(y + 64, y + H - mh - 96) + 'px';
    const r = m.firstChild;
    r.style.left = ((z.cx - 0.5 / z.s) * 100).toFixed(2) + '%';
    r.style.top = ((z.cy - 0.5 / z.s) * 100).toFixed(2) + '%';
    r.style.width = (100 / z.s).toFixed(2) + '%';
    r.style.height = (100 / z.s).toFixed(2) + '%';
  }

  bind() {
    const d = this.d;
    d.listen(this.host, 'wheel', (e) => {
      const elem = this.targetOf(e.target);
      if (!elem) return;
      e.preventDefault();
      const r = elem.getBoundingClientRect();
      // Pixel deltas from trackpads, line deltas from some mice.
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // The rect spans the whole scaled content: the pointer's position in the content,
      // then in the visible window.
      const z = this.get(elem);
      const wx = 0.5 + ((e.clientX - r.left) / r.width - z.cx) * z.s;
      const wy = 0.5 + ((e.clientY - r.top) / r.height - z.cy) * z.s;
      this.zoomAt(elem, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), clamp(wx, 0, 1), clamp(wy, 0, 1));
    }, { passive: false });
    d.listen(this.host, 'pointerdown', (e) => {
      const elem = this.targetOf(e.target);
      if (!elem || e.button !== 0 || !this.zoomed(elem)) return;
      this.drag = { el: elem, x: e.clientX, y: e.clientY, z: this.get(elem), id: e.pointerId };
      this.dragged = false;
    });
    d.listen(this.host, 'pointermove', (e) => {
      const g = this.drag;
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!this.dragged && Math.hypot(dx, dy) < 4) return;
      if (!this.dragged) {
        this.dragged = true;
        g.el.classList.add('panning');
        // Captured once it is a drag (a plain click must still reach the picture), so the
        // drag works wherever the player is, also in a floating window.
        try { this.host.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      const W = g.el.offsetWidth;
      const H = g.el.offsetHeight;
      this.set(g.el, g.z.s, g.z.cx - dx / (W * g.z.s), g.z.cy - dy / (H * g.z.s));
    });
    const end = () => {
      if (!this.drag) return;
      this.drag.el.classList.remove('panning');
      this.drag = null;
      // The click event comes right after; it reads `dragged` and then it is cleared.
      setTimeout(() => { this.dragged = false; }, 0);
    };
    d.listen(this.host, 'pointerup', end);
    d.listen(this.host, 'pointercancel', end);
  }
}

// ---- 51-loop.js ----
// ===================================================================================
// A-B loop: play a stretch of the lecture again and again (a derivation, a sentence).
//
// Set the ends with I and O (or right-click the progress bar: "Loop from here" / "Loop to
// here"); X or the band's ✕ ends it. The band on the progress bar shows the stretch and
// its ends can be dragged. Playback jumps back to A when it reaches B from inside the
// stretch; after a jump outside, a notice offers to end the loop (otherwise it loops again
// once playback is back inside).
// ===================================================================================

const LOOP_MIN_SEC = 1;

class ABLoop {
  constructor(player, disposer) {
    this.p = player;
    this.a = null;
    this.b = null;
    this.last = -1;          // time at the previous check
    this.timer = 0;
    this.d = disposer;
    this.d.add(() => clearTimeout(this.timer));
    this.build();
  }

  get active() { return this.a != null && this.b != null; }

  build() {
    const seek = this.p.$('.seek');
    this.band = el('div.loopband', { hidden: true },
      el('i.lh.la', { title: tr('loopStart') }), el('i.lh.lb', { title: tr('loopEnd') }),
      el('button.lx', { title: tr('loopClear') + ' (X)', 'aria-label': tr('loopClear'), text: '✕' }));
    seek.append(this.band);
    this.menu = el('div.menu.loopmenu', { hidden: true, role: 'menu' },
      el('button', { 'data-loop': 'a', text: tr('loopFromHere') }),
      el('button', { 'data-loop': 'b', text: tr('loopToHere') }),
      el('button', { 'data-loop': 'x', text: tr('loopClear') }));
    const host = this.p.$('.speedmenu').parentElement;  // where the other menus live
    host.append(this.menu);
    const d = this.d;
    d.listen(this.band.querySelector('.lx'), 'pointerdown', (e) => e.stopPropagation());
    d.listen(this.band.querySelector('.lx'), 'click', (e) => { e.stopPropagation(); this.clear(); });
    for (const hd of this.band.querySelectorAll('.lh')) this.bindHandle(hd);
    let at = 0;
    d.listen(seek, 'contextmenu', (e) => {
      e.preventDefault();
      const r = seek.getBoundingClientRect();
      at = clamp((e.clientX - r.left) / r.width, 0, 1) * this.p.duration();
      const cr = host.getBoundingClientRect();
      this.menu.style.left = clamp(e.clientX - cr.left - 60, 8, cr.width - 200) + 'px';
      this.menu.style.right = 'auto';
      this.menu.querySelector('[data-loop=x]').hidden = !this.active && this.a == null;
      this.menu.hidden = false;
    });
    d.listen(this.menu, 'click', (e) => {
      const b = e.target.closest('[data-loop]');
      if (!b) return;
      e.stopPropagation();
      this.menu.hidden = true;
      if (b.dataset.loop === 'a') this.setA(at);
      else if (b.dataset.loop === 'b') this.setB(at);
      else this.clear();
    });
  }

  // Dragging an end of the band.
  bindHandle(hd) {
    const seek = this.p.$('.seek');
    const isA = hd.classList.contains('la');
    let drag = false;
    this.d.listen(hd, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      hd.setPointerCapture(e.pointerId);
      drag = true;
    });
    this.d.listen(hd, 'pointermove', (e) => {
      if (!drag) return;
      const r = seek.getBoundingClientRect();
      const tm = clamp((e.clientX - r.left) / r.width, 0, 1) * this.p.duration();
      if (isA) this.a = Math.min(tm, this.b - LOOP_MIN_SEC); else this.b = Math.max(tm, this.a + LOOP_MIN_SEC);
      this.render();
    });
    const end = (e) => {
      if (!drag) return;
      drag = false;
      e.stopPropagation();
      this.announce();
    };
    this.d.listen(hd, 'pointerup', end);
    this.d.listen(hd, 'pointercancel', end);
  }

  setA(tm) {
    this.a = clamp(tm, 0, this.p.duration());
    if (this.b != null && this.b - this.a < LOOP_MIN_SEC) this.b = null;
    this.render();
    if (this.active) this.announce(); else this.p.toast(tr('loopStartSet', { time: fmtTime(this.a) }));
  }

  setB(tm) {
    const b = clamp(tm, 0, this.p.duration());
    // Without a start, loop from a little before.
    if (this.a == null || b - this.a < LOOP_MIN_SEC) this.a = Math.max(0, b - 10);
    this.b = b;
    this.render();
    this.announce();
    const v = this.p.video;
    if (v.currentTime < this.a || v.currentTime >= this.b) this.p.seek(this.a);
  }

  clear() {
    if (this.a == null && this.b == null) return;
    this.a = null;
    this.b = null;
    clearTimeout(this.timer);
    this.render();
    this.p.toast(tr('loopCleared'));
  }

  announce() {
    this.p.toast(tr('loopSet', { from: fmtTime(this.a), to: fmtTime(this.b) }), tr('loopClear'), () => this.clear());
  }

  render() {
    const dur = this.p.duration();
    const band = this.band;
    if (this.a == null || !dur) { band.hidden = true; return; }
    const b = this.b == null ? this.a : this.b;
    band.hidden = false;
    band.classList.toggle('open', this.b == null);
    band.style.left = ((this.a / dur) * 100).toFixed(3) + '%';
    band.style.width = (((b - this.a) / dur) * 100).toFixed(3) + '%';
  }

  // Called on every time update: back to A when playback reaches B from inside.
  tick(tm) {
    const last = this.last;
    this.last = tm;
    if (!this.active) return;
    const v = this.p.video;
    if (v.seeking || v.paused) return;
    if (last >= this.a - 0.5 && last < this.b && tm >= this.b - 0.05) {
      this.p.seek(this.a);
      this.last = this.a;
      return;
    }
    // Time updates come about four times a second: aim the jump closer to B.
    const left = (this.b - tm) / (v.playbackRate || 1);
    clearTimeout(this.timer);
    if (tm >= this.a && left > 0 && left < 0.4) {
      this.timer = setTimeout(guard(() => { if (this.active && !v.paused && !v.seeking) this.tick(v.currentTime); }), left * 1000);
    }
  }

  // A seek by the user: outside the loop, offer to end it.
  seeked(target) {
    if (!this.active || (target >= this.a - 0.5 && target < this.b)) return;
    this.last = target;
    this.p.toast(tr('loopOutside', { from: fmtTime(this.a), to: fmtTime(this.b) }), tr('loopClear'), () => this.clear());
  }
}

// ---- 52-watched.js ----
// ===================================================================================
// What has been watched: the stretches of a recording played on this device, kept across
// visits, shown faintly on the progress bar and as a percentage on the course page
// (80-course-list.js).
//
// Echo360 keeps no per-user record of which parts were watched that a page can read: the
// course list only says whether a recording was opened (isRead), and the player only gets
// the last position (lastPlayedToSeconds). So coverage is local; the course page falls
// back to Echo360's last position where this device has no record.
//
//   watched:<lessonId>   { d: duration (s), r: [[start, end], ...] (s), at: last update }
// ===================================================================================

const WATCHED_MIN_SEC = 2;     // shorter stretches (a seek landing, a frame) do not count

class WatchedStore {
  constructor(lesson, video, played) {
    this.key = lesson.lessonId ? 'watched:' + lesson.lessonId : null;
    this.video = video;
    this.played = played;
    this.base = [];            // stored before this visit
    this.ready = false;
    this.contentEnd = null;    // where the lecture's content ends (an empty stretch follows), if known
  }

  async load() {
    if (!this.key) return;
    const rec = await idbCache.get(this.key);
    if (rec && Array.isArray(rec.r)) this.base = rec.r;
    this.ready = true;
  }

  // Everything watched so far: earlier visits and this one.
  ranges() {
    const all = new PlayedRanges();
    all.ranges = this.base.slice();
    for (const [a, b] of this.played.merged(this.video.played)) if (b - a >= WATCHED_MIN_SEC) all.add(a, b);
    return all.ranges;
  }

  // Merged with what is stored now, in one transaction: the same lecture open in another
  // tab may have saved its own stretches since this page loaded.
  save(duration) {
    if (!this.key || !this.ready || !(duration > 0) || storageLock.frozen) return;
    const mine = this.ranges();
    if (!mine.length) return;
    idbCache.update(this.key, (old) => {
      const all = new PlayedRanges();
      if (old && Array.isArray(old.r)) for (const [a, b] of old.r) if (b > a) all.add(a, b);
      for (const [a, b] of mine) all.add(a, b);
      const rec = { d: Math.round(duration), r: all.ranges.map(([a, b]) => [Math.floor(a), Math.ceil(b)]), at: Date.now() };
      if (this.contentEnd > 0) rec.e = Math.round(this.contentEnd); else if (old && old.e > 0) rec.e = old.e;
      return rec;
    }).then((rec) => { if (rec) this.base = rec.r; }).catch((e) => log.warn('watched record:', e));
  }
}

// Share of a recording watched (0..1) from a stored record. Only the lecture's content
// counts: an empty stretch at the end (rec.e, black screen and silence) is left out, so
// watching all of the content is 100%.
function watchedShare(rec) {
  if (!rec || !(rec.d > 0) || !Array.isArray(rec.r)) return 0;
  const end = rec.e > 0 && rec.e < rec.d ? rec.e : rec.d;
  let s = 0;
  for (const [a, b] of rec.r) s += Math.max(0, Math.min(b, end) - Math.max(a, 0));
  return Math.min(1, s / end);
}

// ---- 53-captions.js ----
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
  constructor(elem, video) {
    this.el = elem;
    this.video = video;
    this.textEl = elem.firstElementChild;
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
  constructor(player, elem, marksEl) {
    this.player = player;
    this.el = elem;
    this.visible = false;
    this.marksEl = marksEl;
    this.list = elem.querySelector('.tlist');
    this.search = elem.querySelector('.tsearch');
    this.countEl = elem.querySelector('.tcount');
    this.backBtn = elem.querySelector('.tback');
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
    this.countEl.textContent = q ? tr('searchCount', { n: this.hits.length }) : '';
    this.renderMarks();
  }

  stepHit(dir) {
    if (!this.hits.length) return;
    this.hitPos = (this.hitPos + dir + this.hits.length) % this.hits.length;
    const k = this.hits[this.hitPos];
    this.countEl.textContent = tr('searchPos', { i: this.hitPos + 1, n: this.hits.length });
    this.stopFollowing();
    this.scrollTo(k);
  }

  // Search hits on the progress bar, merged into 0.25% buckets (at most 400 marks).
  renderMarks() {
    const elem = this.marksEl;
    elem.textContent = '';
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
    elem.appendChild(frag);
  }

  dispose() {
    this.d.dispose();
  }
}

// ---- 54-sidebar.js ----
// ===================================================================================
// Side panel with tabs (transcript, slides, notes, discussion). Each tab is a controller with
// show(visible); only the active tab of an open panel is visible, so hidden tabs do no work.
// ===================================================================================

// Small DOM helper: h('button.btn.primary', { title: 'x', onclick }, 'text', child, ...)
function el(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const elem = document.createElement(tag || 'div');
  if (classes.length) elem.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') elem.addEventListener(k.slice(2), guard(v));
      else if (k === 'text') elem.textContent = v;
      else if (k in elem && typeof v !== 'string') elem[k] = v;
      else elem.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c != null && c !== false) elem.append(c);
  return elem;
}

const SIDEBAR_TABS = ['transcript', 'slides', 'notes', 'discussion'];

class Sidebar {
  constructor(player, elem) {
    this.p = player;
    this.el = elem;
    this.controllers = {};
    this.active = null;
    this.isOpen = false;
    this.d = new Disposer();
    for (const b of elem.querySelectorAll('.tabs [data-tab]')) {
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

// ---- 55-notes.js ----
// ===================================================================================
// Notes tab: private notes, bookmarks and "didn't understand" flags, sorted by time.
// Data is loaded once at start (it also feeds the progress-bar markers); the list DOM is
// only rebuilt while the tab is visible. Notes and bookmarks can carry local tags
// (56-tags.js).
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
    this.tagFilter = '';      // '' all, a tag id, or '-' untagged
    this.tags = player.tags;
    this.picking = null;      // item id whose tag picker is open
    this.managing = false;
    this.visible = false;
    this.dirty = true;
    this.d = new Disposer();
    this.build();
  }

  // Resolves true when notes are available for this recording.
  async load() {
    const [notes, flags] = await Promise.allSettled([this.api.notes(), this.canFlag ? this.api.flags() : Promise.resolve([])]);
    if (notes.status !== 'fulfilled') {
      log.info('notes unavailable:', notes.reason && notes.reason.message);
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
    const timeLabel = el('span');
    this.composerTime = timeLabel;
    this.textarea = el('textarea.input', { rows: 3, maxLength: 5000, 'aria-label': tr('addNote') });
    this.addBtn = el('button.pbtn.primary', { text: tr('addNote'), onclick: (e) => this.addNote(e) });
    this.d.listen(this.textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.addNote(e); }
    });
    this.d.listen(this.textarea, 'focus', () => this.updatePlaceholder());
    this.select = el('select.input.small', { 'aria-label': tr('filterAll') });
    for (const f of NOTE_FILTERS) {
      const label = { all: tr('filterAll'), note: tr('filterNotes'), bookmark: tr('filterBookmarks'), flag: tr('filterFlags') }[f];
      if (f === 'flag' && !this.canFlag) continue;
      this.select.append(el('option', { value: f, text: label }));
    }
    this.d.listen(this.select, 'change', () => { this.filter = this.select.value; this.render(); });
    this.tagSelect = el('select.input.small', { 'aria-label': tr('filterTags') });
    this.d.listen(this.tagSelect, 'change', () => { this.tagFilter = this.tagSelect.value; this.render(); });
    this.manageBtn = el('button.link', { text: tr('manageTags'), onclick: () => { this.managing = !this.managing; this.exporting = false; this.render(); } });
    this.exportBtn = el('button.link', { text: tr('exportMenu'), onclick: () => { this.exporting = !this.exporting; this.managing = false; this.render(); } });
    this.manageBox = el('div');
    this.errorEl = el('div.perror', { hidden: true });
    this.list = el('div.plist');
    this.pane.append(
      el('div.pinfo', { text: tr('notesPrivate') }),
      el('div.composer', null, this.textarea, el('div.crow', null, timeLabel, el('span.grow'), this.addBtn)),
      el('div.ptools', null, this.select, this.tagSelect, el('span.grow'), this.manageBtn, this.exportBtn),
      this.manageBox,
      this.errorEl,
      this.list,
    );
  }

  updatePlaceholder() {
    const at = fmtTime(this.p.video.currentTime, this.p.duration() >= 3600);
    this.textarea.placeholder = tr('addNotePlaceholder', { time: at });
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
    log.warn('write failed', e);
    this.showError(tr('saveFailed', { error: e.message || e }));
    this.p.toast(tr('saveFailed', { error: e.message || e }));
  }

  renderTagFilter() {
    const sel = this.tagSelect;
    const keep = this.tagFilter;
    sel.textContent = '';
    sel.append(el('option', { value: '', text: tr('allTags') }));
    for (const tag of this.tags.tags) sel.append(el('option', { value: tag.id, text: tag.name }));
    sel.append(el('option', { value: '-', text: tr('untagged') }));
    this.tagFilter = keep && (keep === '-' || this.tags.byId(keep)) ? keep : '';
    sel.value = this.tagFilter;
  }

  tagMatch(item) {
    if (!this.tagFilter) return true;
    if (item.type === 'flag') return false;
    const ids = this.tags.of(item.id);
    return this.tagFilter === '-' ? !ids.length : ids.some((x) => x.id === this.tagFilter);
  }

  render() {
    this.dirty = false;
    const long = this.p.duration() >= 3600;
    this.renderTagFilter();
    this.manageBox.textContent = '';
    if (this.managing) this.manageBox.append(tagManager(this.tags, () => { this.managing = false; this.render(); }));
    if (this.exporting) this.manageBox.append(this.exportPanel());
    const shown = this.items.filter((x) => (this.filter === 'all' || x.type === this.filter) && this.tagMatch(x));
    const frag = document.createDocumentFragment();
    if (!shown.length) frag.append(el('div.pempty', { text: tr('noNotes') }));
    for (const item of shown) frag.append(this.renderItem(item, long));
    this.list.textContent = '';
    this.list.append(frag);
  }

  renderItem(item, long) {
    const label = { note: tr('markerNote'), bookmark: tr('markerBookmark'), flag: tr('markerFlag') }[item.type];
    const time = item.time != null
      ? el('button.chiptime', { text: fmtTime(item.time, long), title: label, onclick: () => this.p.seek(item.time) })
      : null;
    const head = el('div.ihead', null, el('span.kind.k-' + item.type, { text: label }), time, el('span.grow'));
    const body = item.type === 'note' ? el('div.ibody', { text: item.text }) : null;
    let tags = null;
    if (item.type !== 'flag') {
      const open = () => { this.picking = this.picking === item.id ? null : item.id; this.render(); };
      tags = el('div.itags', null, ...this.tags.of(item.id).map((tag) => tagChip(tag, open)),
        el('button.link.addtag', { text: tr('addTagShort'), title: tr('tagsFor'), onclick: open }));
      if (this.picking === item.id) tags.append(tagPicker(this.tags, item.id, () => { this.picking = null; this.render(); }));
    }
    const actions = el('div.iactions');
    if (item.type === 'note') actions.append(el('button.link', { text: tr('edit'), onclick: () => this.startEdit(item, card) }));
    actions.append(this.deleteButton(item));
    const card = el('div.card.k-' + item.type, { 'data-id': item.id }, head, body, tags, actions);
    return card;
  }

  // Two clicks within 3 s delete; the second click is the user action sent with the write.
  deleteButton(item) {
    const label = item.type === 'flag' ? tr('remove') : tr('delete');
    let armed = 0;
    const b = el('button.link.danger', { text: label });
    b.addEventListener('click', guard((e) => {
      if (!armed) {
        b.textContent = tr('confirmDelete');
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
    const area = el('textarea.input', { rows: 3, maxLength: 5000 });
    area.value = item.text;
    const save = el('button.pbtn.primary', { text: tr('save') });
    const cancel = el('button.pbtn', { text: tr('cancel'), onclick: () => this.render() });
    save.addEventListener('click', guard((e) => this.once(async () => {
      const text = area.value.trim();
      if (!text) return;
      save.disabled = true;
      try {
        await this.api.updateNote(e, item, text);
        item.text = text;
        this.showError('');
        this.changed();
      } catch (err) { save.disabled = false; this.fail(err); }
    })));
    card.querySelector('.ibody').replaceWith(el('div.composer', null, area, el('div.crow', null, el('span.grow'), cancel, save)));
    card.querySelector('.iactions').hidden = true;
    area.focus();
  }

  // One write at a time for the whole tab (see DiscussionPane.write): a second Ctrl+Enter
  // or click while a request is on its way does nothing.
  async once(fn) {
    if (this.busy) return undefined;
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  addNote(e) {
    return this.once(() => this.addNoteNow(e));
  }

  async addNoteNow(e) {
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

  // Resolves to the new bookmark, or null if it could not be added (or another write was
  // still on its way).
  addBookmark(e) {
    return this.once(async () => {
      const time = this.p.video.currentTime;
      try {
        const note = await this.api.addNote(e, { bookmark: true, time, num: this.count('bookmark') + 1 });
        this.items.push(note);
        this.sort();
        this.changed();
        this.p.toast(tr('bookmarkedAt', { time: fmtTime(time) }), tr('undo'), (ev) => this.remove(ev, note));
        return note;
      } catch (err) { this.fail(err); return null; }
    }).then((x) => x || null);
  }

  flagAt(time) {
    const scene = Math.floor(time / FLAG_SCENE_SECONDS) * FLAG_SCENE_SECONDS;
    return this.items.find((x) => x.type === 'flag' && x.time === scene) || null;
  }

  toggleFlag(e) {
    return this.once(() => this.toggleFlagNow(e));
  }

  async toggleFlagNow(e) {
    if (!this.canFlag) return;
    const time = this.p.video.currentTime;
    const existing = this.flagAt(time);
    try {
      if (existing) {
        await this.api.removeFlag(e, existing);
        this.items = this.items.filter((x) => x !== existing);
        this.p.toast(tr('flagRemoved', { time: fmtTime(existing.time) }));
      } else {
        await this.api.addFlag(e, time);
        const scene = Math.floor(time / FLAG_SCENE_SECONDS) * FLAG_SCENE_SECONDS;
        this.items.push({ id: 'flag-' + scene / FLAG_SCENE_SECONDS, type: 'flag', time: scene, createdAt: new Date().toISOString() });
        this.sort();
        this.p.toast(tr('flagAdded', { time: fmtTime(scene) }));
      }
      this.changed();
      this.p.renderFlagButton();
    } catch (err) { this.fail(err); }
  }

  remove(e, item) {
    return this.once(() => this.removeNow(e, item));
  }

  async removeNow(e, item) {
    try {
      if (item.type === 'flag') await this.api.removeFlag(e, item);
      else await this.api.deleteNote(e, item);
      this.items = this.items.filter((x) => x !== item);
      this.tags.forget(item.id);
      this.showError('');
      this.changed();
      this.p.renderFlagButton();
    } catch (err) { this.fail(err); }
  }

  markers() {
    return this.items.filter((x) => x.time != null).map((x) => {
      const tags = x.type === 'flag' ? [] : this.tags.of(x.id);
      const base = x.type === 'note' ? tr('markerNote') + ': ' + x.text : x.type === 'bookmark' ? tr('markerBookmark') : tr('markerFlag');
      return {
        time: x.time,
        kind: x.type,
        color: tags.length ? tags[0].color : null,
        label: tags.length ? base + ' [' + tags.map((g) => g.name).join(', ') + ']' : base,
      };
    });
  }

  openExport() {
    this.exporting = true;
    this.managing = false;
    this.p.sidebar.open('notes');
    this.render();
  }

  // Export (Markdown, zip) and backup / restore of what only lives in this browser.
  exportPanel() {
    const ex = new Exporter(this.p);
    const hasPdf = !!(this.p.deck && this.p.deck.pages.length);
    const pics = el('input', { type: 'checkbox', checked: hasPdf, disabled: !hasPdf });
    const pdfs = el('input', { type: 'checkbox' });
    const busy = async (btn, fn) => {
      btn.disabled = true;
      try { await fn(); } catch (e) { this.p.toast(tr('exportFailed', { msg: (e && e.message) || e })); } finally { btn.disabled = false; }
    };
    const one = el('button.pbtn.primary', { text: tr('exportLecture') });
    one.addEventListener('click', guard(() => busy(one, async () => {
      const r = await ex.lecture(pics.checked);
      this.p.toast(tr('exportedLecture', { n: r.notes, p: r.pictures }));
    })));
    const all = el('button.pbtn', { text: tr('exportCourse') });
    all.addEventListener('click', guard(() => busy(all, async () => {
      const n = await ex.course((k, total) => { all.textContent = tr('exportCourseProgress', { k: k + 1, n: total }); });
      all.textContent = tr('exportCourse');
      this.p.toast(n ? tr('exportedCourse', { n }) : tr('exportedNothing'));
    })));
    const backup = el('button.pbtn', { text: tr('backupMake') });
    backup.addEventListener('click', guard(() => busy(backup, async () => {
      const data = await makeBackup(pdfs.checked);
      const name = 'echo360-lite-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), name);
      this.p.toast(tr('backupMade', { n: Object.keys(data.db).length }));
    })));
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    file.addEventListener('change', guard(async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const n = await restoreBackup(JSON.parse(await f.text()));
        // From now on this page must not write its older data over the restored one (its
        // settings on leaving, the watched record): stop all writes and reload at once.
        storageLock.frozen = true;
        this.p.toast(tr('backupRestored', { n }));
        setTimeout(() => location.reload(), 1200);
      } catch (e) { this.p.toast(tr('exportFailed', { msg: (e && e.message) || e })); }
      file.value = '';
    }));
    const restore = el('button.pbtn', { text: tr('backupRestore'), onclick: () => file.click() });
    return el('div.tagman', null,
      el('div.pinfo', { text: tr('exportInfo') }),
      el('label.crow', null, pics, el('span', { text: hasPdf ? tr('exportPictures') : tr('exportPicturesNoPdf') })),
      el('div.crow', null, one, all),
      el('div.pinfo', { text: tr('backupInfo') }),
      el('label.crow', null, pdfs, el('span', { text: tr('backupPdfs') })),
      el('div.crow', null, backup, restore, file),
      el('div.crow', null, el('span.grow'), el('button.link', { text: tr('done'), onclick: () => { this.exporting = false; this.render(); } })));
  }

  // `G`: tags the note or bookmark at the current time (within the last 30 s, or just
  // ahead), or bookmarks this moment first; opens its tag picker.
  async tagHere(e) {
    const now = this.p.video.currentTime;
    let item = null;
    for (const x of this.items) if (x.type !== 'flag' && x.time != null && x.time <= now + 5 && x.time >= now - 30 && (!item || Math.abs(x.time - now) < Math.abs(item.time - now))) item = x;
    if (!item) {
      // The bookmark just made, and only that one: if adding it failed, nothing is tagged.
      item = await this.addBookmark(e);
      if (!item) return;
    }
    this.filter = 'all';
    this.select.value = 'all';
    this.tagFilter = '';
    this.picking = item.id;
    this.p.sidebar.open('notes');
    this.render();
    // (The page replaces the global CSS object, so no CSS.escape here.)
    const card = [...this.list.querySelectorAll('.card')].find((c) => c.dataset.id === String(item.id));
    if (card) { card.scrollIntoView({ block: 'nearest' }); const b = card.querySelector('.tagopt'); if (b) b.focus(); }
  }

  dispose() {
    this.d.dispose();
  }
}

// ---- 56-tags.js ----
// ===================================================================================
// Private tags on notes and bookmarks. Local only: they are kept in IndexedDB and never
// sent to Echo360, so only the user sees them (and they go with a backup, M8.6).
//
// The tag list belongs to the course (Echo360 section), so every recording of the course
// offers the same tags; which tags an item has is kept per recording.
//   tags:<section>      { tags: [{ id, name, color }] }   (a few defaults the first time)
//   tagmap:<mediaId>    { <note or bookmark id>: [tag id, ...] }
// ===================================================================================

const TAG_COLORS = ['#f6c343', '#6ea8ff', '#ff6b6b', '#4fd1a5', '#c084fc', '#fb923c', '#94a3b8', '#f472b6'];

class TagStore {
  constructor(lesson, onChange) {
    this.courseKey = 'tags:' + (lesson.sectionId || 'all');
    this.mapKey = lesson.mediaId ? 'tagmap:' + lesson.mediaId : null;
    this.onChange = onChange || (() => {});
    this.tags = [];
    this.map = {};
    this.ready = false;
  }

  async load() {
    const rec = await idbCache.get(this.courseKey);
    if (rec && Array.isArray(rec.tags)) {
      this.tags = rec.tags;
    } else {
      // First use in this course: a few suggestions, which the user may delete.
      this.tags = [
        { id: 'exam', name: tr('tagExam'), color: TAG_COLORS[0] },
        { id: 'assignment', name: tr('tagAssignment'), color: TAG_COLORS[1] },
        { id: 'confused', name: tr('tagConfused'), color: TAG_COLORS[2] },
      ];
      this.saveTags();
    }
    const m = this.mapKey ? await idbCache.get(this.mapKey) : null;
    this.map = m && typeof m === 'object' ? m : {};
    this.ready = true;
    this.onChange();
  }

  saveTags() { idbCache.put(this.courseKey, { tags: this.tags }); }

  saveMap() { if (this.mapKey) idbCache.put(this.mapKey, this.map); }

  byId(id) { return this.tags.find((x) => x.id === id) || null; }

  // Tags of an item, in the order of the tag list (unknown ids, from tags deleted while
  // another recording was open, are skipped).
  of(itemId) {
    const ids = this.map[itemId] || [];
    return this.tags.filter((x) => ids.includes(x.id));
  }

  has(itemId, tagId) { return (this.map[itemId] || []).includes(tagId); }

  toggle(itemId, tagId) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const ids = (this.map[itemId] || []).filter((x) => this.byId(x));
    const i = ids.indexOf(tagId);
    if (i >= 0) ids.splice(i, 1); else ids.push(tagId);
    if (ids.length) this.map[itemId] = ids; else delete this.map[itemId];
    this.saveMap();
    this.onChange();
  }

  // Forgets an item's tags (the item was deleted).
  forget(itemId) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    if (!this.map[itemId]) return;
    delete this.map[itemId];
    this.saveMap();
  }

  create(name, color) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return null;
    const same = this.tags.find((x) => x.name.toLowerCase() === clean.toLowerCase());
    if (same) return same;
    const tag = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: clean, color: color || TAG_COLORS[this.tags.length % TAG_COLORS.length] };
    this.tags.push(tag);
    this.saveTags();
    this.onChange();
    return tag;
  }

  rename(id, name) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const tag = this.byId(id);
    const clean = String(name || '').trim().slice(0, 40);
    if (!tag || !clean || clean === tag.name) return;
    tag.name = clean;
    this.saveTags();
    this.onChange();
  }

  recolor(id, color) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const tag = this.byId(id);
    if (!tag) return;
    tag.color = color;
    this.saveTags();
    this.onChange();
  }

  remove(id) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    this.tags = this.tags.filter((x) => x.id !== id);
    for (const k of Object.keys(this.map)) {
      this.map[k] = this.map[k].filter((x) => x !== id);
      if (!this.map[k].length) delete this.map[k];
    }
    this.saveTags();
    this.saveMap();
    this.onChange();
  }
}

// A tag as a small coloured chip.
function tagChip(tag, onclick) {
  const elem = el(onclick ? 'button.tagchip' : 'span.tagchip', { onclick: onclick || null, title: tag.name },
    el('i', { style: 'background:' + tag.color }), el('span', { text: tag.name }));
  return elem;
}

// The picker for one item: every tag as a toggle, and a field for a new tag.
function tagPicker(tagStore, itemId, onDone) {
  const box = el('div.tagpick', { role: 'group', 'aria-label': tr('tagsFor') });
  const render = () => {
    box.textContent = '';
    for (const tag of tagStore.tags) {
      const on = tagStore.has(itemId, tag.id);
      box.append(el('button.tagopt' + (on ? '.on' : ''), { 'aria-pressed': String(on), onclick: () => { tagStore.toggle(itemId, tag.id); render(); } },
        el('i', { style: 'background:' + tag.color }), el('span', { text: tag.name })));
    }
    const input = el('input.input.small', { placeholder: tr('newTag'), maxLength: 40, 'aria-label': tr('newTag') });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) {
        const tag = tagStore.create(input.value);
        if (tag && !tagStore.has(itemId, tag.id)) tagStore.toggle(itemId, tag.id);
        render();
        box.querySelector('input').focus();
      } else if (e.key === 'Escape') onDone();
    });
    box.append(el('div.tagnew', null, input, el('button.link', { text: tr('done'), onclick: onDone })));
  };
  render();
  return box;
}

// Managing the course's tags: rename, colour, delete (two clicks), add.
function tagManager(tagStore, onClose) {
  const box = el('div.tagman');
  const render = () => {
    box.textContent = '';
    box.append(el('div.pinfo', { text: tr('tagsPrivate') }));
    for (const tag of tagStore.tags) {
      const swatch = el('button.tagswatch', { title: tr('tagColor'), 'aria-label': tr('tagColor'), style: 'background:' + tag.color });
      swatch.addEventListener('click', () => {
        const i = TAG_COLORS.indexOf(tag.color);
        tagStore.recolor(tag.id, TAG_COLORS[(i + 1) % TAG_COLORS.length]);
        render();
      });
      const name = el('input.input.small', { value: tag.name, maxLength: 40, 'aria-label': tr('tagName') });
      name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
      name.addEventListener('change', () => tagStore.rename(tag.id, name.value));
      let armed = 0;
      const del = el('button.link.danger', { text: tr('delete') });
      del.addEventListener('click', () => {
        if (!armed) { del.textContent = tr('confirmDelete'); armed = setTimeout(() => { armed = 0; del.textContent = tr('delete'); }, 3000); return; }
        clearTimeout(armed);
        tagStore.remove(tag.id);
        render();
      });
      box.append(el('div.tagrow', null, swatch, name, del));
    }
    const input = el('input.input.small', { placeholder: tr('newTag'), maxLength: 40, 'aria-label': tr('newTag') });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && tagStore.create(input.value)) render(); });
    box.append(el('div.tagrow', null, input, el('button.pbtn', { text: tr('addTag'), onclick: () => { if (tagStore.create(input.value)) render(); } })),
      el('div.crow', null, el('span.grow'), el('button.link', { text: tr('done'), onclick: onClose })));
  };
  render();
  return box;
}

// ---- 57-discussion.js ----
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
  // Loads can overlap (after a write, on opening the tab, "Refresh"): only the newest one's
  // answer is used, so an older answer arriving late cannot hide a post just made.
  async load() {
    const seq = (this.loadSeq = (this.loadSeq || 0) + 1);
    try {
      const data = await this.api.discussions();
      if (seq !== this.loadSeq) return true;
      this.threads = data.threads;
      this.hiddenCount = data.hiddenCount;
      this.loadedAt = Date.now();
      this.showError('');
      this.changed();
      return true;
    } catch (e) {
      if (seq !== this.loadSeq) return false;
      log.info('discussions unavailable:', e.message);
      if (this.loadedAt) this.showError(tr('loadFailed', { error: e.message }));
      return false;
    }
  }

  changed() {
    this.dirty = true;
    if (this.visible) this.render();
    this.p.updateMarkers();
  }

  build() {
    this.textarea = el('textarea.input', { rows: 3, maxLength: MAX_POST_LENGTH + 500, placeholder: tr('postPlaceholder'), 'aria-label': tr('postPlaceholder') });
    this.counter = el('span.counter');
    this.linkTime = el('input', { type: 'checkbox', checked: true });
    this.linkLabel = el('span');
    this.anon = el('input', { type: 'checkbox' });
    this.postBtn = el('button.pbtn.primary', { text: tr('postPublic'), onclick: (e) => this.post(e) });
    this.d.listen(this.textarea, 'input', () => this.updateCounter(this.textarea, this.counter, this.postBtn));
    this.d.listen(this.textarea, 'focus', () => this.updateLinkLabel());
    this.d.listen(this.textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.post(e); }
    });
    this.sortSel = el('select.input.small', { 'aria-label': tr('sortNewest') },
      el('option', { value: 'newest', text: tr('sortNewest') }), el('option', { value: 'time', text: tr('sortVideoTime') }));
    this.d.listen(this.sortSel, 'change', () => { this.sort = this.sortSel.value; this.render(); });
    this.hiddenEl = el('span.pmuted');
    this.errorEl = el('div.perror', { hidden: true });
    this.list = el('div.plist');
    this.pane.append(
      el('div.composer.public', null,
        el('div.pwarn', { role: 'note', text: tr('publicWarning') }),
        this.textarea,
        el('div.crow', null,
          el('label.check', null, this.linkTime, this.linkLabel),
          el('label.check', null, this.anon, el('span', { text: tr('hideName') })),
          el('span.grow'), this.counter, this.postBtn)),
      el('div.ptools', null, this.sortSel, this.hiddenEl, el('span.grow'),
        el('button.link', { text: tr('refresh'), onclick: () => this.load() })),
      this.errorEl,
      this.list,
    );
    this.updateLinkLabel();
    this.updateCounter(this.textarea, this.counter, this.postBtn);
  }

  updateLinkLabel() {
    this.linkLabel.textContent = tr('linkTime', { time: fmtTime(this.p.video.currentTime, this.p.duration() >= 3600) });
  }

  updateCounter(area, counter, button) {
    const left = MAX_POST_LENGTH - area.value.length;
    counter.textContent = left < 0 ? tr('tooLong', { n: -left }) : left < 500 ? tr('charsLeft', { n: left }) : '';
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
    log.warn('discussion write failed', e);
    this.showError(tr('saveFailed', { error: e.message || e }));
  }

  sorted() {
    const list = this.threads.slice();
    if (this.sort === 'time') list.sort((a, b) => (a.time == null ? Infinity : a.time) - (b.time == null ? Infinity : b.time));
    else list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return list;
  }

  render() {
    this.dirty = false;
    this.hiddenEl.textContent = this.hiddenCount ? tr('hiddenPosts', { n: this.hiddenCount }) : '';
    const long = this.p.duration() >= 3600;
    const frag = document.createDocumentFragment();
    if (!this.threads.length) frag.append(el('div.pempty', { text: tr('noPosts') }));
    for (const q of this.sorted()) frag.append(this.renderThread(q, long));
    this.list.textContent = '';
    this.list.append(frag);
  }

  renderThread(q, long) {
    const card = el('div.card.thread', null, this.renderComment(q, long));
    const n = q.replies.length;
    const footer = el('div.iactions');
    if (n) {
      const open = this.openReplies.has(q.id);
      footer.append(el('button.link', {
        text: open ? tr('hideReplies') : (n === 1 ? tr('oneReply') : tr('replies', { n })),
        onclick: () => { if (open) this.openReplies.delete(q.id); else this.openReplies.add(q.id); this.render(); },
      }));
    }
    footer.append(el('button.link', { text: tr('replyPublic'), onclick: () => { this.replyOpen = q.id; this.openReplies.add(q.id); this.render(); } }));
    card.append(footer);
    if (n && this.openReplies.has(q.id)) {
      const replies = el('div.replies');
      for (const r of q.replies) replies.append(this.renderComment(r, long));
      card.append(replies);
    }
    if (this.replyOpen === q.id) card.append(this.renderReplyComposer(q));
    return card;
  }

  renderComment(c, long) {
    const who = c.mine ? tr('you') + (c.nameHidden ? ' (' + tr('anonymous') + ')' : '') : (c.author || tr('anonymous'));
    const badges = [];
    if (c.instructor) badges.push(el('span.badge.inst', { text: tr('instructor') }));
    if (c.ta) badges.push(el('span.badge.inst', { text: tr('ta') }));
    const time = c.time != null ? el('button.chiptime', { text: fmtTime(c.time, long), onclick: () => this.p.seek(c.time) }) : null;
    const date = el('span.pmuted', { text: formatDate(c.createdAt), title: c.createdAt || '' });
    const actions = el('div.cactions',
      null,
      el('button.link' + (c.liked ? '.on' : ''), {
        text: (c.liked ? tr('unlike') : tr('like')) + (c.likes ? ' · ' + c.likes : ''),
        onclick: (e) => this.write(e, () => this.api.like(e, c, !c.liked)),
      }),
      c.questionId ? null : el('button.link' + (c.saved ? '.on' : ''), {
        text: c.saved ? tr('unsavePost') : tr('savePost'),
        onclick: (e) => this.write(e, () => this.api.save(e, c, !c.saved)),
      }),
      c.mine ? this.deleteButton(c) : null,
      c.hasAttachment ? el('button.link', { text: tr('attachment') + ' → ' + tr('openInOriginal'), onclick: () => this.p.opts.onFallback('attachment') }) : null,
    );
    return el('div.comment' + (c.questionId ? '.reply' : ''), null,
      el('div.ihead', null, el('span.author', { text: who }), ...badges, time, el('span.grow'), date),
      el('div.ibody', { text: c.body }),
      actions);
  }

  deleteButton(c) {
    let armed = 0;
    const b = el('button.link.danger', { text: tr('delete') });
    b.addEventListener('click', guard((e) => {
      if (!armed) {
        b.textContent = tr('confirmDelete');
        armed = setTimeout(() => { armed = 0; b.textContent = tr('delete'); }, 3000);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      this.write(e, () => this.api.deleteComment(e, c));
    }));
    return b;
  }

  renderReplyComposer(q) {
    const area = el('textarea.input', { rows: 2, placeholder: tr('replyPlaceholder'), 'aria-label': tr('replyPlaceholder') });
    const counter = el('span.counter');
    const anon = el('input', { type: 'checkbox' });
    const send = el('button.pbtn.primary', { text: tr('replyPublic') });
    const submit = (e) => {
      const body = area.value.trim();
      if (this.busy || !body || body.length > MAX_POST_LENGTH) return;
      send.disabled = true;
      this.write(e, () => this.api.reply(e, q.id, { body, anonymous: anon.checked }), () => { this.replyOpen = null; });
    };
    area.addEventListener('input', guard(() => this.updateCounter(area, counter, send)));
    area.addEventListener('keydown', guard((e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(e); } }));
    send.addEventListener('click', guard(submit));
    this.updateCounter(area, counter, send);
    setTimeout(() => area.focus(), 0);
    return el('div.composer.public.reply', null,
      el('div.pwarn', { role: 'note', text: tr('publicWarning') }),
      area,
      el('div.crow', null, el('label.check', null, anon, el('span', { text: tr('hideName') })), el('span.grow'), counter,
        el('button.pbtn', { text: tr('cancel'), onclick: () => { this.replyOpen = null; this.render(); } }), send));
  }

  async post(e) {
    const body = this.textarea.value.trim();
    if (this.busy || !body || body.length > MAX_POST_LENGTH) return;
    this.postBtn.disabled = true;
    const time = this.linkTime.checked ? this.p.video.currentTime : null;
    await this.write(e, () => this.api.postComment(e, { body, anonymous: this.anon.checked, time }), () => {
      this.textarea.value = '';
      this.anon.checked = false;
    });
    this.updateCounter(this.textarea, this.counter, this.postBtn);
  }

  // Runs one write, then reloads the list so it shows what the server stored. One write
  // at a time for the whole tab: a second Ctrl+Enter (or a click while the first request
  // is on its way) does nothing, whatever state the buttons are in, so a post can never
  // be published twice.
  async write(e, fn, onSuccess) {
    if (this.busy) return false;
    this.busy = true;
    let ok = false;
    try {
      await fn();
      ok = true;
      if (onSuccess) onSuccess();
      this.showError('');
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy = false;
    }
    await this.load();
    return ok;
  }

  markers() {
    return this.threads.filter((q) => q.time != null).map((q) => ({
      time: q.time,
      kind: 'comment',
      label: tr('markerComment') + ': ' + (q.body.length > 80 ? q.body.slice(0, 77) + '…' : q.body),
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

// ---- 58-markers.js ----
// ===================================================================================
// Progress-bar markers for timed items (notes, bookmarks, flags, discussion posts).
// The layer is rebuilt only when the data or the duration changes; hover and click use
// the seek bar's existing pointer handlers via nearest().
// ===================================================================================

class MarkersLayer {
  constructor(elem) {
    this.el = elem;
    this.items = [];
    this.dur = 0;
  }

  set(items, dur) {
    this.items = items.slice().sort((a, b) => a.time - b.time);
    this.dur = dur;
    this.render();
  }

  render() {
    const elem = this.el;
    elem.textContent = '';
    if (!this.dur) return;
    const frag = document.createDocumentFragment();
    for (const m of this.items) {
      if (m.time < 0 || m.time > this.dur) continue;
      const i = document.createElement('i');
      i.className = 'mk mk-' + m.kind;
      if (m.color) i.style.background = m.color;
      i.style.left = ((m.time / this.dur) * 100).toFixed(3) + '%';
      frag.appendChild(i);
    }
    elem.appendChild(frag);
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

// ---- 59-notice.js ----
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
    close.setAttribute('aria-label', tr('close'));
    close.addEventListener('click', () => host.remove());
    document.body.appendChild(host);
    setTimeout(() => host.remove(), 10000);
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
}

// ---- 60-audio.js ----
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
    const ctx = new Ctx();
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

// ---- 61-media-io.js ----
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

// A refused request (the video access has expired) renews the session once and retries
// (see 36-session.js), so background work continues where it was.
function fetchOk(url, init, renewed) {
  return fetch(url, Object.assign({ credentials: 'include' }, init)).then((r) => {
    if ((r.status === 401 || r.status === 403) && !renewed && mediaSession.renew) {
      return mediaSession.renew().then(() => fetchOk(url, init, true));
    }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url.split('?')[0]);
    return r;
  });
}

function fetchRange(url, offset, length, signal) {
  const headers = length === null ? {} : { Range: 'bytes=' + offset + '-' + (offset + length - 1) };
  return fetchOk(url, { headers, signal }).then((r) => r.arrayBuffer());
}

// IndexedDB, one object store. Reads and ordinary writes never throw (a cache that cannot
// be used just means work is done again) but failures are logged; writes whose loss the
// user would notice (slide files, a restore) use putStrict, which throws. A failed open is
// tried again on the next call; when another tab needs a newer database version, this
// connection closes so it is not in the way.
const idbCache = {
  db: null,
  open() {
    if (this.db) return this.db;
    const p = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
      const req = indexedDB.open('echo360lite', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('cache')) req.result.createObjectStore('cache'); };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); if (this.db === p) this.db = null; };
        db.onclose = () => { if (this.db === p) this.db = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => log.warn('storage: opening is blocked by another tab');
    });
    this.db = p;
    p.catch((e) => { if (this.db === p) this.db = null; log.warn('storage unavailable:', e); });
    return p;
  },
  tx(mode, fn) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('cache', mode);
      const req = fn(tx.objectStore('cache'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  },
  soft(what, key, p) {
    return p.catch((e) => { log.warn('storage ' + what + ' failed (' + String(key).split(':')[0] + '):', e); return undefined; });
  },
  get(key) { return this.soft('read', key, this.tx('readonly', (s) => s.get(key))); },
  put(key, value) { return storageLock.frozen ? Promise.resolve() : this.soft('write', key, this.tx('readwrite', (s) => s.put(value, key))); },
  putStrict(key, value) { return this.tx('readwrite', (s) => s.put(value, key)); },
  // Several entries in one transaction: all are written or none (throws on failure).
  putMany(entries) {
    if (!entries.length) return Promise.resolve();
    return this.tx('readwrite', (s) => { let req = null; for (const [k, v] of entries) req = s.put(v, k); return req; });
  },
  del(key) { return this.soft('delete', key, this.tx('readwrite', (s) => s.delete(key))); },
  keys() { return this.soft('list', '', this.tx('readonly', (s) => s.getAllKeys())).then((k) => k || []); },
  // Read, change and write one entry in a single transaction (no other tab or task can
  // write in between). fn(old) returns the new value, or undefined to delete the entry.
  // Resolves to the new value.
  update(key, fn) {
    if (storageLock.frozen) return Promise.resolve(undefined);
    return this.open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('cache', 'readwrite');
      const os = tx.objectStore('cache');
      let next;
      const req = os.get(key);
      req.onsuccess = () => {
        try { next = fn(req.result); } catch (e) { tx.abort(); reject(e); return; }
        if (next === undefined) os.delete(key); else os.put(next, key);
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  },
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
    const need = minBuffer || BG_MIN_BUFFER_SEC;
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

// ---- 62-silence.js ----
// ===================================================================================
// Silence analysis, and the audio-track reader it is built on.
//
// Data sources, best first:
//   1. Transcript timing: gaps between cues. Free, because the cues are loaded anyway.
//   2. The separate audio rendition (about 46 kbps, 40 MB for two hours): fetched in
//      CHUNK_SEC byte ranges only while playback has enough buffer, decoded to 16 kHz mono by the
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

// Consecutive segments in groups of about `sec` seconds (segments are never split; a group
// holds at least one): [{ a, b }] (segment indexes, b exclusive).
function groupSegments(segments, sec) {
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const cur = out[out.length - 1];
    // A segment joins the group while that keeps the group closer to `sec` long.
    if (cur && segments[i].start + segments[i].dur / 2 - segments[cur.a].start <= sec) cur.b = i + 1;
    else out.push({ a: i, b: i + 1 });
  }
  return out;
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
    this.chunks = groupSegments(pl.segments, CHUNK_SEC);
    return this;
  }

  get chunkCount() { return this.chunks.length; }

  chunkSpan(i) {
    const c = this.chunks[i];
    const last = this.segments[c.b - 1];
    return { start: this.segments[c.a].start, end: last.start + last.dur };
  }

  chunkAt(t) {
    return Math.max(0, sampleIndexAt(this.chunks.map((c) => this.segments[c.a].start), t));
  }

  // Decoded audio of chunk i: { start, end, rate, pcm } with pcm a mono Float32Array.
  async readChunk(i, signal, rate) {
    const sampleRate = rate || AUDIO_RATE;
    const chunk = this.chunks[i];
    if (!chunk) throw new Error('no chunk ' + i);
    const segs = this.segments.slice(chunk.a, chunk.b);
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
    this.carry = null;   // filter state where the last fill ended: { at: frame, hpIn, hpOut, lp }
  }

  known(i) { return this.data[i] !== 0; }

  db(i) {
    const v = this.data[i];
    return v ? -100 + (v - 1) / 2.54 : NaN;
  }

  dbAt(t) { return this.db(clamp(Math.floor(t / this.step), 0, this.length - 1)); }

  fill(start, pcm, rate) {
    const per = Math.round(rate * this.step);
    // One-pole high-pass and low-pass filters. A chunk that continues the one filled last
    // continues its filter state; any other starts from rest at its first sample (not from
    // zero, which would be a step at the chunk's start).
    const hpA = Math.exp(-2 * Math.PI * SPEECH_BAND_HZ[0] / rate);
    const lpA = Math.exp(-2 * Math.PI * SPEECH_BAND_HZ[1] / rate);
    const first = Math.round(start / this.step);
    const c = this.carry && this.carry.at === first ? this.carry : null;
    let hpPrevIn = c ? c.hpIn : pcm[0] || 0;
    let hpPrevOut = c ? c.hpOut : 0;
    let lp = c ? c.lp : 0;
    let f = 0;
    for (; (f + 1) * per <= pcm.length; f++) {
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
    this.carry = { at: first + f, hpIn: hpPrevIn, hpOut: hpPrevOut, lp };
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
  const noise = percentile(vals, SILENCE_NOISE_PCT);
  const speech = percentile(vals, SILENCE_SPEECH_PCT);
  const k = SILENCE_SENSITIVITY[o.sensitivity] || SILENCE_SENSITIVITY.normal;
  let thr = noise + (speech - noise) * k;
  // No dynamics at all: either everything is silent (a muted microphone) or nothing is.
  if (speech - noise < SILENCE_MIN_RANGE_DB) thr = speech < SILENCE_MUTED_DB ? 1 : -101;
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
// Stretches that can be skipped, from silences and from stretches where the screen shows
// one colour (`uniform`, from the slide analysis):
//   kind 'silence'  silent, picture as usual
//   kind 'blank'    silent and the screen empty (at least half of the silence)
//   kind 'black'    the screen empty while nothing is known about the audio (no transcript,
//                   audio not analysed): marked and skippable by hand, never automatically.
// An empty screen with someone speaking is not skippable. Sorted by start.
function skipStretches(silences, uniform, audioKnown, minSec) {
  const overlap = (a, b) => {
    let n = 0;
    for (const u of uniform) n += Math.max(0, Math.min(b, u.end) - Math.max(a, u.start));
    return n;
  };
  const out = silences.map((x) => ({ start: x.start, end: x.end, kind: overlap(x.start, x.end) >= 0.5 * (x.end - x.start) ? 'blank' : 'silence' }));
  if (!audioKnown) {
    for (const u of uniform) if (u.end - u.start >= minSec) out.push({ start: u.start, end: u.end, kind: 'black' });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Where the lecture's content ends: the start of an empty stretch (blank or black) that
// runs to the end of the recording (within `slack` seconds: by default one and a half
// chapter samples, as a stretch ends where its last sample does), else the duration.
function contentEndAt(stretches, duration, slack) {
  const last = stretches[stretches.length - 1];
  if (last && (last.kind === 'blank' || last.kind === 'black') && last.end >= duration - (slack == null ? 1.5 * CHAPTER_STEP_SEC : slack)) return last.start;
  return duration;
}

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
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('silence detection (display)', e); } };
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
      log.warn('silence analysis stopped:', e && e.message ? e.message : e);
      this.fail('error');
    });
  }

  // The analysis stopped. Silences already found from the audio are kept (and stay
  // cached); only when nothing was found is the feature unavailable.
  fail(reason) {
    this.reason = reason;
    if (this.env && this.env.coverage() > 0) { this.recompute(); return; }
    this.source = 'unavailable';
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
    await this.gate.wait(cached ? 0 : SILENCE_START_DELAY_MS); // let playback start first
    const track = await new HlsAudioTrack(this.masterUrl).open(signal);
    this.track = track;
    const data = cacheValid('silence-env', cached) && cached.step === ENV_STEP ? cached.data : null;
    if (data) cacheTouch(key);
    this.env = new Envelope(track.duration, data);
    this.progress = this.env.coverage();
    this.recompute();

    // Upcoming audio first, then the rest from the beginning.
    const n = track.chunkCount;
    const from = track.chunkAt(this.video.currentTime || 0);
    const order = [];
    for (let k = 0; k < n; k++) order.push((from + k) % n);
    let sinceSave = 0;
    let fails = 0;
    for (const i of order) {
      const span = track.chunkSpan(i);
      if (this.env.coverageOf(span.start, span.end) > 0.9) continue;
      await this.gate.turn(SILENCE_PACE_MS[0], SILENCE_PACE_MS[1], BG_MIN_BUFFER_SEC);
      // A chunk that cannot be read or decoded is left out (that stretch stays unknown,
      // never "silent"); only several in a row end the analysis, keeping what was found.
      let chunk;
      try {
        chunk = await track.readChunk(i, signal);
        fails = 0;
      } catch (e) {
        if (signal.aborted) return;
        if (++fails >= ANALYSIS_MAX_FAILS) { this.save(key); this.recompute(); throw e; }
        log.warn('silence detection: chunk ' + i + ' skipped:', e);
        continue;
      }
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
    if (this.lesson.mediaId) idbCache.put(key, { v: cacheVersion('silence-env'), used: Date.now(), step: ENV_STEP, data: this.env.data, at: Date.now() });
  }

}

// ---- 63-caches.js ----
// ===================================================================================
// Analysis caches in IndexedDB: slide chapters, silence envelopes, text read on screen.
//
// - Each kind has a version tied to its algorithm. A stored result with another version
//   was made by different code and is computed again (bump the number when changing how
//   results are made, not only their format).
// - Each record carries `used`, the last time it was used (its own field: records already
//   use names such as `at` for their data). A minute after a player starts,
//   records of these kinds that were not used for CACHE_KEEP_DAYS, or are from another
//   version, are deleted in the background.
// - Settings menu: how much space they take, and clearing them all.
// User data (tags, slide files, watched records) is not an analysis cache and is never
// pruned here.
// ===================================================================================

const CACHE_KINDS = {
  slides: 4,          // chapters (2: screen view chosen per recording, tolerant scanning; 3: uniform stretches; 4: 160 x 90, learnt threshold)
  'silence-env': 1,   // audio level envelope
  ocr: 1,             // text read on screen
};
const CACHE_KEEP_DAYS = 60;

function cacheKind(key) {
  const k = String(key).split(':')[0];
  return Object.prototype.hasOwnProperty.call(CACHE_KINDS, k) ? k : null;
}

function cacheVersion(kind) {
  return CACHE_KINDS[kind];
}

// Whether a stored record of `kind` can be used.
function cacheValid(kind, rec) {
  return !!rec && typeof rec === 'object' && rec.v === CACHE_KINDS[kind];
}

// The record with its last use set to now (nothing else changes).
function cacheTouched(rec, now) {
  return rec && typeof rec === 'object' ? Object.assign(rec, { used: now }) : rec;
}

// When a record was last used or, for records from before `used`, saved (ms, or 0).
function cacheLastUse(rec) {
  if (!rec || typeof rec !== 'object') return 0;
  for (const k of ['used', 'savedAt', 'at']) if (typeof rec[k] === 'number' && isFinite(rec[k])) return rec[k];
  return 0;
}

// Marks a record as used now (keeps it from being pruned).
function cacheTouch(key) {
  idbCache.update(key, (rec) => cacheTouched(rec, Date.now())).catch(() => {});
}

// Rough size of a stored value in bytes (Blobs by their size, the rest as JSON).
function approxSize(v) {
  if (v instanceof Blob) return v.size;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (Array.isArray(v)) return v.reduce((s, x) => s + approxSize(x), 0) + 2;
  if (v && typeof v === 'object') {
    let s = 2;
    for (const [k, x] of Object.entries(v)) s += k.length + 3 + approxSize(x);
    return s;
  }
  return String(v).length + 1;
}

const analysisCaches = {
  async keys() {
    return (await idbCache.keys()).filter((k) => cacheKind(k));
  },

  // { count, bytes } of all analysis caches.
  async usage() {
    let bytes = 0;
    const keys = await this.keys();
    for (const k of keys) bytes += approxSize(await idbCache.get(k));
    return { count: keys.length, bytes };
  },

  async clear() {
    const keys = await this.keys();
    for (const k of keys) await idbCache.del(k);
    return keys.length;
  },

  // Deletes records unused for CACHE_KEEP_DAYS or from another algorithm version.
  async prune() {
    const old = Date.now() - CACHE_KEEP_DAYS * 864e5;
    let n = 0;
    for (const k of await this.keys()) {
      const rec = await idbCache.get(k);
      if (!cacheValid(cacheKind(k), rec) || !(cacheLastUse(rec) > old)) { await idbCache.del(k); n++; }
    }
    if (n) log.info('removed ' + n + ' old analysis results');
    return n;
  },
};

// ---- 64-slides.js ----
// ===================================================================================
// Slide chapters: find where the screen view changes to a new slide.
//
// Sources, best first:
//   1. Chapter or slide data from Echo360 itself. None of the recordings checked so far had
//      any (cfg.chapters, slide decks and scenes were all empty), so this is not used yet.
//   2. Keyframes of the screen view. Every HLS segment starts with a keyframe; reading just
//      the start of a segment every CHAPTER_STEP_SEC (about 20 KB at 360p, 15 MB for two
//      hours) and decoding it with WebCodecs gives the whole lecture at that resolution.
//      Each change is then pinned to about 1 s by decoding the stretch it happened in.
//      Downloads only run while playback has enough buffer, and the result is cached in
//      IndexedDB.
//   3. Echo360's preview thumbnails (one per minute), when WebCodecs is not available.
//      They are also shown at once while the keyframes are being read.
//
// Which view is the screen: slides, code and documents have large flat areas, camera
// pictures do not (sensor noise), so the view with the most flat area is used.
//
// Change detection compares 160 x 90 brightness pictures. How large a change makes a new
// picture is learnt per recording from its own changes (see learnThreshold): ink, a pointer
// or scrolling code change fewer pixels than another slide, but how many fewer depends on
// the lecturer, the slides and the recording, so no fixed share is used. A run of quick
// changes (scrolling code, flicking through slides) becomes one chapter instead of many,
// and a short look elsewhere that comes back joins the chapter (see buildScenes).
//
// Reusable pieces:
//   HlsVideoReader   open(), segments, segmentAt(t), sampleSegments(step),
//                    keyframe(i) -> VideoFrame, frames(i, stepSec, onFrame)
//   lumaThumb(g, img), frameLuma(img), thumbChange(a, b), learnThreshold(changes)
//   buildScenes(samples, duration, opts) -> [{ start, end, rep, first }]
//   SlideAnalyzer    chapters: [{ start, end, precise, repTime, thumb }], screenIndex,
//                    lumaAt(t) (shared with the slide reader)
// ===================================================================================


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
    this.lastNeed = 0;       // bytes the last keyframe needed (header included)
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

  // Segments to sample about every stepSec seconds: [segment index] (the keyframe of each
  // segment is at its start).
  sampleSegments(stepSec) {
    const out = [];
    let next = -Infinity;
    this.segments.forEach((sg, i) => {
      if (sg.start + sg.dur / 2 < next) return;
      out.push(i);
      next = sg.start + stepSec;
    });
    return out;
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

  // First frame of segment i: fn(frame, seconds) is called once.
  async keyframe(i, signal, fn) {
    const s = this.segments[i];
    // Bytes from the start of the segment, fetching only what is still missing.
    let buf = new ArrayBuffer(0);
    const upTo = async (n) => {
      const want = Math.min(s.length, n);
      if (want <= buf.byteLength) return;
      const more = await fetchRange(s.url, s.offset + buf.byteLength, want - buf.byteLength, signal);
      this.bytes += more.byteLength;
      const all = new Uint8Array(buf.byteLength + more.byteLength);
      all.set(new Uint8Array(buf), 0);
      all.set(new Uint8Array(more), buf.byteLength);
      buf = all.buffer;
    };
    // The fragment header and the keyframe come first; their size is only known once the
    // header is read. Ask for a little more than the last keyframe needed (keyframes of one
    // stream are of similar size), the first time for just the start of the header, then
    // for whatever is still missing: a wrong guess costs a request, never a wrong result.
    await upTo(this.lastNeed ? Math.round(this.lastNeed * 1.25) : 4096);
    for (;;) {
      const boxes = mp4Boxes(new DataView(buf), 0, buf.byteLength);
      const moof = boxes.find((x) => x.type === 'moof');
      const last = boxes[boxes.length - 1];
      const end = moof ? moof.start + moof.size : last ? last.start + last.size + 8 : 8;
      if (end <= buf.byteLength || buf.byteLength >= s.length) break;
      await upTo(end);
    }
    const frag = parseFragment(buf, s.offset);
    const k = frag.samples[0];
    if (!k || !k.key) throw new Error('segment does not start with a keyframe');
    this.lastNeed = k.offset + k.size;
    await upTo(k.offset + k.size);
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
//
// Frames are compared as 160 x 90 brightness pictures (one pixel is a 2 x 2 block at 360p,
// 8 x 8 at 720p): fine enough that a changed line of slide text changes several pixels.


// Brightness of a frame at THUMB_W x THUMB_H, drawn with the 2D context g.
function lumaThumb(g, img) {
  g.drawImage(img, 0, 0, THUMB_W, THUMB_H);
  const d = g.getImageData(0, 0, THUMB_W, THUMB_H).data;
  const out = new Uint8Array(THUMB_W * THUMB_H);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return out;
}

let thumbCtx = null;
function thumbContext() {
  if (!thumbCtx) {
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(THUMB_W, THUMB_H) : Object.assign(document.createElement('canvas'), { width: THUMB_W, height: THUMB_H });
    thumbCtx = c.getContext('2d', { willReadFrequently: true });
  }
  return thumbCtx;
}

// Brightness picture of any drawable (VideoFrame, ImageBitmap, <video>, <img>).
function frameLuma(img) {
  return lumaThumb(thumbContext(), img);
}

// Pixels of two brightness pictures that differ by more than PIXEL_DIFF. Stops counting
// at `limit` (the caller only needs to know whether that many changed).
function thumbChange(a, b, limit) {
  const stop = limit || Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_DIFF && ++n >= stop) break;
  return n;
}

// Share of pixels (0-1) of two brightness pictures that changed a little: more than
// STILL_LEVELS (the same picture encoded again), at most PIXEL_DIFF (a real edge moving).
// Sensor noise and movement in a camera picture; next to nothing on a still screen.
function slightChange(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > STILL_LEVELS && d <= PIXEL_DIFF) n++;
  }
  return n / a.length;
}

// The change of each sample against the last earlier sample that differed visibly from the
// one before it (so that slow changes, ink added a little at a time, still add up), in
// changed pixels; 0 for the first. samples: [{ luma }], sets sample.change; only samples
// from `from` on are computed (earlier ones keep theirs).
function sampleChanges(samples, from) {
  let ref = null;
  for (let k = Math.max(0, (from || 0) - 1); k >= 0 && !ref; k--) if (k === 0 || samples[k].change >= SAME_TEXT_MAX) ref = samples[k].luma;
  for (let k = from || 0; k < samples.length; k++) {
    const s = samples[k];
    if (!ref) { s.change = 0; ref = s.luma; continue; }
    s.change = thumbChange(ref, s.luma);
    if (s.change >= SAME_TEXT_MAX) ref = s.luma;
  }
}

// How many changed pixels make a new picture, learnt from this recording: its visible
// changes (SAME_TEXT_MAX or more) split into two groups (small: ink, scrolling, a pointer;
// large: another slide or program) at the point that separates them best (Otsu's method,
// on the logarithm, since the sizes span orders of magnitude). Samples without a visible
// change are left out: they say nothing about the split and, being most of a lecture,
// would pull it down to ink level (checked on four lectures: the same changes found, a
// sixth to a quarter fewer false ones). With fewer than two different visible changes
// there is nothing to split, and every visible change counts as a new picture.
function learnThreshold(changes) {
  const v = changes.filter((c) => c >= SAME_TEXT_MAX).map((c) => Math.log1p(c)).sort((a, b) => a - b);
  const n = v.length;
  let total = 0;
  for (const x of v) total += x;
  let best = -1;
  let cut = Infinity;
  let left = 0;
  for (let i = 1; i < n; i++) {
    left += v[i - 1];
    if (v[i] === v[i - 1]) continue;
    const ma = left / i;
    const mb = (total - left) / (n - i);
    const score = i * (n - i) * (mb - ma) ** 2;
    if (score > best) { best = score; cut = (v[i - 1] + v[i]) / 2; }
  }
  return cut === Infinity ? SAME_TEXT_MAX : Math.expm1(cut);
}

// Mean brightness of 5 x 5 blocks: a 32 x 18 version of a brightness picture.
function lumaBlocks(luma) {
  const W = THUMB_W / 5;
  const H = THUMB_H / 5;
  const out = new Float32Array(W * H);
  for (let y = 0; y < THUMB_H; y++) for (let x = 0; x < THUMB_W; x++) out[((y / 5) | 0) * W + ((x / 5) | 0)] += luma[y * THUMB_W + x] / 25;
  return out;
}

// A picture of (almost) one colour: a black screen, a "no signal" picture, a blank slide in
// one colour. Judged by evenness, not darkness, so any kind of empty picture counts: nearly
// every block of a 32 x 18 version is within noise of the median brightness (UNIFORM_*).
function frameUniform(luma) {
  const l = lumaBlocks(luma);
  const n = l.length;
  const sorted = Float32Array.from(l).sort();
  const med = sorted[n >> 1];
  let close = 0;
  for (let i = 0; i < n; i++) if (Math.abs(l[i] - med) <= UNIFORM_NOISE) close++;
  return close >= UNIFORM_SHARE * n;
}

// Stretches of uniform samples: [{ start, end }] (a stretch ends where the next sample starts).
function uniformStretches(samples, duration) {
  const out = [];
  for (let k = 0; k < samples.length; k++) {
    if (!samples[k].uniform) continue;
    const end = k + 1 < samples.length ? samples[k + 1].t : duration;
    const last = out[out.length - 1];
    if (last && last.end >= samples[k].t - 0.01) last.end = end; else out.push({ start: samples[k].t, end });
  }
  return out;
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
      if (Math.abs(l - d[i + 4] - d[i + 5] - d[i + 6]) <= FLAT_LEVELS && Math.abs(l - d[i + W * 4] - d[i + W * 4 + 1] - d[i + W * 4 + 2]) <= FLAT_LEVELS) n++;
    }
  }
  return n / tot;
}

// ---- scenes ----

// samples: [{ t, luma, change }] in time order (see sampleChanges). Returns scenes
// [{ start, end, rep }] where rep is the sample that best shows the chapter: the last sample
// (ink and builds are complete there) of the view it stays on longest. A scene starts at
// its first sample; refinement moves it earlier.
//
// opts.threshold: changed pixels that make a new picture (default: learnt from the samples).
// opts.single: merge chapters of a single sample (default true; off for samples a minute
// apart, where one sample is a long stretch).
//
// 1. Runs: a new run starts where a sample changed by the threshold or more.
// 2. A run that starts with a picture already shown in the current chapter (back to the
//    slide after a look at the editor) continues the chapter.
// 3. A look elsewhere between two stays on the same picture, no longer than either of them,
//    joins them into one chapter (a short demo, then back to the slide; flicking between a
//    slide and a question board).
// 4. A chapter of a single sample is shorter than the sampling can tell apart: several in a
//    row (flicking through slides, scrolling) are one chapter, a lone one (a transition
//    caught half way) joins the next.
// All lengths are relative to each other or to the sampling step: no fixed durations.
function buildScenes(samples, duration, opts) {
  const o = Object.assign({ single: true }, opts);
  if (!samples.length) return [];
  if (samples.some((s) => s.change == null)) sampleChanges(samples);
  const thr = o.threshold != null ? o.threshold : learnThreshold(samples.slice(1).map((s) => s.change));
  const tAt = (k) => (k < samples.length ? samples[k].t : duration);
  const same = (i, j) => thumbChange(samples[i].luma, samples[j].luma, thr) < thr;
  // 1. Runs of the same picture.
  const runs = [{ a: 0, b: 0 }];
  for (let k = 1; k < samples.length; k++) {
    if (samples[k].change < thr) runs[runs.length - 1].b = k;
    else runs.push({ a: k, b: k });
  }
  // A chapter's pictures: the first and last sample of each of its runs.
  const shows = (ch, k) => ch.runs.some((r) => same(r.a, k) || (r.b !== r.a && same(r.b, k)));
  const len = (ch) => tAt(ch.b + 1) - samples[ch.a].t;
  // 2. Chapters; a return within the current chapter continues it.
  let chs = [];
  for (const r of runs) {
    const cur = chs[chs.length - 1];
    if (cur && shows(cur, r.a)) { cur.b = r.b; cur.runs.push(r); } else chs.push({ a: r.a, b: r.b, runs: [r] });
  }
  // 3. Short looks elsewhere between two stays on the same picture.
  for (let i = 1; i + 1 < chs.length; i++) {
    const [x, y, z] = [chs[i - 1], chs[i], chs[i + 1]];
    if (len(y) <= len(x) && len(y) <= len(z) && shows(x, z.a)) {
      chs.splice(i - 1, 3, { a: x.a, b: z.b, runs: x.runs.concat(y.runs, z.runs) });
      i = Math.max(0, i - 2);
    }
  }
  // 4. Chapters of one sample.
  if (o.single) {
    const out = [];
    const one = (ch) => ch.a === ch.b;
    for (let i = 0; i < chs.length; i++) {
      const ch = { a: chs[i].a, b: chs[i].b, runs: chs[i].runs.slice() };
      const absorb = (x) => { ch.b = x.b; ch.runs.push(...x.runs); };
      if (one(ch)) {
        let j = i;
        while (j + 1 < chs.length && one(chs[j + 1])) j++;
        if (j > i) { for (let q = i + 1; q <= j; q++) absorb(chs[q]); i = j; } else if (i + 1 < chs.length) { absorb(chs[i + 1]); i++; }
      }
      out.push(ch);
    }
    chs = out;
  }
  return chs.map((ch, i) => {
    let best = ch.runs[0];
    for (const x of ch.runs) if (tAt(x.b + 1) - samples[x.a].t >= tAt(best.b + 1) - samples[best.a].t) best = x;
    return {
      start: i === 0 ? 0 : samples[ch.a].t,
      end: i + 1 < chs.length ? samples[chs[i + 1].a].t : duration,
      rep: best.b,
      first: ch.a,
    };
  });
}

// Index of the last of the ascending times that is at or before t (-1 if none).
function sampleIndexAt(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return k;
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

// A small copy of a frame, made synchronously (a VideoFrame is only valid in its callback),
// in the frame's own shape (a 4:3 screen stays 4:3).
function smallBitmap(img, w) {
  const iw = img.displayWidth || img.width || 16;
  const ih = img.displayHeight || img.height || 9;
  const c = new OffscreenCanvas(w, Math.max(1, Math.round((w * ih) / iw)));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function bitmapToBlob(canvas) {
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

// The screen among scored views [{ vals, ... }] (see findScreen): the one with the lowest
// (lowerIsScreen) or highest median; sure if every view was scored and the chosen one's
// values beat each other view's in SCREEN_CLEARLY of all pairs. { best, sure }.
function pickScreen(scored, lowerIsScreen, viewCount) {
  const median = (v) => { const a = v.slice().sort((x, y) => x - y); return (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2; };
  // Share of pairs in which a value of `a` is above one of `b` (ties count half).
  const above = (a, b) => {
    let w = 0;
    for (const x of a) for (const y of b) w += x > y ? 1 : x === y ? 0.5 : 0;
    return w / (a.length * b.length);
  };
  const order = scored.slice().sort((a, b) => (lowerIsScreen ? median(a.vals) - median(b.vals) : median(b.vals) - median(a.vals)));
  const best = order[0];
  const sure = order.length === viewCount && order.slice(1).every((o) => (lowerIsScreen ? above(o.vals, best.vals) : above(best.vals, o.vals)) >= SCREEN_CLEARLY);
  return { best, sure };
}

// ---- the controller used by the player ----

class SlideAnalyzer {
  // opts: { lesson, video, disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('slide chapters (display)', e); } };
    this.d = opts.disposer;
    this.ac = new AbortController();
    this.d.add(() => this.ac.abort());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.state = 'pending';   // pending | thumbnails | keyframes | done | unavailable
    this.progress = 0;
    this.chapters = [];
    this.uniform = [];       // stretches where the screen shows (almost) one colour
    this.screenIndex = null;
    this.guessScreen = null;
    this.screenSure = true;     // false: the views did not differ clearly (the screen is a guess)
    this.manualScreen = null;   // the view the user chose, if any
    this.reader = null;
    this.urls = [];
    this.d.add(() => { for (const u of this.urls) URL.revokeObjectURL(u); this.urlOf = null; });
  }

  // Each run has its own signal and gate: a run replaced by chooseScreen stops at its next
  // step and never writes into the new one's results.
  start() {
    const signal = this.ac.signal;
    this.run(signal, this.gate).catch((e) => {
      if (signal.aborted) return;
      log.warn('slide detection stopped:', e && e.message ? e.message : e);
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

  // Lets go of pictures no chapter shows any more (chapters are rebuilt while scanning).
  pruneThumbs() {
    if (!this.urlOf) return;
    const used = new Set(this.chapters.map((c) => c.blob).filter(Boolean));
    for (const [blob, u] of this.urlOf) {
      if (used.has(blob)) continue;
      URL.revokeObjectURL(u);
      this.urlOf.delete(blob);
    }
    this.urls = [...this.urlOf.values()];
  }

  async run(signal, gate) {
    const key = 'slides:' + this.lesson.mediaId;
    const id = this.lesson.mediaId;
    const pick = id ? await idbCache.get('screenpick:' + id) : null;
    this.manualScreen = pick && this.lesson.sources.some((x) => x.index === pick.index) ? pick.index : null;
    const cached = id ? await idbCache.get(key) : undefined;
    if (signal.aborted) return;
    // A result for another view than the one chosen by hand is made again.
    if (cacheValid('slides', cached) && Array.isArray(cached.chapters) && (this.manualScreen == null || cached.screen === this.manualScreen)) {
      cacheTouch(key);
      this.uniform = Array.isArray(cached.uniform) ? cached.uniform : [];
      this.screenIndex = cached.screen;
      this.screenSure = cached.sure !== false;
      this.chapters = cached.chapters.map((c) => Object.assign({}, c, { thumb: c.blob ? this.thumbUrl(c.blob) : c.thumb }));
      this.state = 'done';
      this.progress = 1;
      this.onChange();
      return;
    }
    // Which view is the screen is needed early (quality settings are per view).
    const screen = await this.findScreen(signal);
    if (signal.aborted) return;
    if (!screen) { this.state = 'unavailable'; this.onChange(); return; }
    this.screenIndex = screen.source.index;
    this.screenSure = screen.sure;
    this.onChange();
    await gate.wait(BG_START_DELAY_MS); // let playback start first
    if (screen.thumbs) this.fromThumbnails(screen.thumbs, signal, gate);
    if (!HlsVideoReader.supported() || (navigator.connection && navigator.connection.saveData)) {
      if (this.chapters.length) { this.state = 'done'; this.progress = 1; this.onChange(); }
      return;
    }
    await this.fromKeyframes(screen.source, signal, gate, screen.reader);
    if (!signal.aborted) this.save(key);
  }

  // The user says which view is the screen (index), or leaves it to the analysis (null).
  // Kept per recording; the chapters are found again from that view.
  async chooseScreen(index) {
    const id = this.lesson.mediaId;
    if (id) {
      if (index == null) await idbCache.del('screenpick:' + id);
      else await idbCache.put('screenpick:' + id, { index });
    }
    // Confirming the view in use only remembers it.
    if (index != null && index === this.screenIndex) {
      this.manualScreen = index;
      this.screenSure = true;
      this.onChange();
      return;
    }
    this.ac.abort();
    this.ac = new AbortController();
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    if (this.lesson.mediaId) await idbCache.del('slides:' + this.lesson.mediaId);
    this.state = 'pending';
    this.progress = 0;
    this.chapters = [];
    this.uniform = [];
    this.thumbsDone = null;
    this.lumas = null;
    this.pruneThumbs();
    this.onChange();
    this.start();
  }

  // Which view is the screen: { source, thumbs (its preview set or null), sure, reader },
  // or null if no view can be read at all.
  // 1. The view the user chose for this recording.
  // 2. With one view, that view.
  // 3. How each view changes over time, from pairs of keyframes CHAPTER_STEP_SEC apart
  //    spread over the recording: a screen is still between changes (the same picture is
  //    encoded the same way, so nearly every pixel stays within STILL_LEVELS) and then
  //    changes in a step; a camera always changes a little everywhere (sensor noise, people
  //    moving). The share of slightly changed pixels per pair is lower for the screen on
  //    every recording checked (median about 0.2-11% against 12-35%, the highest screen
  //    value from a document camera). Echo360's data does not say which view is which.
  // 4. Without WebCodecs: the preview pictures' flat area (slides and documents are
  //    flatter than camera pictures; weaker, a busy screen can be less flat).
  // The most likely view is used even when the views do not differ clearly (sure = false):
  // a wrong guess shows wrong chapters that the user can fix by choosing the view, while
  // giving up would hide the feature. "Clearly" is SCREEN_CLEARLY: the chosen view's
  // values are below (or for flatness above) another view's in that share of pairs.
  async findScreen(signal) {
    const sources = this.lesson.sources;
    const setOf = (src) => (this.lesson.thumbnails || []).find((x) => x.sourceIndex === src.index && Array.isArray(x.timesInSeconds) && x.timesInSeconds.length) || null;
    if (this.manualScreen != null) {
      const src = sources.find((x) => x.index === this.manualScreen);
      this.guessScreen = src.index;
      return { source: src, thumbs: setOf(src), sure: true, reader: null };
    }
    if (sources.length === 1) { this.guessScreen = sources[0].index; return { source: sources[0], thumbs: setOf(sources[0]), sure: true, reader: null }; }
    const decide = (scored, lowerIsScreen) => {
      const r = pickScreen(scored, lowerIsScreen, sources.length);
      this.guessScreen = r.best.source.index;
      return { source: r.best.source, thumbs: setOf(r.best.source), sure: r.sure, reader: r.best.reader || null };
    };
    if (HlsVideoReader.supported()) {
      const scored = [];
      for (const src of sources) {
        const vals = [];
        let rd = null;
        try {
          rd = await new HlsVideoReader(src.v || src.av, 360).open(signal);
          const picks = rd.sampleSegments(CHAPTER_STEP_SEC);
          for (let k = 0; k < SCREEN_PROBES && picks.length > 1; k++) {
            const q = Math.floor(((k + 0.5) * (picks.length - 1)) / SCREEN_PROBES);
            let a = null;
            let b = null;
            try {
              await rd.keyframe(picks[q], signal, (f) => { a = frameLuma(f); });
              await rd.keyframe(picks[q + 1], signal, (f) => { b = frameLuma(f); });
            } catch (e) { if (signal.aborted) throw e; continue; }
            vals.push(slightChange(a, b));
          }
        } catch (e) { if (signal.aborted) throw e; }
        if (vals.length >= SCREEN_PROBES / 2) scored.push({ source: src, vals, reader: rd });
      }
      if (scored.length) return decide(scored, true);
    }
    const scored = [];
    for (const src of sources) {
      const set = setOf(src);
      if (!set) continue;
      const ts = set.timesInSeconds;
      const vals = [];
      for (let k = 0; k < SCREEN_PROBES; k++) {
        // One picture that cannot be read does not decide anything.
        let img = null;
        try { img = await this.loadThumb(set, ts[Math.floor(((k + 0.5) * ts.length) / SCREEN_PROBES)], signal); } catch (e) { if (signal.aborted) throw e; }
        if (!img) continue;
        vals.push(flatShare(img));
        img.close();
      }
      if (vals.length >= SCREEN_PROBES / 2) scored.push({ source: src, vals });
    }
    return scored.length ? decide(scored, false) : null;
  }

  async loadThumb(set, t, signal) {
    const url = set.baseUri + '/' + t + '.' + set.extension;
    let r;
    try {
      r = await fetchOk(url, { signal });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      // A copy cached from the original player (loaded as a plain image) can lack the
      // CORS headers; ask the server again.
      r = await fetchOk(url, { signal, cache: 'reload' });
    }
    return createImageBitmap(await r.blob());
  }

  // Coarse chapters from the per-minute thumbnails: a change between two thumbnails is
  // placed half way between them.
  async fromThumbnailsAsync(set, signal, gate) {
    const samples = [];
    let fails = 0;
    for (const t of set.timesInSeconds) {
      await gate.wait(0);
      // A preview picture that cannot be read is left out.
      let img = null;
      try { img = await this.loadThumb(set, t, signal); fails = 0; } catch (e) {
        if (signal.aborted || ++fails >= ANALYSIS_MAX_FAILS) throw e;
        continue;
      }
      samples.push({ t, luma: frameLuma(img) });
      img.close();
    }
    if (samples.length < 2 || signal.aborted) return;
    const scenes = buildScenes(samples, this.duration(), { single: false });
    this.chapters = scenes.map((sc, i) => ({
      start: i === 0 ? 0 : (samples[sc.first].t + samples[sc.first - 1].t) / 2,
      end: sc.end,
      precise: false,
      repTime: samples[sc.rep].t,
      thumb: set.baseUri + '/' + samples[sc.rep].t + '.' + set.extension,
    }));
    for (let i = 1; i < this.chapters.length; i++) this.chapters[i - 1].end = this.chapters[i].start;
    this.state = 'thumbnails';
    this.onChange();
  }

  fromThumbnails(set, signal, gate) {
    this.thumbsDone = this.fromThumbnailsAsync(set, signal, gate).catch((e) => { if (!signal.aborted) log.warn('thumbnails:', e.message); });
  }

  // The 360p brightness picture of the screen view at sample time t, while the scan keeps
  // them (see shareLumas), else null. The slide reader compares the same pictures; sharing
  // saves downloading them twice.
  lumaAt(t) {
    return (this.lumas && this.lumas.get(Math.round(t * 10))) || null;
  }

  // The slide reader of `source` wants the pictures (true) or no longer does (false). They
  // are kept while either the scan runs or a reader of the scanned view uses them.
  shareLumas(on, source) {
    this.sharing = !!on && !!source && source.index === this.screenIndex;
    if (!this.sharing && this.state === 'done') this.lumas = null;
    return this.sharing;
  }

  async fromKeyframes(source, signal, gate, opened) {
    const reader = opened || await new HlsVideoReader(source.v || source.av, 360).open(signal);
    if (this.thumbsDone) await this.thumbsDone;
    if (signal.aborted) return;
    this.reader = reader;
    const picks = reader.sampleSegments(CHAPTER_STEP_SEC);
    const n = picks.length;
    const samples = [];
    const lumas = new Map();
    this.lumas = lumas;
    if (store.get('debug', false)) this.samples = samples; // for tuning, development only
    const thumbs = new Map();
    let lastBuild = 0;
    let fails = 0;
    for (let q = 0; q < n; q++) {
      const i = picks[q];
      await gate.turn(CHAPTER_PACE_MS[0], CHAPTER_PACE_MS[1], BG_MIN_BUFFER_SEC);
      let luma = null;
      let pic = null;
      // One segment that cannot be read (a missing keyframe, a failed request) does not end
      // the analysis: it counts as "same picture as before"; only several in a row do.
      try {
        await reader.keyframe(i, signal, (f) => { luma = frameLuma(f); pic = smallBitmap(f, CHAPTER_THUMB_W); });
        fails = 0;
      } catch (e) {
        if (signal.aborted) throw e;
        if (++fails >= ANALYSIS_MAX_FAILS) {
          if (samples.length) this.applyScenes(samples, thumbs, reader.segments[i].start);
          throw e;
        }
        log.warn('slide chapters: segment ' + i + ' skipped:', e);
      }
      const j = samples.length;
      const t = reader.segments[i].start;
      if (!luma) {
        if (j) samples.push({ t, luma: samples[j - 1].luma, uniform: samples[j - 1].uniform, change: 0 });
        continue;
      }
      samples.push({ t, luma, uniform: frameUniform(luma) });
      lumas.set(Math.round(t * 10), luma);
      sampleChanges(samples, j);
      // Keep a small picture only for the last frame of each run of the same picture.
      if (thumbs.has(j - 1) && samples[j].change < SAME_TEXT_MAX) thumbs.delete(j - 1);
      thumbs.set(j, await bitmapToBlob(pic));
      if (signal.aborted) return;
      this.progress = ((q + 1) / n) * 0.8;
      if (q - lastBuild >= 30) {
        lastBuild = q;
        // With per-minute chapters on screen, partial results would only show fewer.
        if (this.state !== 'thumbnails') this.applyScenes(samples, thumbs, q + 1 < n ? reader.segments[picks[q + 1]].start : this.duration());
        else this.onChange();
      }
    }
    this.state = 'keyframes';
    this.uniform = uniformStretches(samples, this.duration());
    const thr = this.applyScenes(samples, thumbs, this.duration());
    // Pin each change to about a second: the first frame between the last sample before it
    // and the first one after it that differs from the one before as much as a new picture.
    const chs = this.chapters;
    const g = thumbContext();
    for (let c = 1; c < chs.length; c++) {
      const k = chs[c].firstSample;
      if (k <= 0) continue;
      await gate.turn(CHAPTER_REFINE_PACE_MS[0], CHAPTER_REFINE_PACE_MS[1], STREAM_MAX_BUFFER_SEC);
      const before = samples[k - 1].luma;
      let at = null;
      // A segment that cannot be read keeps the coarse time.
      try {
        for (let i = reader.segmentAt(samples[k - 1].t); at === null && i < reader.segments.length && reader.segments[i].start < samples[k].t; i++) {
          await reader.frames(i, 1, signal, (f, ft) => { if (at === null && thumbChange(before, lumaThumb(g, f), thr) >= thr) at = ft; });
        }
      } catch (e) {
        if (signal.aborted) throw e;
        at = null;
      }
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
    if (!this.sharing) this.lumas = null;
    this.progress = 1;
    this.onChange();
  }

  // Chapters from the samples so far (end: when the last one ends). Returns the threshold
  // used.
  applyScenes(samples, thumbs, end) {
    const thr = learnThreshold(samples.slice(1).map((x) => x.change));
    const scenes = buildScenes(samples, end, { threshold: thr });
    this.chapters = scenes.map((sc) => {
      let blob = null;
      // The newest picture of this scene that is still kept.
      for (let k = sc.rep; k >= sc.first && !blob; k--) blob = thumbs.get(k) || null;
      return { start: sc.start, end: sc.end, precise: false, repTime: samples[sc.rep].t, firstSample: sc.first, blob, thumb: blob ? this.thumbUrl(blob) : '' };
    });
    this.threshold = thr;
    this.pruneThumbs();
    this.onChange();
    return thr;
  }

  save(key) {
    if (!this.lesson.mediaId || this.state !== 'done') return;
    idbCache.put(key, {
      used: Date.now(),
      v: cacheVersion('slides'),
      uniform: this.uniform,
      screen: this.screenIndex,
      sure: this.screenSure !== false,
      at: Date.now(),
      chapters: this.chapters.map((c) => ({ start: c.start, end: c.end, precise: c.precise, repTime: c.repTime, blob: c.blob || null, thumb: c.blob ? '' : c.thumb })),
    });
  }
}

// ---- 65-slides-pane.js ----
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
    // The pages go in their own box (which the picture-area view can zoom), the
    // "not recognised" note stays over it at its own size.
    const pages = el('div.rpages');
    stage.append(pages, el('div.rstale', { text: tr('pageNotRecognised') }));
    this.targets.set(name, { stage, pages, active: false, token: 0 });
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

  // Returns a function that removes the listener again.
  onInfo(fn) { this.infoListeners.add(fn); return () => this.infoListeners.delete(fn); }

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
    const ar = p.ar || PAGE_AR_DEFAULT;
    const w = stage.clientWidth || 320;
    const hgt = stage.clientHeight || w * ar;
    // Zoomed in (picture-area view): sharper, up to a canvas the browser handles easily.
    const width = Math.min(4096, Math.max(200, Math.min(w, hgt / ar)) * dpr * (tg.sharp || 1));
    deck.render(i, width).then((src) => {
      if (token !== tg.token) return;
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      c.className = 'rpage';
      tg.pages.append(c);
      requestAnimationFrame(() => c.classList.add('in'));
      const old = [...tg.pages.querySelectorAll('canvas')].filter((x) => x !== c);
      setTimeout(() => { for (const x of old) x.remove(); }, 220);
    }).catch((e) => log.warn('render page:', e && e.message ? e.message : e));
  }

  // "Page 5 of 21 · file" for the page shown.
  label() {
    const deck = this.deck;
    const p = deck.pages[this.view];
    if (!p) return '';
    return tr('pageOfN', { n: p.num, total: deck.pages.filter((x) => x.file === p.file).length })
      + (deck.files.length > 1 ? ' · ' + p.file.replace(/\.pdf$/i, '') : '');
  }

  // The following line: following (sure / unsure / stale), or a button back to it.
  // `compact` gives the short wording for the toolbar over the PDF view.
  followElement(compact) {
    const now = this.player.video.currentTime;
    if (!this.follow) return el('button.rback', { text: compact ? tr('backToLectureShort') : tr('backToLecture'), onclick: () => this.resumeFollow() });
    const state = this.stale ? 'Stale' : this.deck.knownAt(now) ? '' : 'Unsure';
    return el('span.rfollowing', { text: tr('following' + state + (compact ? 'Short' : '')) });
  }
}

class SlidesPane {
  constructor(player, elem) {
    this.player = player;
    this.el = elem;
    this.visible = false;
    this.chapters = [];
    this.dirty = true;
    this.current = -1;
    this.cards = [];
    this.showChapters = false;
    this.d = new Disposer();
    this.reader = player.reader;
    this.deckBox = el('div.sdeck');
    this.readerBox = el('div.reader', { hidden: true });
    this.status = el('div.sstatus', { 'aria-live': 'polite' });
    this.chapToggle = el('button.chaptoggle', { hidden: true, onclick: () => { this.showChapters = !this.showChapters; this.render(); } });
    this.list = el('div.slist');
    this.screenBox = el('div.sscreen');
    elem.append(this.deckBox, this.readerBox, this.chapToggle, this.status, this.screenBox, this.list);
    this.buildReader();
    this.d.add(this.reader.onInfo(() => { if (this.visible) this.renderPageInfo(); }));
    this.d.listen(this.list, 'click', (e) => {
      const card = e.target.closest('.scard');
      if (card) this.player.seek(this.chapters[+card.dataset.i].start);
    });
  }

  get deck() { return this.reader.deck; }

  buildReader() {
    const r = this.readerBox;
    const stage = el('div.rstage');
    this.reader.addTarget('side', stage);
    this.stage = stage;
    this.prevBtn = el('button.rnav', { 'aria-label': tr('prevPage'), title: tr('prevPage'), text: '‹', onclick: () => this.reader.turn(-1) });
    this.nextBtn = el('button.rnav', { 'aria-label': tr('nextPage'), title: tr('nextPage'), text: '›', onclick: () => this.reader.turn(1) });
    this.pageLabel = el('span.rlabel');
    this.mainBtn = el('button.rmain', { onclick: () => this.player.setPdfMain(!this.player.prefs.pdfMain) });
    this.followBox = el('div.rfollow');
    this.timesBox = el('div.rtimes');
    this.fixBox = el('details.rfix');
    r.append(stage, el('div.rbar', null, this.prevBtn, this.pageLabel, this.nextBtn), this.mainBtn, this.followBox, this.timesBox, this.fixBox);
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

  // Which view the chapters and the reader use, and the choice of another one (the last
  // resort when the analysis guessed wrong). Shown with two or more views.
  renderScreen() {
    const box = this.screenBox;
    box.textContent = '';
    const a = this.player.slides;
    const sources = this.player.lesson.sources;
    if (!a || sources.length < 2) return;
    const how = a.manualScreen != null ? tr('screenChosen') : a.screenIndex == null ? '' : a.screenSure ? tr('screenFound') : tr('screenGuessed');
    box.append(el('span', { text: tr('screenView') }));
    sources.forEach((src, i) => {
      const on = src.index === a.screenIndex;
      box.append(el('button.sview' + (on ? '.on' : ''), { text: tr('viewN', { n: i + 1 }), 'aria-pressed': String(on), title: tr('screenUse', { n: i + 1 }),
        onclick: () => { if (!on || a.manualScreen == null) a.chooseScreen(src.index).catch((e) => log.warn('screen choice:', e)); } }));
    });
    if (how) box.append(el('span.sviewhow', { text: how }));
    if (a.manualScreen != null) box.append(el('button.link', { text: tr('screenAuto'), onclick: () => a.chooseScreen(null).catch((e) => log.warn('screen choice:', e)) }));
  }

  renderDeck() {
    const deck = this.player.deck;
    const box = this.deckBox;
    box.textContent = '';
    if (!deck) return;
    const input = el('input', { type: 'file', accept: '.pdf,application/pdf', multiple: true, hidden: true });
    // Failures are shown in this tab (deck.error).
    input.addEventListener('change', guard(() => { if (input.files.length) deck.addFiles(input.files).catch(() => {}); }));
    const files = el('div.sfiles');
    for (const f of deck.files) {
      files.append(el('span.sfile', null, el('span.sfname', { text: f.name, title: f.name }),
        el('button.sfremove', { title: tr('removeFile', { name: f.name }), 'aria-label': tr('removeFile', { name: f.name }), text: '✕', onclick: () => deck.removeFile(f.hash) })));
    }
    files.append(el('button.sfadd', { text: deck.files.length ? tr('addMoreSlides') : tr('addSlides'), onclick: () => input.click() }), input);
    let msg = '';
    if (deck.state === 'loading') msg = tr('deckLoading');
    else if (deck.state === 'reading') {
      const r = deck.ocr;
      msg = !r ? tr('deckWaiting')
        : r.state === 'reading' && !r.engineReady && r.stats.read === 0 ? tr('deckLangLoading', { lang: languageName(r.lang), mb: (TESS_LANGS[r.lang].bytes / 1e6).toFixed(1) })
          : tr('deckReading', { pct: Math.floor(deck.progress * 100) });
    }
    else if (deck.state === 'error') msg = deck.error;
    else if (!deck.files.length) msg = tr('slidesLocal');
    box.append(files);
    if (msg) box.append(el('div.sdmsg', { text: msg }));
  }

  render() {
    this.status.textContent = this.statusText || '';
    this.renderScreen();
    this.renderDeck();
    const deck = this.deck;
    this.readerBox.hidden = !deck;
    this.reader.setActive('side', this.visible && !!deck);
    this.chapToggle.hidden = !deck || !this.chapters.length;
    this.chapToggle.textContent = this.showChapters ? tr('hideChapters') : tr('showChapters', { n: this.chapters.length });
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
      const img = c.thumb ? el('img', { src: c.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : el('div.noimg');
      const card = el('button.scard', { 'data-i': String(i) },
        img,
        el('div.smeta', null,
          el('div.stitle', null, el('span.sn', { text: tr('slideN', { n: i + 1 }) }), el('span.st', { text: fmtTime(c.start, long) + (c.precise ? '' : ' ~') })),
          said ? el('div.ssaid', { text: said }) : null));
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
    this.mainBtn.textContent = this.player.prefs.pdfMain ? tr('pdfMainClose') : tr('pdfMainOpen');

    this.followBox.textContent = '';
    this.followBox.append(rd.followElement());

    const long = this.player.duration() >= 3600;
    const times = deck.timesOf(i);
    this.timesBox.textContent = '';
    if (times.length) {
      this.timesBox.append(el('span.rtl', { text: tr('shownAt') }));
      for (const r of times) this.timesBox.append(el('button.rtime', { text: fmtTime(r.start, long), onclick: () => { this.player.seek(r.start); rd.resumeFollow(); } }));
    } else if (deck.state === 'ready') {
      this.timesBox.append(el('span.rtl', { text: tr('notFoundInRecording') }));
    }

    // Correction for the part being played.
    const fixed = deck.correctionAt(this.player.video.currentTime);
    this.fixBox.textContent = '';
    this.fixBox.append(el('summary', { text: tr('wrongPage') }),
      el('button.rfixbtn', { text: tr('useThisPage', { n: p.num }), onclick: () => { deck.correct(this.player.video.currentTime, i); this.fixBox.open = false; rd.resumeFollow(); } }),
      el('button.rfixbtn', { text: tr('markNotSlide'), onclick: () => { deck.correct(this.player.video.currentTime, 'none'); this.fixBox.open = false; rd.resumeFollow(); } }));
    if (fixed) {
      this.fixBox.append(el('button.rfixbtn', { text: tr('undoCorrection'), onclick: () => { deck.correct(this.player.video.currentTime, null); this.fixBox.open = false; rd.resumeFollow(); } }));
    }
  }

  dispose() {
    this.reader.setActive('side', false);
    this.d.dispose();
  }
}

// ---- 66-slide-ocr.js ----
// ===================================================================================
// Reading the text on the screen view, for following the lecturer's slides (M7.5).
//
// Runs only while the recording has slide files. Every HLS segment starts with a keyframe;
// one keyframe every CHAPTER_STEP_SEC of the screen view is read at 720p (the smallest rendition at
// least that tall, or the tallest there is: text in 360p is not readable) and their text is
// recognised with Tesseract.js (pinned, from jsDelivr, loaded on first use).
//
// - A keyframe that looks like the previous one reuses its text: most of a lecture is the
//   same slide for many samples in a row. The comparison (at 160 x 90, see thumbChange)
//   uses the 360p keyframe (about 20 KB), taken from the slide analysis when it has it;
//   the 720p one (about 100 KB for a detailed screen) is only downloaded where something
//   changed.
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
// Language: chosen from the slide files' text (ocrLanguage); English data is about 3 MB,
// other languages 0.6 to 2.7 MB; each is downloaded when first needed (Tesseract.js then
// keeps it in the browser's storage), and the slides tab says which and how large while
// it loads.
// ===================================================================================

const TESS_BASE = 'https://cdn.jsdelivr.net/npm/';
const TESS_FILES = {
  lib: 'tesseract.js@7.0.0/dist/tesseract.esm.min.js',
  worker: 'tesseract.js@7.0.0/dist/worker.min.js',
  core: 'tesseract.js-core@7.0.0',
};
// Language data (pinned, from jsDelivr, 4.0.0_best_int): the scripts each one reads (the
// non-Latin ones read Latin letters too, for the English terms on such slides), the size
// of its download, and the language tag for its name. One language per engine: Tesseract.js
// loads every language of an engine from one place, and each is its own package.
const TESS_LANGS = {
  eng: { scripts: ['Latin'], bytes: 2952873, tag: 'en' },
  chi_sim: { scripts: ['Han', 'Latin'], bytes: 1718768, tag: 'zh-Hans' },
  chi_tra: { scripts: ['Han', 'Latin'], bytes: 1656239, tag: 'zh-Hant' },
  jpn: { scripts: ['Han', 'Latin'], bytes: 2030256, tag: 'ja' },
  kor: { scripts: ['Hangul', 'Latin'], bytes: 1572336, tag: 'ko' },
  rus: { scripts: ['Cyrillic', 'Latin'], bytes: 2679598, tag: 'ru' },
  ell: { scripts: ['Greek', 'Latin'], bytes: 1324749, tag: 'el' },
  ara: { scripts: ['Arabic', 'Latin'], bytes: 1661906, tag: 'ar' },
  heb: { scripts: ['Hebrew', 'Latin'], bytes: 580576, tag: 'he' },
  tha: { scripts: ['Thai', 'Latin'], bytes: 896631, tag: 'th' },
  hin: { scripts: ['Devanagari', 'Latin'], bytes: 1389692, tag: 'hi' },
};
const TESS_LANG_PATH = (lang) => TESS_BASE + '@tesseract.js-data/' + lang + '@1.0.0/4.0.0_best_int';

// Characters written differently in simplified and traditional Chinese (common ones, in
// matching order), to tell the two apart.
const HANS_ONLY = '\u8fd9\u4eec\u4e2a\u65f6\u6765\u4e3a\u8bf4\u56fd\u8fc7\u53d1\u540e\u4f1a\u5bf9\u5b66\u52a8\u5b9e\u73b0\u70b9\u7ecf\u5173\u5e94\u8fdb\u79cd\u673a\u6570\u636e\u53d8\u8ba1\u7535\u538b\u7ea7\u4ea7\u7ebf\u56fe\u5f53\u8fd8\u65e0\u4e48\u95ee\u9898\u957f\u95f4\u89c1';
const HANT_ONLY = '\u9019\u5011\u500b\u6642\u4f86\u70ba\u8aaa\u570b\u904e\u767c\u5f8c\u6703\u5c0d\u5b78\u52d5\u5be6\u73fe\u9ede\u7d93\u95dc\u61c9\u9032\u7a2e\u6a5f\u6578\u64da\u8b8a\u8a08\u96fb\u58d3\u7d1a\u7522\u7dda\u5716\u7576\u9084\u7121\u9ebc\u554f\u984c\u9577\u9593\u898b';

// The language to read the screen in, from the text of the slide files: the script most of
// their words are in (a Chinese or Japanese character counts as a word), English for Latin
// and for scripts without language data here. Japanese if a tenth or more of the Chinese
// characters are kana (Japanese prose is about a third or more kana, Chinese has none);
// simplified or traditional Chinese by which characters it uses.
function ocrLanguage(pageTexts) {
  const words = {};
  let kana = 0;
  let hans = 0;
  let hant = 0;
  for (const text of pageTexts) {
    for (const [w] of String(text || '').normalize('NFKC').matchAll(WORD_RE)) {
      if (/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u.test(w)) {
        words.Han = (words.Han || 0) + w.length;
        for (const ch of w) {
          if (/[\p{sc=Hiragana}\p{sc=Katakana}]/u.test(ch)) kana++;
          else if (HANS_ONLY.includes(ch) && !HANT_ONLY.includes(ch)) hans++;
          else if (HANT_ONLY.includes(ch) && !HANS_ONLY.includes(ch)) hant++;
        }
        continue;
      }
      const sc = WORD_SCRIPTS.find((x) => new RegExp('^\\p{sc=' + x + '}', 'u').test(w));
      if (sc) words[sc] = (words[sc] || 0) + 1;
    }
  }
  let top = 'Latin';
  for (const k of Object.keys(words)) if (words[k] > (words[top] || 0)) top = k;
  if (top === 'Han') return kana >= 0.1 * words.Han ? 'jpn' : hant > hans ? 'chi_tra' : 'chi_sim';
  return Object.keys(TESS_LANGS).find((l) => l !== 'eng' && TESS_LANGS[l].scripts[0] === top) || 'eng';
}

// The name of a language for messages ("Chinese (Simplified)"), in the page's language.
function languageName(lang) {
  const tag = (TESS_LANGS[lang] || TESS_LANGS.eng).tag;
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(tag) || tag; } catch (e) { return tag; }
}

const OCR_FAILED = -3;         // a sample whose keyframe could not be read

let tesseractPromise = null;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = import(TESS_BASE + TESS_FILES.lib).then((m) => m.default || m);
    tesseractPromise.catch(() => { tesseractPromise = null; });
  }
  return tesseractPromise;
}

class SlideTextReader {
  // opts: { lesson, video, source (the screen view), disposer, onChange }
  constructor(opts) {
    this.lesson = opts.lesson;
    this.video = opts.video;
    this.source = opts.source;
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('slide reader (display)', e); } };
    this.ac = new AbortController();
    opts.disposer.add(() => this.stop());
    this.gate = new BackgroundGate(this.video, this.ac.signal);
    this.reader = null;
    this.times = [];         // start of each sample
    this.picks = [];         // segment of each sample
    this.end = 0;            // end of the recording (of the last sample)
    this.texts = [];
    this.at = null;          // Int32Array: text index per sample, -1 = not read
    this.state = 'idle';     // idle | loading | reading | done | unavailable
    this.error = '';
    this.stats = { read: 0, same: 0, failed: 0, ms: 0, bytes: 0, wall: 0 };
    this.debug = store.get('debug', false) ? { changes: [] } : null;
    this.engine = null;
    this.shared = opts.shared || null;   // the slide analysis, if it shares its pictures
    this.lang = TESS_LANGS[opts.lang] ? opts.lang : 'eng';
    this.engineReady = false;
  }

  // The scripts this reader can read (for matching words, see slideWords).
  get scripts() { return TESS_LANGS[this.lang].scripts; }

  get key() { return 'ocr:' + this.lesson.mediaId + ':' + this.source.index + (this.lang === 'eng' ? '' : ':' + this.lang); }

  done() {
    return this.at ? this.at.reduce((n, x) => n + (x !== -1 ? 1 : 0), 0) : 0;
  }

  progress() {
    return this.at && this.at.length ? this.done() / this.at.length : 0;
  }

  start() {
    this.run().catch((e) => {
      if (this.ac.signal.aborted) return;
      log.warn('slide text:', e && e.message ? e.message : e);
      this.state = 'unavailable';
      this.error = String((e && e.message) || e);
      this.onChange();
    });
  }

  stop() {
    this.ac.abort();
    if (this.shared) this.shared.shareLumas(false);
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
    this.picks = this.reader.sampleSegments(CHAPTER_STEP_SEC);
    this.times = this.picks.map((i) => this.reader.segments[i].start);
    this.end = this.reader.duration;
    // The 360p keyframe of each sample: the probe's segment starting at the same time, or
    // the 720p one itself if the renditions are cut differently.
    this.probePicks = this.times.map((t) => this.probe.segmentAt(t + 0.01));
    if (this.probePicks.some((k, q) => Math.abs(this.probe.segments[k].start - this.times[q]) > 0.05)) { this.probe = this.reader; this.probePicks = this.picks; }
    const lumaOf = this.shared && this.shared.shareLumas(true, this.source) ? (t) => this.shared.lumaAt(t) : () => null;
    const n = this.times.length;
    const cached = this.lesson.mediaId ? await idbCache.get(this.key) : undefined;
    if (cacheValid('ocr', cached) && cached.height === this.reader.info.height && Array.isArray(cached.at) && cached.at.length === n) {
      cacheTouch(this.key);
      this.texts = cached.texts;
      this.at = Int32Array.from(cached.at);
      Object.assign(this.stats, cached.stats || {});
    } else {
      this.at = new Int32Array(n).fill(-1);
    }
    if (this.done() === n) { this.state = 'done'; if (this.shared) this.shared.shareLumas(false); this.onChange(); return; }
    this.state = 'reading';
    this.onChange();
    const canvas = new OffscreenCanvas(this.reader.info.width, this.reader.info.height);
    const g = canvas.getContext('2d');
    const small = new OffscreenCanvas(THUMB_W, THUMB_H).getContext('2d', { willReadFrequently: true });
    // The previous sample of this pass, and the thumbnail of the last one whose text was
    // read: changes are measured against that, so that slow changes (ink added a little at
    // a time) still add up.
    let prev = -1;
    let ref = null;
    const bytes = () => this.reader.bytes + (this.probe !== this.reader ? this.probe.bytes : 0);
    let unsaved = 0;
    let fails = 0;
    const t0 = performance.now();
    const wall0 = this.stats.wall;
    for (let i = this.next(); i >= 0; i = this.next()) {
      await this.gate.turn(OCR_PACE_MS[0], OCR_PACE_MS[1], BG_MIN_BUFFER_SEC);
      let thumb = lumaOf(this.times[i]);
      let full = false;
      const bytes0 = bytes();
      if (!thumb) {
        try {
          await this.probe.keyframe(this.probePicks[i], signal, (f) => { thumb = lumaThumb(small, f); });
        } catch (e) {
          if (signal.aborted) throw e;
        }
      }
      const change = thumb && prev === i - 1 && ref ? thumbChange(ref, thumb) : -1;
      const same = change >= 0 && change < SAME_TEXT_MAX;
      if (this.debug) this.debug.changes[i] = change;
      if (thumb && !same) {
        try {
          await this.reader.keyframe(this.picks[i], signal, (f) => { g.drawImage(f, 0, 0, canvas.width, canvas.height); full = true; });
        } catch (e) {
          if (signal.aborted) throw e;
        }
      }
      this.stats.bytes += bytes() - bytes0;
      if (!thumb || (!same && !full)) {
        this.at[i] = OCR_FAILED;
        this.stats.failed++;
        ref = null;
        // Several in a row (network gone): stop and keep what was read; the next visit
        // continues, retrying these.
        if (++fails >= ANALYSIS_MAX_FAILS) { this.save(); throw new Error('keyframes cannot be read'); }
      } else if (same) {
        fails = 0;
        this.at[i] = this.at[i - 1];
        this.stats.same++;
      } else {
        fails = 0;
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
    if (this.shared) this.shared.shareLumas(false);
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
    const here = Math.max(0, sampleIndexAt(this.times, this.video.currentTime || 0));
    for (let i = here; i < at.length; i++) if (at[i] === -1) return i;
    for (let i = 0; i < here; i++) if (at[i] === -1) return i;
    return -1;
  }

  async recognize(blob) {
    // Never start the engine (a Worker with tens of MB of WASM and language data) once
    // reading has been stopped; one that finishes starting after a stop is ended at once.
    if (this.ac.signal.aborted) throw new Error('aborted');
    if (!this.engine) {
      const signal = this.ac.signal;
      this.engine = loadTesseract().then((T) => T.createWorker(this.lang, 1, {
        workerPath: TESS_BASE + TESS_FILES.worker,
        corePath: TESS_BASE + TESS_FILES.core,
        langPath: TESS_LANG_PATH(this.lang),
      })).then((w) => {
        if (signal.aborted) { w.terminate(); throw new Error('aborted'); }
        this.engineReady = true;
        this.onChange();
        return w;
      });
      this.engine.catch(() => { this.engine = null; });
    }
    const w = await this.engine;
    if (this.ac.signal.aborted) throw new Error('aborted');
    return String((await w.recognize(blob)).data.text || '');
  }

  save() {
    if (!this.lesson.mediaId || !this.at) return;
    // Samples that could not be read are stored as unread, so the next visit tries them again.
    const at = Array.from(this.at, (x) => (x === OCR_FAILED ? -1 : x));
    idbCache.put(this.key, { v: cacheVersion('ocr'), used: Date.now(), screen: this.source.index, height: this.reader.info.height, texts: this.texts, at, stats: this.stats, savedAt: Date.now() });
  }
}

// ---- 67-slide-text.js ----
// ===================================================================================
// Which page of the lecturer's slide files is on screen, from the text on screen.
//
// Pure functions on strings and numbers (the reading of the screen is in 66-slide-ocr.js).
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

// Words of a text, in the scripts that text recognition can read (`scripts`, script
// names as in Unicode, 'Han' for Chinese and Japanese; Latin when not given): a word in
// another script (Greek letters of a formula in a PDF, when reading English) can only be on
// a page, never on screen, and would only blur the comparison.
// - runs of letters (and digits after them) of one script, in lower case: a change of
//   script inside a "word" is a formula (jωL) or recognition noise, not a word;
// - accents on Latin, Greek and Cyrillic letters dropped (text recognition often misses
//   them; the slide file has them), and compatibility forms unified (the "fi" ligature and
//   the maths italic letters of a PDF are plain letters);
// - words of three or more characters: shorter pieces are mostly recognition noise (two
//   capitals such as AI or ML were tried as words and cost a tenth of the pages on a
//   circuits lecture, where text recognition makes many of them out of drawings);
// - Chinese and Japanese text has no spaces: every two neighbouring characters are a word
//   (a lone character is one);
// - common English words (SLIDE_STOP) are left out; in other languages common words weigh
//   little anyway, being on many pages and pictures.
const WORD_SCRIPTS = ['Latin', 'Greek', 'Cyrillic', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Thai', 'Lao', 'Khmer', 'Myanmar', 'Hangul',
  'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Ethiopic'];
const WORD_RE = new RegExp('[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}]+|'
  + WORD_SCRIPTS.map((x) => '\\p{sc=' + x + '}[\\p{sc=' + x + '}\\p{M}\\p{N}]*').join('|') + '|\\p{L}[\\p{L}\\p{M}\\p{N}]*', 'gu');
function slideWords(text, scripts) {
  const key = (scripts || ['Latin']).join(',');
  if (!slideWords.allowed || slideWords.allowed.key !== key) {
    slideWords.allowed = new RegExp('^(?:' + key.split(',').map((x) => (x === 'Han' ? '[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}]' : '\\p{sc=' + x + '}')).join('|') + ')', 'u');
    slideWords.allowed.key = key;
  }
  const allowed = slideWords.allowed;
  const s = String(text || '').normalize('NFKD').replace(/([\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}])\p{M}+/gu, '$1').normalize('NFKC');
  const out = [];
  for (const [w] of s.matchAll(WORD_RE)) {
    if (!allowed.test(w)) continue;
    if (/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
      continue;
    }
    const l = w.toLowerCase();
    if (w.length >= 3 && !SLIDE_STOP.has(l)) out.push(l);
  }
  return out;
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
function textScores(pageTexts, frameTexts, scripts) {
  const P = pageTexts.length;
  const F = frameTexts.length;
  const pdf = new Map();
  const pageBags = pageTexts.map((t) => {
    const b = wordBag(slideWords(t, scripts));
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
  const allBags = frameTexts.map((t, f) => { const ws = slideWords(t, scripts); raw[f] = ws.length; return wordBag(ws); });
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
function pageSimilarity(pageTexts, scripts) {
  const r = textScores(pageTexts, pageTexts, scripts);
  return r.scores;
}

// ---- evidence ----

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
    return { mean, sd: Math.max(Math.sqrt(Math.max(0, sxx / (sw || 1) - mean * mean)), EVIDENCE_MIN_SD), w: sw };
  };
  const pdf = (d, x) => Math.exp(-0.5 * ((x - d.mean) / d.sd) ** 2) / d.sd;
  const fit2 = (xs, ws) => [fit(xs, ws, 0), fit(xs, ws, 1)];
  const pdf2 = (m, x) => pdf(m[0], x[0]) * pdf(m[1], x[1]);
  let wrong = fit2(second);
  let right = [{ mean: Math.max(0, ...best.map((x) => x[0])), sd: 0.1 }, { mean: Math.max(0, ...best.map((x) => x[1])), sd: 0.1 }];
  let share = 0.5;
  const resp = new Float64Array(best.length);
  const ones = second.map(() => 1);
  for (let it = 0; it < EVIDENCE_EM_ROUNDS && best.length; it++) {
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
      const v = share > 0 ? Math.log(pdf(r, x)) - Math.log(pdf(q, x)) : EVIDENCE_FLOOR;
      g[i] = Math.max(i ? g[i - 1] : -Infinity, isFinite(v) ? v : EVIDENCE_FLOOR);
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

// Moves between two pictures in a row: SLIDE_MOVES (02-tuning.js).

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
// distinct picture read), at: [per sample: index into texts, -1 = not read yet],
// force: [per sample: page, FORCE_OFF or -1] (optional), scripts: what text recognition
// reads (see slideWords; optional) }.
// Returns { pages: Int32Array per sample (page index, -1 = not a slide, -2 = not read yet),
// model }.
function followLecture(input) {
  const P = input.pageTexts.length;
  const at = input.at;
  const force = input.force || [];
  const out = new Int32Array(at.length).fill(-2);
  if (!P || !input.texts.length) return { pages: out, model: null };
  const ts = textScores(input.pageTexts, input.texts, input.scripts);
  const model = scoreModel(ts, pageSimilarity(input.pageTexts, input.scripts));
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
    + 'const WORD_RE = new RegExp(' + JSON.stringify(WORD_RE.source) + ', ' + JSON.stringify(WORD_RE.flags) + ');\n'
    + 'const SLIDE_MOVES = ' + JSON.stringify(SLIDE_MOVES) + ';\n'
    + 'const EVIDENCE_GRID = ' + EVIDENCE_GRID + ';\n'
    + 'const EVIDENCE_MIN_SD = ' + EVIDENCE_MIN_SD + ';\n'
    + 'const EVIDENCE_FLOOR = ' + EVIDENCE_FLOOR + ';\n'
    + 'const EVIDENCE_EM_ROUNDS = ' + EVIDENCE_EM_ROUNDS + ';\n'
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
    // Closed with the player: never start a new Worker afterwards.
    if (this.closed) return Promise.reject(new Error('closed'));
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
    this.closed = true;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error('closed'));
    this.waiting.clear();
  }
}

// ---- 68-slide-deck.js ----
// ===================================================================================
// The lecturer's slide files (PDF) for a recording: loading, local storage, following the
// lecture, and the user's corrections.
//
// The PDF is the user's: they can page through it freely and remove it at any time.
// Following the lecture only turns the page for them until they take over.
//
// Which page is on screen comes from the text on the screen view, every CHAPTER_STEP_SEC
// across the lecture: 66-slide-ocr.js reads it, 67-slide-text.js decides the pages (in a Worker).
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

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_BASE + 'pdf.min.mjs');
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

// pdf.js's worker for one controller: a module worker from a blob that imports the pinned
// worker script (a cross-origin worker URL cannot be used directly). Ended by its owner.
function makePdfWorker(lib) {
  const url = URL.createObjectURL(new Blob(['import "' + PDFJS_BASE + 'pdf.worker.min.mjs";'], { type: 'text/javascript' }));
  const port = new Worker(url, { type: 'module' });
  URL.revokeObjectURL(url);
  return { port, pdf: new lib.PDFWorker({ port }) };
}

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The page's title: the largest text in the top PAGE_TITLE_TOP of the page.
function pageTitle(items, pageHeight) {
  let size = 0;
  for (const it of items) if (it.str.trim() && it.transform[5] > pageHeight * (1 - PAGE_TITLE_TOP)) size = Math.max(size, it.height);
  if (!size) return '';
  return items.filter((it) => it.str.trim() && it.transform[5] > pageHeight * (1 - PAGE_TITLE_TOP) && Math.abs(it.height - size) < 1)
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
  // Without an end, the last sample lasts as long as the one before it.
  const tEnd = end == null ? (n ? times[n - 1] + (n > 1 ? times[n - 1] - times[n - 2] : 0) : 0) : end;
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
    // The listener redraws the player; an error there is a display problem, reported as
    // such, not a failure of the analysis (which keeps its results and goes on).
    const onChange = opts.onChange || (() => {});
    this.onChange = () => { try { onChange(); } catch (e) { reportFeatureError('slide reader (display)', e); } };
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
    this.rendered = new Map(); // page index -> canvas (newest size), least recently used first
    this.pdfWorker = null;     // pdf.js worker (makePdfWorker), owned here
    this.d.add(() => this.closeDocs());
  }

  get key() { return 'deck:' + this.lesson.mediaId; }

  get progress() { return this.ocr ? this.ocr.progress() : 0; }

  // Closes the open documents (through their loading tasks, which own them in pdf.js), and
  // pdf.js's worker when no document is left to use it.
  closeDocs(keepWorker) {
    for (const task of this.docs) task.destroy().catch(() => {});
    this.docs = [];
    this.rendered.clear();
    if (!keepWorker && this.pdfWorker) {
      try { this.pdfWorker.pdf.destroy(); } catch (e) { /* ignore */ }
      this.pdfWorker.port.terminate();
      this.pdfWorker = null;
    }
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
      // The file must really be stored (a full disk would otherwise lose it silently on
      // the next visit); the reference list changes in one transaction (another tab may
      // add or remove the same file at the same time).
      try {
        await idbCache.putStrict('deckfile:' + hash, new Blob([buf], { type: 'application/pdf' }));
        const mid = this.lesson.mediaId;
        await idbCache.update('deckref:' + hash, (refs) => (Array.isArray(refs) ? (refs.includes(mid) ? refs : refs.concat(mid)) : [mid]));
      } catch (e) {
        this.state = 'error';
        this.error = tr('deckSaveFailed', { name: f.name, msg: (e && e.message) || e });
        this.onChange();
        throw e;
      }
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
    // In one transaction: drop this recording from the file's users and, if it was the
    // last one, the file itself (no other tab can add itself in between).
    const mid = this.lesson.mediaId;
    await idbCache.tx('readwrite', (os) => {
      const req = os.get('deckref:' + hash);
      req.onsuccess = () => {
        const refs = (Array.isArray(req.result) ? req.result : []).filter((m) => m !== mid);
        if (refs.length) os.put(refs, 'deckref:' + hash);
        else { os.delete('deckref:' + hash); os.delete('deckfile:' + hash); }
      };
      return req;
    }).catch((e) => log.warn('slide file removal:', e));
    await this.reload();
  }

  // Opens all files and reads the pages' titles and text, then follows the lecture.
  async reload() {
    const job = {};
    this.job = job;
    this.again = false; // a pending recompute was for the old files
    this.closeDocs(this.files.length > 0);
    this.pages = [];
    this.decided = null;
    this.shown = null;
    if (!this.files.length) {
      this.stopReading();
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
        if (!this.pdfWorker) this.pdfWorker = makePdfWorker(lib);
        const task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), worker: this.pdfWorker.pdf });
        const doc = await task.promise;
        // Replaced by a newer load, or the player is gone: this document is not kept.
        if (this.job !== job || this.ac.signal.aborted) { task.destroy().catch(() => {}); return; }
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
      // Files in another language need the screen read again in that language.
      if (this.ocr && this.ocr.lang !== ocrLanguage(pages.map((x) => x.text))) this.stopReading();
      this.startReading();
      this.decide(true);
      this.onChange();
    } catch (e) {
      if (this.ac.signal.aborted || this.job !== job) return;
      log.warn('slide file:', e && e.message ? e.message : e);
      this.state = 'error';
      this.error = tr('deckError', { msg: String((e && e.message) || e) });
      this.onChange();
    }
  }

  // Starts reading the screen once it is known which view that is (from the slide
  // analysis; a recording with one view uses that one).
  startReading() {
    if (this.ocr || !this.pages.length) return;
    const sources = this.lesson.sources;
    // The screen view; if the analysis could not tell clearly, its best guess.
    const a = this.slides;
    const idx = a && a.screenIndex != null ? a.screenIndex : a && a.guessScreen != null ? a.guessScreen : sources.length === 1 ? sources[0].index : null;
    if (idx == null) return;
    const source = sources.find((s) => s.index === idx);
    if (!source) return;
    // Owned by its own child of the controller: stopping it (files removed) releases it
    // and its texts, instead of keeping it referenced until the page closes.
    this.ocrD = this.d.child();
    this.ocr = new SlideTextReader({
      lesson: this.lesson, video: this.video, source, disposer: this.ocrD, shared: a || null,
      lang: ocrLanguage(this.pages.map((x) => x.text)),
      onChange: () => this.readingChanged(),
    });
    this.ocr.start();
  }

  stopReading() {
    if (this.ocrD) this.ocrD.dispose();
    this.ocrD = null;
    this.ocr = null;
  }

  // Called when the slide analysis changes (the screen view becomes known, or the user
  // chose another view: reading starts again there).
  screenKnown() {
    const a = this.slides;
    if (this.ocr && a && a.screenIndex != null && this.ocr.source.index !== a.screenIndex) this.stopReading();
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
      scripts: r.scripts,
    };
    const job = this.job;
    this.deciding = this.worker.run(input).then((res) => {
      if (this.job !== job) return;
      this.decided = res.pages;
      this.recompute();
      if (store.get('debug', false)) this.lastModel = res.model;
      this.onChange();
    }).catch((e) => {
      if (!this.ac.signal.aborted) log.warn('slide following:', e && e.message ? e.message : e);
    }).finally(() => {
      this.deciding = null;
      if (this.again && !this.ac.signal.aborted) { this.again = false; this.decide(true); }
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
    this.shown = r && this.decided ? followSamples(r.times, this.decided, FOLLOW_MIN_SEC, this.lesson.duration || r.end || undefined) : null;
  }

  // Page i rendered `width` pixels wide. Kept for reuse within a pixel budget (pages can
  // be 4096 pixels wide when zoomed in): only the newest size of each page, and the least
  // recently used pages go first.
  async render(i, width) {
    const w = Math.round(width);
    const hit = this.rendered.get(i);
    if (hit && hit.width === w) {
      this.rendered.delete(i);
      this.rendered.set(i, hit);
      return hit;
    }
    const page = await this.pages[i].doc.getPage(this.pages[i].num);
    const c = await renderPdfPage(page, width);
    this.rendered.delete(i);
    this.rendered.set(i, c);
    let px = 0;
    for (const x of this.rendered.values()) px += x.width * x.height;
    for (const [k, x] of this.rendered) {
      if (px <= DECK_RENDER_BUDGET || k === i) break;
      px -= x.width * x.height;
      x.width = 0; // releases the canvas memory now
      this.rendered.delete(k);
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
    return Math.max(0, sampleIndexAt(r.times, t));
  }

  // Page to show at time t while following (-1 when nothing is known yet). Samples are
  // CHAPTER_STEP_SEC apart; when the page changes between two of them and the slide analysis found
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
    const end = (j) => (j + 1 < times.length ? times[j + 1] : this.lesson.duration || this.ocr.end);
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
    return { a: times[a], b: b + 1 < times.length ? times[b + 1] : this.lesson.duration || this.ocr.end };
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

// ---- 70-cpufix.js ----
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
    log.warn('cpu-fix part "' + part + '" disabled after an error', err);
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
    const elem = document.createElement('style');
    elem.setAttribute('data-echo360-lite-cpu-fix', '');
    document.head.appendChild(elem);
    own.sheet = elem.sheet;
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
    for (const elem of document.querySelectorAll('body, body *')) {
      const c = elem._reactRootContainer;
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
      const elem = document.querySelector('style[data-styled-version]');
      const ver = elem && elem.getAttribute('data-styled-version');
      if (ver && !/^4\./.test(ver)) { clearInterval(timer); log.info('cpu-fix inactive: styled-components ' + ver); return; }
      if (ver) {
        try {
          const { gsProto, csProto } = scan();
          if (gsProto && !state.gs) { patchGlobalStyle(gsProto); state.gs = true; }
          if (csProto && !state.cs) { patchComponentStyle(csProto); state.cs = true; }
        } catch (e) { clearInterval(timer); log.warn('cpu-fix scan failed', e); return; }
      }
      if (state.gs && state.cs) {
        state.throttleOn = true;
        clearInterval(timer);
        log.info('cpu-fix active on the original player');
      } else if (Date.now() - t0 > 60000) {
        clearInterval(timer);
        log.info('cpu-fix inactive: player internals not found');
      }
    }, 1000);
  }

  return { start, state };
})();

// ---- 80-course-list.js ----
// ===================================================================================
// Course page (/section/<id>/home): a small progress bar next to each recording.
//
// It shows two things at once, each only when known:
//   - filled stretches: what was watched on this device (52-watched.js), with the share in
//     words (an empty ending, black screen and silence, does not count);
//   - a tick: where Echo360 says you stopped last time (any device), from the player's
//     properties (one request per opened recording, a few at a time).
// A tooltip says which is which. Light by design: nothing on the page is moved or replaced,
// one small element is added to each lesson row (again if the list is redrawn). Anything
// that fails is skipped without a word.
// ===================================================================================

const courseList = {
  matches() {
    return /(^|\.)echo360\.[a-z.]+$/.test(location.hostname) && /^\/section\/[^/]+\/home/.test(location.pathname);
  },

  start() {
    let section = location.pathname.split('/')[2];
    const known = new Map();   // lessonId -> label info (null while loading)
    let server = null;         // promise of { lessonId: { mediaId, read } } from the syllabus
    const style = document.createElement('style');
    style.textContent = '.e3l-watch{display:inline-flex;align-items:center;gap:6px;margin-left:12px;font-size:12px;line-height:18px;'
      + 'vertical-align:middle;color:#1d6b4f;white-space:nowrap}'
      + '.e3l-bar{position:relative;width:72px;height:6px;border-radius:3px;background:#e2e8f0;overflow:hidden}'
      + '.e3l-bar i{position:absolute;top:0;bottom:0;background:#2f855a}'
      + '.e3l-bar b{position:absolute;top:-1px;bottom:-1px;width:2px;margin-left:-1px;background:#2d3748}'
      + '.e3l-watch.e3l-done{color:#22543d;font-weight:600}.e3l-watch .e3l-last{color:#4a5568}';

    const syllabus = () => {
      if (!server) {
        server = fetch('/section/' + encodeURIComponent(section) + '/syllabus', { credentials: 'include', headers: { Accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            const out = {};
            for (const x of (j && j.data) || []) {
              const l = x.lesson;
              const m = l && l.medias && l.medias[0];
              if (l && l.lesson && m) out[l.lesson.id] = { mediaId: m.id, read: !!m.isRead };
            }
            return out;
          })
          .catch(() => ({}));
      }
      return server;
    };

    const queue = [];
    let running = 0;
    const pump = () => {
      while (running < LIST_CONCURRENT && queue.length) {
        const job = queue.shift();
        running++;
        job().catch(() => {}).finally(() => { running--; setTimeout(pump, LIST_GAP_MS); });
      }
    };

    const label = (row, info) => {
      const host = row.querySelector('.header-details') || row.querySelector('header') || row;
      let elem = host.querySelector('.e3l-watch');
      if (!info) { if (elem) elem.remove(); return; }
      if (!elem) { elem = document.createElement('span'); host.append(elem); }
      elem.textContent = '';
      const bar = document.createElement('span');
      bar.className = 'e3l-bar';
      const dur = info.dur;
      const tips = [];
      if (info.ranges) {
        for (const [a, b] of info.ranges) {
          const i = document.createElement('i');
          i.style.left = ((Math.max(0, a) / dur) * 100).toFixed(2) + '%';
          i.style.width = (((Math.min(b, dur) - Math.max(0, a)) / dur) * 100).toFixed(2) + '%';
          bar.append(i);
        }
      }
      if (info.last != null) {
        const b = document.createElement('b');
        b.style.left = Math.min(100, (info.last / dur) * 100).toFixed(2) + '%';
        bar.append(b);
      }
      elem.append(bar);
      const txt = document.createElement('span');
      if (info.ranges) {
        const pct = Math.max(1, Math.round(info.share * 100)); // never "0%" for something watched
        txt.textContent = tr('listWatched', { pct });
        tips.push(tr('listWatchedTitle', { pct }));
        elem.className = 'e3l-watch' + (pct >= LIST_DONE_PCT ? ' e3l-done' : '');
      } else {
        txt.textContent = tr('listLastAt', { time: fmtTime(info.last) });
        txt.className = 'e3l-last';
        elem.className = 'e3l-watch';
      }
      if (info.last != null) tips.push(tr('listLastAtTitle', { time: fmtTime(info.last) }));
      elem.append(txt);
      elem.title = tips.join('; ');
    };

    // { dur, ranges, share } from this device and/or { last } from Echo360; null if neither.
    const lookup = async (lid) => {
      const rec = await idbCache.get('watched:' + lid);
      const out = {};
      if (rec && rec.d > 0 && Array.isArray(rec.r) && rec.r.length) {
        out.dur = rec.d;
        out.ranges = rec.r;
        out.share = watchedShare(rec);
      }
      const s = (await syllabus())[lid];
      if (s && s.read) {
        try {
          const r = await fetch('/api/ui/echoplayer/lessons/' + encodeURIComponent(lid) + '/media/' + encodeURIComponent(s.mediaId) + '/player-properties',
            { credentials: 'include', headers: { Accept: 'application/json' } });
          if (r.ok) {
            const d = (await r.json()).data || {};
            const dur = parseIsoDuration(d.playableAudioVideo && d.playableAudioVideo.duration);
            if (dur > 0 && d.lastPlayedToSeconds > 0) { out.last = d.lastPlayedToSeconds; if (!out.dur) out.dur = dur; }
          }
        } catch (e) { /* no tick */ }
      }
      return out.dur ? out : null;
    };

    const scan = () => {
      // The site can move to another course without loading a new page: start over.
      const now = /^\/section\/([^/]+)\/home/.exec(location.pathname);
      if (!now) return;
      if (now[1] !== section) { section = now[1]; known.clear(); server = null; }
      for (const row of document.querySelectorAll('.class-row[data-test-lessonid]')) {
        const lid = row.getAttribute('data-test-lessonid');
        // Rows drawn again lose the label; a row that has it is left alone (labelling is
        // itself a change the observer sees).
        if (known.has(lid)) { if (known.get(lid) && !row.querySelector('.e3l-watch')) label(row, known.get(lid)); continue; }
        known.set(lid, null);
        queue.push(() => lookup(lid).then((info) => {
          known.set(lid, info);
          for (const r of document.querySelectorAll('.class-row[data-test-lessonid="' + lid.replace(/"/g, '') + '"]')) label(r, info);
        }));
      }
      pump();
    };

    let pending = 0;
    const observe = () => {
      document.head.append(style);
      scan();
      // The list is drawn by the page's own script and redrawn on sorting or filtering.
      new MutationObserver(() => {
        if (pending) return;
        pending = setTimeout(() => { pending = 0; scan(); }, LIST_DEBOUNCE_MS);
      }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true }); else observe();
  },
};

// ---- 85-export.js ----
// ===================================================================================
// Export and backup.
//
// Export: a recording's notes and bookmarks (with their local tags) as Markdown, each with
// a link back to that moment (the lesson page with #t=<seconds>, which this player
// honours). With a slide PDF, the page on screen at each note can go along as a picture;
// the Markdown and the pictures are packed in a zip (for Obsidian and similar). A whole
// course exports one Markdown file per recording (without pictures). Exports never contain
// the video or its address.
//
// Backup: everything that only exists in this browser (tags and which items carry them,
// slide files and their corrections, what was watched, settings and positions), optionally
// with the PDF files, in one JSON file that can be restored in another browser. Analysis
// caches (slides, silence, text on screen) are left out: they are rebuilt.
// ===================================================================================

// ---- zip (stored, no compression: the pictures are PNG already) ----

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Uint8Array }] -> Blob (application/zip). Names are UTF-8.
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);          // UTF-8 names
    head.setUint16(8, 0, true);               // stored
    head.setUint16(10, dosTime, true);
    head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, f.data.length, true);
    head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true);
    parts.push(head.buffer, name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((s, x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---- Markdown ----

function safeName(s) {
  return String(s || 'lecture').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'lecture';
}

// A tag as a Markdown / Obsidian tag: no spaces or punctuation.
function mdTag(name) {
  const s = String(name).trim().replace(/[\s,.;:!?'"()[\]{}#]+/g, '-').replace(/^-+|-+$/g, '');
  return s ? '#' + s : '';
}

function mdEscape(s) {
  return String(s || '').replace(/\r/g, '').replace(/\n/g, '  \n  ');
}

// lec: { title, date (YYYY-MM-DD or ''), url (lesson page), items: [note/bookmark],
// tagsOf(id) -> [{ name }], picture(item) -> relative path or null }
function lectureMarkdown(lec) {
  const long = lec.items.some((x) => x.time >= 3600);
  const lines = ['# ' + lec.title, ''];
  const meta = [lec.date ? tr('mdRecorded', { date: lec.date }) : null, lec.url ? '[' + tr('mdOpen') + '](' + lec.url + ')' : null].filter(Boolean);
  if (meta.length) lines.push(meta.join(' · '), '');
  const items = lec.items.filter((x) => x.type === 'note' || x.type === 'bookmark');
  if (!items.length) lines.push('_' + tr('mdNothing') + '_');
  for (const x of items) {
    const when = x.time != null ? '[' + fmtTime(x.time, long) + '](' + lec.url + '#t=' + Math.floor(x.time) + ')' : tr('mdNoTime');
    const tags = lec.tagsOf(x.id).map((g) => mdTag(g.name)).filter(Boolean).join(' ');
    const body = x.type === 'note' ? mdEscape(x.text) : '🔖 ' + tr('markerBookmark');
    lines.push('- **' + when + '** ' + body + (tags ? ' ' + tags : ''));
    const pic = lec.picture ? lec.picture(x) : null;
    if (pic) lines.push('  ', '  ![](' + encodeURI(pic).replace(/\(/g, '%28').replace(/\)/g, '%29') + ')');
  }
  lines.push('', '_' + tr('mdFooter', { date: new Date().toISOString().slice(0, 10) }) + '_', '');
  return lines.join('\n');
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// Date of a lesson from its id (G_..._2026-09-15T16:05:00.000_...), '' if none.
function lessonDate(lessonId) {
  const m = /_(\d{4}-\d{2}-\d{2})T/.exec(String(lessonId || ''));
  return m ? m[1] : '';
}

function lessonPageUrl(lessonId) {
  return location.origin + '/lesson/' + seg(lessonId) + '/classroom';
}

class Exporter {
  constructor(player) {
    this.p = player;
  }

  // This recording; with `pictures`, the slide page at each note (needs a slide PDF).
  async lecture(pictures) {
    const p = this.p;
    const l = p.lesson;
    const items = p.notes ? p.notes.items.filter((x) => x.type !== 'flag') : [];
    const base = (lessonDate(l.lessonId) ? lessonDate(l.lessonId) + ' ' : '') + safeName(l.title);
    const files = [];
    const pics = new Map();   // page index -> file name
    let picture = null;
    const deck = p.deck;
    if (pictures && deck && deck.pages.length) {
      for (const x of items) {
        if (x.time == null) continue;
        const i = deck.pageAt(x.time);
        if (i < 0 || pics.has(i)) continue;
        const pg = deck.pages[i];
        const name = base + '/' + safeName(pg.file.replace(/\.pdf$/i, '')) + ' p' + pg.num + '.png';
        const c = await deck.render(i, 1600);
        const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
        files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
        pics.set(i, name);
      }
      picture = (x) => (x.time == null ? null : pics.get(deck.pageAt(x.time)) || null);
    }
    const md = lectureMarkdown({
      title: l.title, date: lessonDate(l.lessonId), url: lessonPageUrl(l.lessonId), items,
      tagsOf: (id) => (p.tags ? p.tags.of(id) : []), picture,
    });
    const mdBytes = new TextEncoder().encode(md);
    if (!files.length) { downloadBlob(new Blob([mdBytes], { type: 'text/markdown' }), base + '.md'); return { notes: items.length, pictures: 0 }; }
    files.unshift({ name: base + '.md', data: mdBytes });
    downloadBlob(makeZip(files), base + '.zip');
    return { notes: items.length, pictures: files.length - 1 };
  }

  // Every recording of the course with notes or bookmarks, one Markdown file each.
  async course(onProgress) {
    const p = this.p;
    const section = p.lesson.sectionId;
    if (!section) throw new Error('no course');
    const r = await fetch('/section/' + encodeURIComponent(section) + '/syllabus', { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = ((await r.json()).data || []).map((x) => x.lesson).filter((x) => x && x.lesson && x.hasVideo);
    const files = [];
    const tagStore = new TagStore({ sectionId: section, mediaId: null });
    await tagStore.load();
    for (let k = 0; k < list.length; k++) {
      const x = list[k];
      if (onProgress) onProgress(k, list.length);
      const lid = x.lesson.id;
      const mid = x.medias && x.medias[0] && x.medias[0].id;
      let items = [];
      try { items = await new Echo360Api({ lessonId: lid, mediaId: mid }).notes(); } catch (e) { continue; }
      if (!items.length) continue;
      const map = mid ? (await idbCache.get('tagmap:' + mid)) || {} : {};
      const tagsOf = (id) => tagStore.tags.filter((g) => (map[id] || []).includes(g.id));
      items.sort((a, b) => (a.time == null ? -1 : a.time) - (b.time == null ? -1 : b.time));
      const title = x.lesson.name || x.medias[0].title || lid;
      const md = lectureMarkdown({ title, date: lessonDate(lid), url: lessonPageUrl(lid), items, tagsOf });
      files.push({ name: (lessonDate(lid) ? lessonDate(lid) + ' ' : '') + safeName(title) + '.md', data: new TextEncoder().encode(md) });
    }
    if (!files.length) return 0;
    // Same names (two recordings on one day with one title): number them.
    const seen = new Map();
    for (const f of files) { const n = seen.get(f.name) || 0; seen.set(f.name, n + 1); if (n) f.name = f.name.replace(/\.md$/, ' (' + (n + 1) + ').md'); }
    downloadBlob(makeZip(files), safeName(p.lesson.courseName || 'course') + ' notes.zip');
    return files.length;
  }
}

// ---- backup ----

const BACKUP_KEYS = /^(tags|tagmap|deck|deckref|watched|screenpick):/;

// The shape each restored IndexedDB entry must have (anything else is skipped, so a
// damaged backup cannot plant data that breaks a later visit).
const isStr = (x) => typeof x === 'string' && x.length < 2000;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const BACKUP_DB_SHAPES = {
  tags: (v) => v && Array.isArray(v.tags) && v.tags.every((g) => g && isStr(g.id) && isStr(g.name) && isStr(g.color)),
  tagmap: (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((a) => Array.isArray(a) && a.every(isStr)),
  deck: (v) => v && Array.isArray(v.files) && v.files.every((f) => f && isStr(f.hash) && isStr(f.name))
    && (v.fixes == null || (Array.isArray(v.fixes) && v.fixes.every((x) => x && isNum(x.a) && isNum(x.b) && isStr(String(x.page))))),
  deckref: (v) => Array.isArray(v) && v.every(isStr),
  watched: (v) => v && isNum(v.d) && Array.isArray(v.r) && v.r.every((x) => Array.isArray(x) && x.length === 2 && isNum(x[0]) && isNum(x[1])) && (v.e == null || isNum(v.e)),
  deckfile: (v) => v instanceof Blob,
  screenpick: (v) => v && isNum(v.index),
};

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function makeBackup(withPdfs) {
  const out = { app: 'echo360-lite', v: 1, created: new Date().toISOString(), local: {}, db: {} };
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const key = k && k.startsWith(NS) ? k.slice(NS.length) : null;
    if (key && BACKUP_LOCAL.some((x) => x.match(key))) out.local[key] = localStorage.getItem(k);
  }
  for (const k of await idbCache.keys()) {
    const key = String(k);
    const pdf = key.startsWith('deckfile:');
    if (!BACKUP_KEYS.test(key) && !(pdf && withPdfs)) continue;
    const v = await idbCache.get(key);
    out.db[key] = v instanceof Blob ? { $blob: await blobToBase64(v), type: v.type } : v;
  }
  return out;
}

// Restores a backup: its entries replace the ones with the same keys. Everything is checked
// first; the IndexedDB entries are then written in one transaction (all or none), and only
// then the settings. Returns the number of entries written.
async function restoreBackup(data, db = idbCache) {
  if (!data || data.app !== 'echo360-lite' || data.v !== 1 || !data.db || typeof data.db !== 'object') throw new Error(tr('backupInvalid'));
  // Settings and positions: only known keys, each validated like the player does (a
  // damaged value becomes the default instead of breaking every later visit).
  const local = [];
  for (const [k, v] of Object.entries(data.local && typeof data.local === 'object' ? data.local : {})) {
    const rule = BACKUP_LOCAL.find((x) => x.match(k));
    if (!rule) continue;
    let parsed = null;
    try { parsed = JSON.parse(v); } catch (e) { parsed = null; }
    const clean = rule.clean(parsed);
    if (clean != null) local.push([k, clean]);
  }
  const entries = [];
  for (const [k, v] of Object.entries(data.db)) {
    if (!BACKUP_KEYS.test(k) && !k.startsWith('deckfile:')) continue;
    let val = v;
    if (v && typeof v === 'object' && typeof v.$blob === 'string') {
      const bin = atob(v.$blob);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      val = new Blob([bytes], { type: v.type || 'application/octet-stream' });
    }
    const shape = BACKUP_DB_SHAPES[k.split(':')[0]];
    if (shape && shape(val)) entries.push([k, val]);
  }
  await db.putMany(entries);
  let n = entries.length;
  for (const [k, clean] of local) {
    try { localStorage.setItem(NS + k, JSON.stringify(clean)); n++; } catch (e) { /* storage full */ }
  }
  return n;
}

// ---- 86-diagnostics.js ----
// ===================================================================================
// "Copy diagnostics": a plain-text summary to paste into a bug report. It names versions,
// the state of each feature and recent warnings and errors. It never contains credentials,
// cookies, addresses (all URLs are masked), user names, notes or discussion text; the user
// sees the exact text before copying it.
// ===================================================================================

function browserName() {
  const ua = navigator.userAgent;
  const m = /(Edg|OPR|Firefox|Chrome|Version)\/(\d+)/.exec(ua);
  const name = !m ? 'unknown' : m[1] === 'Edg' ? 'Edge' : m[1] === 'OPR' ? 'Opera' : m[1] === 'Version' ? 'Safari' : m[1];
  return name + (m ? ' ' + m[2] : '') + ' on ' + (/(Windows|Mac OS X|Linux|Android|iPhone|iPad|CrOS)/.exec(ua) || ['', 'unknown'])[1];
}

function scriptManager() {
  try {
    if (typeof GM_info !== 'undefined' && GM_info) return (GM_info.scriptHandler || 'userscript manager') + ' ' + (GM_info.version || '');
  } catch (e) { /* not available */ }
  return 'unknown (or development)';
}

function maskUrls(s) {
  return String(s).replace(/(https?:)?\/\/[^\s'")]+/g, '<address>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => id.slice(0, 8) + '…');
}

function diagnosticsText(p) {
  const v = p.video;
  const q = (st) => (st && st.hls && st.hls.levels && st.hls.levels.length ? st.height + 'p of ' + Math.max(...st.hls.levels.map((l) => l.height)) + 'p' : '-');
  const lines = [];
  const add = (k, val) => lines.push(k + ': ' + val);
  add('Echo360 Lite', VERSION);
  add('Browser', browserName());
  add('Script manager', scriptManager());
  add('Page', location.hostname + ' (lesson page)');
  add('Recording', (p.lesson.mediaId ? String(p.lesson.mediaId).slice(0, 8) + '…' : '-') + ', ' + p.sources.length + ' view(s), ' + fmtTime(p.duration(), true));
  add('Playback', (v.paused ? 'paused' : 'playing') + ' at ' + fmtTime(v.currentTime, true) + ', speed ' + v.playbackRate + ', layout ' + p.layout
    + (p.pdfMode ? ' (PDF view)' : '') + ', quality ' + q(p.clock) + ' / ' + q(p.follower)
    + (p.fvideo && !p.fvideo.paused ? ', sync ' + Math.round((p.fvideo.currentTime - v.currentTime) * 1000) + ' ms' : ''));
  const s = p.silence;
  if (s) add('Silence detection', (s.source || '-') + (s.reason ? ' (' + s.reason + ')' : '') + ', ' + (s.silences ? s.silences.length : 0) + ' found');
  const a = p.slides;
  if (a) add('Slide chapters', a.state + ', ' + a.chapters.length + ' chapters, screen view ' + (a.screenIndex == null ? 'unknown' : a.screenIndex));
  const d = p.deck;
  if (d) {
    const r = d.ocr;
    add('Slide reader', d.state + ', ' + d.files.length + ' file(s), ' + d.pages.length + ' pages'
      + (r ? ', text on screen: ' + r.state + ', ' + Math.round(r.progress() * 100) + '% (read ' + r.stats.read + ', same ' + r.stats.same + ', failed ' + r.stats.failed + ')' : ''));
  }
  if (p.session) add('Session renewal', p.session.failed ? 'gave up (' + (p.session.failed.login ? 'sign-in expired' : 'failed') + ')' : 'ok, ' + p.session.renewals + ' renewal(s)');
  add('Notes', p.notesReady ? 'loaded' : 'not available');
  add('Audio tools', p.audio ? Object.entries(p.audio.settings || {}).filter(([, on]) => on).map(([k]) => k).join(', ') || 'off' : '-');
  add('Features turned off after an error', [...featureErrors.seen].join(', ') || 'none');
  lines.push('', 'Recent warnings and errors:');
  if (!eventLog.length) lines.push('  none');
  for (const e of eventLog) lines.push('  ' + e.t + ' ' + e.level + ' ' + maskUrls(e.text));
  return lines.join('\n');
}

// ---- 90-main.js ----
// ===================================================================================
// Bootstrap
// ===================================================================================

(function main() {
  // Rejections nobody handled: logged when they come from this script (the page's own are
  // not ours to report). Never a fallback.
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    const stack = String((r && r.stack) || '');
    if (/echo360[ -]lite/i.test(stack)) { log.warn('unhandled rejection', r); logEvent('warn', 'unhandled rejection: ' + ((r && r.message) || r)); }
  });
  if (courseList.matches()) { try { courseList.start(); } catch (e) { /* the page works without it */ } return; }
  const adapter = ADAPTERS.find((a) => { try { return a.matches(); } catch (e) { return false; } });
  if (!adapter) return;

  let booted = false;
  let player = null;

  // Hands the page to the original player. Each step is protected: an exception here would
  // otherwise travel into the page's own start-up code.
  function startOriginal(callOriginal, arg, why) {
    if (player) { try { player.destroy(); } catch (e) { log.error('cleanup failed:', e); } player = null; }
    try { callOriginal(arg); } catch (e) { log.error('original player failed to start:', e); }
    try { cpuFix.start(); } catch (e) { log.warn('cpu fix failed:', e); }
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
      // Checked before anything is built: without a way to play HLS, the original player.
      if (!canPlayHls()) throw new Error('this browser cannot play HLS here (hls.js missing and no native HLS)');
      player = new LitePlayer(lesson, {
        fetchCues: adapter.fetchCues ? (l) => adapter.fetchCues(l) : null,
        api: adapter.api ? (l) => adapter.api(l) : null,
        onFallback(reason) {
          log.info('switching to the original player (' + reason + ')');
          let handoff = arg;
          try { if (player) handoff = adapter.withStartTime(arg, player.video.currentTime); } catch (e) { /* keep original arg */ }
          startOriginal(callOriginal, handoff, null);
        },
      });
      if (store.get('debug', false)) { window.__echo360LitePlayer = player; window.__echo360LiteDev = { HlsVideoReader, frameLuma, thumbChange, learnThreshold }; } // development only
      // Any unexpected error in our handlers from now on: hand the page to the original player.
      unexpected.handler = () => {
        if (!player) return;
        let handoff = arg;
        try { handoff = adapter.withStartTime(arg, player.video.currentTime); } catch (e) { /* keep original arg */ }
        startOriginal(callOriginal, handoff, tr('errorNotice'));
      };
      console.info(TAG, 'v' + VERSION + ' active (' + adapter.id + ', ' + lesson.sources.length + ' sources, reporting '
        + (lesson.analytics ? 'on' : 'off') + ')');
    } catch (e) {
      log.warn('could not start, using the original player:', e);
      startOriginal(callOriginal, arg, tr('fallbackNotice'));
    }
    return undefined;
  });

  // If the page never calls the bootstrap we trapped (Echo360 changed how it starts), the
  // original player runs untouched: apply the CPU fix and say so once. A slow page may still
  // start late, so the notice waits until the original player is visibly there (a video on
  // the page), checking again for up to half a minute.
  window.addEventListener('load', () => {
    let tries = 0;
    const check = () => {
      if (booted) return;
      if (!document.querySelector('video') && ++tries < 4) { setTimeout(check, BOOT_CHECK_MS); return; }
      log.info('player bootstrap not seen; leaving the original player in place');
      cpuFix.start();
      notice(tr('fallbackNotice'));
    };
    setTimeout(check, BOOT_CHECK_MS);
  });
})();

})();
