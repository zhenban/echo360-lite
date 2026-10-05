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
