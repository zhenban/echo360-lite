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
