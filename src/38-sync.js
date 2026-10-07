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
