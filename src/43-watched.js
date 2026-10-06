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

  save(duration) {
    if (!this.key || !this.ready || !(duration > 0)) return;
    const r = this.ranges().map(([a, b]) => [Math.floor(a), Math.ceil(b)]);
    if (!r.length) return;
    idbCache.put(this.key, { d: Math.round(duration), r, at: Date.now() });
  }
}

// Share of a recording watched (0..1) from a stored record.
function watchedShare(rec) {
  if (!rec || !(rec.d > 0) || !Array.isArray(rec.r)) return 0;
  let s = 0;
  for (const [a, b] of rec.r) s += Math.max(0, Math.min(b, rec.d) - Math.max(a, 0));
  return Math.min(1, s / rec.d);
}
