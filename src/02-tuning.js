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

// ---- background work (53-media-io.js BackgroundGate) ----
// Background downloads wait until playback has this much buffered ahead: two thirds of what
// the player itself keeps (STREAM_MAX_BUFFER_SEC), so they never take bandwidth playback
// is waiting for. Pauses between steps are in milliseconds, [while playing, while paused].
const BG_MIN_BUFFER_SEC = 20;
const BG_START_DELAY_MS = 5000;        // before an analysis starts its downloads: playback starts first

// ---- slide chapters (56-slides.js) ----
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

// ---- reading the screen (58-slide-ocr.js) ----
// Text recognition reads the smallest rendition at least this tall (or the tallest):
// slide text in 360p is not readable, 720p reads body text of slides shown full screen.
const OCR_HEIGHT = 720;
const OCR_PACE_MS = [200, 0];          // between samples; while playing a reading also rests as long as it took
const OCR_SAVE_EVERY = 10;             // readings between cache writes

// ---- which slide is on screen (58-slide-text.js) ----
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

// ---- following the slides (59-slide-deck.js) ----
// A look at another page shorter than this (one sample) between two stretches of the same
// page does not turn the page.
const FOLLOW_MIN_SEC = 1.5 * CHAPTER_STEP_SEC;
const FOLLOW_STALE_SEC = 120;          // after this long without a recognised page, the reader says so (a product choice)
const FOLLOW_UPDATE_MS = 15000;        // while reading, pages are decided again at most this often (each run takes 0.1-1 s)
const DECK_RENDER_BUDGET = 40e6;       // rendered pages kept, in pixels (about 160 MB at 4 bytes a pixel)
const PAGE_TITLE_TOP = 0.4;            // a page's title is the largest text in this top share of the page
const PAGE_AR_DEFAULT = 9 / 16;        // height / width of a page not opened yet (slides are mostly 16:9)

// ---- silence (54-silence.js) ----
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

// ---- audio processing (52-audio.js) ----
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
