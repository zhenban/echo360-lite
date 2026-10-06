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
