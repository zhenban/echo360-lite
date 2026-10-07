# Echo360 Lite: code quality review

- Scope: `src/` (32 modules, about 7,900 lines), `build.mjs`, `test/unit.test.mjs`, version 0.11.1 (commit `48ca63b`).
- Method: every source file was read in full. All conclusions come from the code alone, not from the author's intent or development notes.
- This review **did not change any source code**. I also ran `node build.mjs`: the output is byte-identical to the committed `dist/` (the build is reproducible). `node --test test/unit.test.mjs` passes all 27 tests (about 19 s).
- Each finding is labelled with a confidence level:
  - **Confirmed**: the trigger path follows completely from the code.
  - **Likely**: the trigger path holds, but depends on specific browser or server behaviour and should be reproduced once in a real browser.

Severity: 🔴 critical (page unusable or user data lost) · 🟠 high (a feature fails or resources leak, noticeable to users) · 🟡 medium (edge cases, latent hazards) · ⚪ low (tidiness and readability)

---

## 0. The 10 issues to handle first

| # | Severity | Location | Summary |
|---|---|---|---|
| E1 | 🔴 | `90-main.js` / `40-player.js` `LitePlayer` constructor | If the constructor throws halfway, the player UI, timers and network work it already created are never cleaned up; the leftover UI covers the original player |
| E2 | 🔴 | `40-player.js` `loadClock` + `store.get('prefs')` | Corrupt local settings, or invalid values written by a backup restore (e.g. `rate: "x"`), make the constructor throw on every page load; combined with E1 the page breaks every time |
| S1 | 🟠 | `40-player.js:815` and `:1239`, `$('.pclose')` | Two different buttons share the class `pclose`: the side panel's close button never responds, and the PDF bar's ✕ triggers two actions at once (**confirmed functional bug**) |
| C1 | 🟠 | `48-discussion.js` `post`/`submit`, `47-notes.js` `addNote` | Ctrl+Enter can submit twice: **a public discussion post can be published twice** |
| L1 | 🟠 | `36-session.js` `renew().finally` | Falling back to the original player while a renewal is in flight schedules a new timer; the lesson page is then fetched in the background every hour, forever |
| L2 | 🟠 | `58-slide-ocr.js` `recognize` | A race between stopping and creating the Tesseract engine can leave a Worker (with its large WASM) that is never terminated |
| E3 | 🟠 | `00-util.js` `guard`, as an overall policy | A synchronous exception in a minor feature replaces the whole player with the original one; asynchronous exceptions vanish silently. One reaction is too heavy, the other too light |
| E5 | 🟠 | `56-slides.js` `fromKeyframes`, `54-silence.js` `runAudio` | A single bad segment aborts the whole analysis and discards what was already computed |
| L4 | 🟠 | `59-slide-deck.js` `rendered` cache | Limited by entry count (6) but not by size; each canvas can be 4096 px wide, so memory can reach hundreds of MB |
| T1 | 🟠 | `test/` | `adapter.parse`/`intercept` (which decide between taking over and falling back) and the player's creation and teardown have no tests at all; none of the three hand-labelled data files in `test/fixtures/` is used by any test |

---

## 1. Error handling

### E1 🔴 A failed construction leaves a half-built player behind (confirmed)
- **Location**: `90-main.js:28`, `player = new LitePlayer(...)`; `40-player.js`, `LitePlayer.constructor` (lines 28–112)
- **Problem**: the constructor first runs `buildDom()`, which appends the host element to `document.body` and sets `documentElement.style.overflow = 'hidden'`. It then creates a `SessionKeeper` (starts a timer, writes the global `mediaSession`) and two `Stream`s, binds dozens of listeners, and only at the end calls `setupSilence/Slides/Deck/loadCues/loadInteractions/setupAudio/loadClock`. If any of these steps throws, the `new` expression fails and `player` stays `null`. The `catch` in `main` then calls `startOriginal`, whose `if (player) player.destroy()` does nothing, so `this.d` (the Disposer) is never disposed.
- **Real paths that throw**:
  - `Stream.load()` **throws on purpose** when neither MSE nor native HLS is available (`35-stream.js`), for example when the `@require`d hls.js was blocked (`HlsLib` is `undefined`) on a browser without native HLS (desktop Chrome/Firefox). This is the very last step of the constructor, so everything before it already exists.
  - Invalid settings (see E2).
  - `attachShadow`, `ResizeObserver`, `OffscreenCanvas` and similar APIs missing in some environments.
- **Consequence**: a full-screen black player with no video covers the original player and page scrolling is locked. Background timers (renewal, stall watchdog, settings saving) keep running and requests already sent (session check, transcript, notes) complete. The user sees "the script broke the page", which is the opposite of the README's promise of automatic fallback.
- **Fix**:
  1. Wrap construction in try/catch and dispose before rethrowing:
     ```js
     constructor(lesson, opts) {
       this.d = new Disposer();
       try { this.init(lesson, opts); } catch (e) { this.destroyed = true; this.d.dispose(); throw e; }
     }
     ```
  2. Or run the checks that can fail (playback capability, valid settings) before `buildDom()`.
  3. Move the capability check out of `Stream.load` to right after `adapter.parse`, before the player is created.

### E2 🔴 Corrupt settings break the player on every visit (confirmed)
- **Location**: `40-player.js` constructor, `Object.assign(defaults, store.get('prefs', {}))`; `loadClock()` line 207, `v.defaultPlaybackRate = this.prefs.rate`; `85-export.js`, `restoreBackup()`
- **Problem**: the constructor validates only `layout/corner/capSize/silence/quality`. `rate, volume, ratio, pipw, panelw, audio, copySpan` are used as they are. `HTMLMediaElement.playbackRate/defaultPlaybackRate/volume` throw a `TypeError` for non-finite values (NaN). `restoreBackup()` writes any string from the backup's `local` section straight into localStorage without checking its shape.
- **Consequence**: one bad restore (or a future version changing the settings format) turns `prefs.rate` into a non-number. From then on every lesson page throws in `loadClock` and ends up in the state described in E1. The only way out is clearing localStorage by hand, which the user does not know to do.
- **Fix**: a single `sanitizePrefs(raw)` that checks type and range of every field and falls back to the default for invalid ones; `restoreBackup` goes through the same validation (or accepts only known keys). As a last resort in the constructor, discard the whole settings object when parsing or validation fails.

### E3 🟠 Blast radius of `guard()`: all-or-nothing fallback, plus silently swallowed async errors
- **Location**: `00-util.js` `guard/reportUnexpected`; `90-main.js` `unexpected.handler`; `46-sidebar.js` `h()`, where every `on*` callback goes through `guard`
- **Problem**:
  1. **Too heavy**: every synchronous callback registered through `Disposer.listen/interval/timeout` or `h({onclick})` that throws destroys the whole player and swaps in the original one. That includes optional features: tag management, the export panel, the A-B loop, zoom, the PDF reader, the silence menu. A bug in a tag colour button can throw a user out of the lecture they are watching. The position is kept, but the side panel, note drafts and the PDF view are gone.
  2. **Too light**: `guard` only catches synchronous exceptions. Many callbacks are `async` functions or return Promises, for example `h('button', { onclick: (e) => this.addNote(e) })`, the `this.notes.tagHere(e)` and `this.togglePopout()` calls in `onKey`, and the `.then(...)` chains in `loadCues/loadInteractions` (no `.catch`). Errors there become unhandled rejections; the feature stops half-way without any message.
- **Consequence**: the same kind of bug causes a full fallback in synchronous code and silent damage in asynchronous code. The behaviour depends on how a line happened to be written.
- **Fix**: two levels.
  - Only errors in **core playback** (Stream, clock video events, layout) fall back to the original player.
  - **Feature modules** are wrapped in `featureGuard(name, fn)`: on error, only that feature is turned off, with a console log and a single notice.
  - Add `guardAsync(fn)`, which returns `fn(...).catch(report)`, and use it for every async callback.
  - Optionally register a log-only `unhandledrejection` listener in `main` to catch places that were missed.

### E4 🟠 Analyzers call `onChange` synchronously inside their own Promise chains, so UI errors are reported as analysis failures
- **Location**: `54-silence.js` `SilenceAnalyzer.start/runAudio/fail`; `56-slides.js` `SlideAnalyzer.start/run`; `58-slide-ocr.js` `SlideTextReader.run`; `59-slide-deck.js` `readingChanged → decide → onChange`
- **Problem**: analyzers call `this.onChange()` in the middle of their loops, and that callback runs the player's render functions (`renderSilences`, `onSlidesChange`, `applyLayout`, `reader.update`, ...). If a render function throws, the analyzer's `.catch` treats it as an analysis failure: silence analysis goes to `fail('error')` and clears its results, chapter detection becomes `unavailable`, OCR becomes `unavailable`. `SilenceAnalyzer.fail()` calls `onChange()` again inside the catch; if that throws again, it is an unhandled rejection.
- **Consequence**: a UI rendering bug makes the user believe "no silences / chapters were found in this lecture", and the console error points at the wrong module.
- **Fix**: analyzers notify through an `emit()` helper: `try { this.onChange(); } catch (e) { console.error(TAG, 'onChange', e); }`. Or make notifications asynchronous (`queueMicrotask` / `FrameTask`) so they are decoupled from the computation.

### E5 🟠 One bad segment aborts the whole analysis and discards partial results (confirmed)
- **Location**:
  - `56-slides.js` `fromKeyframes`: `reader.keyframe(i)` in the loop has no per-item try/catch. A segment that does not start with a keyframe, a single 404, or a decode error aborts the whole pass.
  - `56-slides.js` `fromThumbnailsAsync`: one failed thumbnail drops all thumbnail chapters.
  - `54-silence.js` `runAudio`: one failed `decodeAudioData` chunk calls `fail('error')` and sets `silences = []`, although the envelope already filled in is still in memory (and the last `save` already wrote it to the cache); it just stops being used.
- **Contrast**: `58-slide-ocr.js` tolerates per-sample failures (`OCR_FAILED`), so the problem is known but only handled in one module.
- **Fix**: per-segment try/catch that records the failure and skips the segment, giving up only after N consecutive failures. On an error in silence analysis, keep the existing results (`recompute()` instead of `fail()`).

### E6 🟡 Failed OCR samples are cached permanently and never retried
- **Location**: `58-slide-ocr.js:176`, `this.at[i] = OCR_FAILED`; `next()` only picks samples that are `=== -1`; `save()` writes the result to IndexedDB
- **Consequence**: one transient network glitch or 403 leaves that 10-second stretch without text forever, across visits. PDF following can only infer that part from its neighbours.
- **Fix**: write `OCR_FAILED` back as `-1` when caching, or keep a failure count and retry once on the next visit.

### E7 🟡 The IndexedDB wrapper swallows every error, and a failed open is cached forever
- **Location**: `53-media-io.js`, `idbCache.open/get/put/del/keys`
- **Problem**:
  1. A failed `put` (e.g. quota exceeded when adding a large PDF) resolves to `undefined`. `await idbCache.put('deckfile:'+hash, …)` in `addFiles` looks successful and the file is recorded in `files`, but on the next `reload()` `get` returns nothing, the code `continue`s, and the PDF silently disappears.
  2. `open()` stores the rejected Promise in `this.db`; every later call returns the same rejection, so IndexedDB stays unusable for the lifetime of the page with no retry.
  3. No `onblocked` / `onversionchange` handling: after a future schema version bump, an old connection open in another tab blocks the upgrade.
- **Fix**: `put` should at least `console.warn`; critical writes (PDFs, backup restore) should use a variant that throws and tell the user. Clear `this.db` when `open` fails. Add `db.onversionchange = () => db.close()`.

### E8 🟡 An exception half-way through `togglePopout` makes the player vanish from the page
- **Location**: `40-player.js:666–711`
- **Problem**: `this.host.replaceWith(holder)` has already taken the player out of the main page before `doc.body.append(this.host)` runs and before `pagehide` is registered. If anything in between throws (after `requestWindow` succeeded), the host is in no document and no `pagehide` handler exists. As this is an async function, the error does not go through guard and no fallback happens.
- **Consequence**: the main page only shows the "playing in the floating window" placeholder; "Back" closes the window, but no `pagehide` handler puts the player back.
- **Fix**: register `pagehide` before moving the element, or wrap the move in try/catch and on failure `holder.replaceWith(this.host)` and close the window.

### E9 ⚪ Other error-handling details
- `20-reporter.js`: every reporting request ends in `.catch(() => {})` with no record at all. Watch reporting may feed attendance statistics; at least `console.debug` it in debug mode.
- `90-main.js` `startOriginal`: an exception from `callOriginal` or `cpuFix.start` propagates through `launcher` into the page's own bootstrap code, with unpredictable results. Wrap it in try/catch.
- `90-main.js` 8-second fallback timer: when `booted` is false it shows "could not take over". If the page calls its bootstrap after more than 8 seconds, the user first sees the fallback notice and then the lite player starts anyway, so the notice is wrong.
- `85-export.js` `restoreBackup`: entries are written one by one, so a failure half-way leaves a mix of new and old data, and the returned count does not include failed entries.

---

## 2. Resources and lifecycle

> Note: the code has **no path that switches recordings within one page**. Every recording is a full page load, `LitePlayer` is created once, and `courseList` and the player are mutually exclusive. Lifecycle issues therefore fall into two scenarios: (a) whether `destroy()` cleans up completely when falling back to the original player; (b) reloads inside the page, such as reloading the clock stream when swapping views in the single layout, or rebuilding documents and OCR when PDFs are added or removed.

Overall: the `Disposer` + `AbortController` + `BackgroundGate` design is sound, and the vast majority of listeners, timers and observers are managed by it. The items below are gaps in that mechanism.

### L1 🟠 `SessionKeeper` reschedules itself after dispose (confirmed)
- **Location**: `36-session.js`, constructor `this.d.add(() => clearTimeout(this.timer))`; `renew()` line 74, `.finally(() => { …; if (!this.failed) this.schedule(); })`; the retry `setTimeout` in `attempt()`
- **Problem**: dispose only clears the timer that exists at that moment. If a renewal is in flight (fetching, or waiting for the 2 s / 5 s retry), its `finally` calls `schedule()` afterwards and creates a new, unowned timer. When that fires it calls `renew()`, which calls `schedule()` again, and so on: the lesson page is fetched every hour for the rest of the page's life.
- **Consequence**: after falling back to the original player, the background keeps hitting Echo360 on a schedule, on top of the original player's own renewal. Nothing in the UI can stop it.
- **Fix**: add a `this.disposed` flag, `d.add(() => { this.disposed = true; clearTimeout(this.timer); })`; check it at the start of `schedule()` and `attempt()`; make the retry wait abortable (like `BackgroundGate.wait`).

### L2 🟠 The OCR engine can still be created after stop (likely)
- **Location**: `58-slide-ocr.js`, `stop()` and `recognize()` (line 219 on)
- **Problem**: `stop()` calls `ac.abort()`, terminates `this.engine` if it exists, and sets it to `null`. But the `run()` loop may be awaiting `canvas.convertToBlob(...)`. When it resumes it calls `recognize(blob)`, sees `this.engine === null` and **creates** a new Tesseract Worker, and only then checks `aborted` and throws. Nobody terminates that new Worker.
- **Trigger**: removing the last PDF while OCR is reading (`reload()` → `ocr.stop()`), or falling back to the original player.
- **Consequence**: a Worker with WASM and the English language data loaded (tens of MB) stays alive until the page closes.
- **Fix**: check `this.ac.signal.aborted` at the start of `recognize()`; have `stop()` set `this.stopped = true` and never create an engine afterwards; or check in `engine.then` and terminate immediately if already stopped.

### L3 🟠 The pdf.js Worker is a module-level singleton and is never terminated
- **Location**: `59-slide-deck.js:32`, `loadPdfJs()`, `lib.GlobalWorkerOptions.workerPort = new Worker(...)`
- **Problem**: the Worker hangs off the module-level `pdfjsPromise`; `SlideDeckController`'s dispose only calls `closeDocs()`. It survives falling back to the original player and removing all PDFs.
- **Fix**: give `SlideDeckController` ownership of the Worker and `terminate()` it on dispose, or terminate it in `closeDocs()` when no documents are left.

### L4 🟠 The render cache is limited by count only, so memory can get large
- **Location**: `59-slide-deck.js:29`, `DECK_RENDER_CACHE = 6`, `render()`; `57-slides-pane.js` `drawInto()` (width up to `4096 * dpr * sharp`, capped at 4096)
- **Problem**: the cache key is `index@width`. Resizing the window, dragging the divider and changing the zoom level (`sharp` up to 4) all create new keys. A 4096×2304 canvas is about 37 MB, so 6 of them exceed 200 MB. Eviction is FIFO, not LRU. Each `drawInto` also creates another canvas of the same size on the page for the cross-fade.
- **Fix**: a budget in total pixels (e.g. 40 Mpx); keep only the latest width per page; a real LRU (delete then set on a hit).

### L5 🟡 On fallback, the floating window's (Document PiP) `pagehide` may put the destroyed UI back on the page (likely, needs verification)
- **Location**: `40-player.js`, the `pagehide` handler in `togglePopout`; in `bindControls`, `d.add(() => { if (this.popout) this.popout.close(); })`
- **Problem**: the Disposer runs in reverse registration order, so `popout.close()` runs before `host.remove()`. If the window's `pagehide` fires **asynchronously**, it runs after `host.remove()`, and `holder.replaceWith(this.host)` puts the destroyed player UI back on the main page, over the original player. If it fires synchronously, there is no problem.
- **Fix**: start the `pagehide` handler with `if (this.destroyed) { holder.remove(); return; }`, and remove `holder` explicitly on dispose.

### L6 🟡 Listeners and references that only ever grow
- `57-slides-pane.js` `SlideReader.onInfo()`: add-only, no removal; `SlidesPane.dispose` does not unregister its listener.
- `59-slide-deck.js` `startReading()`: each new `SlideTextReader` adds a closure to the **player's** Disposer (`opts.disposer.add(() => this.stop())`). If the user removes and adds PDFs repeatedly, old readers and their `texts`/`at` arrays stay referenced until the page closes. Give each reader a `d.child()` and dispose it when stopping.
- `56-slides.js` `thumbUrl()`: the `urlOf: Map<Blob, url>` and the `urls` array only grow. `applyScenes` runs every 30 segments; thumbnail Blobs that are no longer used after chapters change stay referenced by the Map until dispose.
- `35-stream.js`, in the `MEDIA_ATTACHED` handler: `v.addEventListener('loadedmetadata', …, {once:true})` is not managed by the Disposer. If the view is swapped before it fires (the hls instance is destroyed and a new source loads), it runs when the new source loads, jumps back to the old `r.t` and forces playback.
- Stray timers outside the Disposer: `ABLoop.timer`, the `setTimeout(() => dragged=false)` in `Zoomer`, the fade-out timer in `drawInto`, the 3-second countdown of the note and discussion delete buttons, the focus timer in `renderReplyComposer`, `TranscriptPanel.searchTimer` (this one is cleared). Each matters little, but `ABLoop.timer` is guarded and still touches `this.p` if it fires after the player was destroyed.

### L7 🟡 IndexedDB is written but never pruned
- **Location**: `slides:<mediaId>` (with JPEG thumbnail Blobs), `ocr:<mediaId>:<idx>`, `silence-env:<mediaId>` (about 72 KB for 2 hours), `watched:`, `deckfile:`
- **Problem**: no expiry or eviction. With a dozen courses and hundreds of recordings per semester, chapter thumbnails alone can reach hundreds of MB. Cache versions are all hard-coded as `v: 1`, unrelated to the algorithm parameters (see H5).
- **Fix**: give every record an `at` field (some have one) and asynchronously prune analysis caches not used for N days at startup; offer a "clear analysis caches" button.

### L8 ⚪ Long-lived resources that need no cleanup but are worth noting
- `80-course-list.js`: a `MutationObserver` on the whole `document.body` subtree is never disconnected. Acceptable for a long-lived course page, but if the site navigates in-page (SPA) to another course, the `section` in the closure is stale and `known` is never cleared.
- `60-cpufix.js`: permanently patches styled-components prototypes and adds a capture-phase `timeupdate` listener on `window`. This is by design.
- `20-reporter.js` registers a `beforeunload` listener, which keeps the page out of the bfcache in some browsers (Firefox). `pagehide` alone is enough.
- `90-main.js`: with debug on, `window.__echo360LitePlayer` still references the player after it was destroyed.

---

## 3. Hard-coded values

Most of the constants below carry comments such as "measured on a real lecture" or "tuned offline". In other words, they were **fitted to a few samples**, there is no regression data protecting them, and they may stop working for another university, another course or another recording setup.

### H1 🟠 "HLS segment = 10 seconds" is assumed in many places
- `54-silence.js` `CHUNK_SEGMENTS = 6` (comment: "6 x 10 s HLS segments"); `chunkAt()` also assumes all segments have the same length
- `56-slides.js` `applyScenes` uses `samples[last].t + 10`; the whole chapter resolution ("10 s resolution") and the refinement step are built on segments of about 10 s
- `59-slide-deck.js` `followSamples` (`times[n-1] + 10`), `timesOf`, `partAt` (`times[b] + 10`)
- `58-slide-ocr.js`: one reading per segment, so shorter segments mean more OCR work (5× as much with 2 s segments)
- **Consequence**: with 2/4/6-second segments elsewhere, silence chunks are only 12–36 s with many more requests, chapter and OCR costs multiply, and end-time estimates drift.
- **Fix**: read the actual `#EXT-X-TARGETDURATION` or the mean segment length from the playlist, and define chunk sizes in seconds (e.g. 60 s per chunk), not in numbers of segments.

### H2 🟠 Frame comparison thresholds (chapter detection)
- `56-slides.js` `sameView`: `changed < 0.16 || mad <= 8 || (corr >= 0.9 && mad <= 20)`, commented "Measured on a real lecture"
- `sameViewStrict`: `0.06 / 6`; the per-pixel change threshold `> 40` in `frameDistance`
- `flatShare`: neighbouring brightness difference `<= 3` (at 160×90); `SCREEN_CLEARLY = 0.75`; "at least 3 of 6 thumbnails readable"
- `SCENE_MIN_SEC = 20`, `SCENE_REVISIT_SEC = 180`, `SCENE_DETOUR_SEC = 60`
- `KEYFRAME_PROBE_BYTES = 24 KB` (based on a 360p keyframe of about 17 KB); `smallBitmap` hard-codes 16:9
- **Risks**: dark-theme slides, handwriting or tablet screens (lots of ink), slides with embedded video, 4:3 screens, a camera pointed at a whiteboard (high "flatness", may be mistaken for the screen view).
- **Fix**: collect these parameters in one `SLIDE_TUNING` object with a note on which lectures they were tuned on. Most importantly, wire the labelled data in `test/fixtures` into the tests (see T2) so that changing a threshold shows its effect on accuracy.

### H3 🟠 OCR and text matching only work for English and Latin script
- `58-slide-ocr.js`: Tesseract loads only `eng`; `OCR_HEIGHT = 720`, `OCR_PIXEL_DIFF = 24`, `OCR_SAME_MAX = 12` (comment: estimated from "the smallest readable slide text" at 720p) are hard-coded
- `58-slide-text.js` `slideWords`: `/[a-z][a-z0-9]{2,}/g` drops Chinese, Japanese, Greek letters, accented letters and two-letter abbreviations ("AI", "ML"). The stop-word list is English too.
- The transition probabilities in `SLIDE_MOVES` (0.45/0.30/0.05/0.04/0.01/0.15...), `EVIDENCE_GRID = 101`, the `-25` cap, 200 EM iterations and the 0.01 minimum standard deviation are all set by hand.
- **Consequence**: for courses taught in Chinese, maths-heavy courses, or small text on high-DPI 1080p screens, PDF following almost certainly fails, with no explanation (it only says "page not recognised").
- **Fix**: tokenise with Unicode properties (`\p{L}[\p{L}\p{N}]+`, single characters or bigrams for CJK); choose the language data from the PDF text; estimate transition probabilities from users' manual corrections.

### H4 🟡 Audio processing parameters
- `52-audio.js`: compressor threshold -34 dB at 3.5:1, presence boost +4 dB at 3 kHz, high-pass at 100 Hz, target -20 dBFS, maximum gain 18 dB, steps of +0.75/-1.5 dB, silence at `1e-8`, EMA factor 0.85; commented "Tuned offline on real lecture audio".
- `54-silence.js`: speech band 150 Hz–4 kHz (the one-pole filters **reset their state on every chunk**, which causes transients at each 60-second chunk boundary); noise and speech at the 10th and 90th percentiles; sensitivity factors 0.2/0.3/0.4; the dynamics checks `speech - noise < 6` and `speech < -55`; an initial 8-second wait; `gate.turn(2000, 400)`.
- **Fix**: carry the filter state across chunks, or overlap each chunk by about 0.5 s; collect the thresholds in one place with a note on the samples used for tuning.

### H5 🟡 Cache versions are not tied to algorithm parameters
- Records under `slides:`, `silence-env:` and `ocr:` all hard-code `v: 1`. After changing any threshold from H2–H4, existing users keep seeing results from the old algorithm, permanently.
- **Fix**: use an `ALGO_VERSION` (or a hash of the relevant constants) as the version and recompute on mismatch.

### H6 🟡 Interaction and network parameters
- `40-player.js`: the stall watchdog "kick after 12 s without progress" (checked every 2 s); resume only if `> 1` s and `< duration - 10` s; a second refusal within 30 s after a renewal is a failure; controls hide after 2500 ms; a click counts as a single click after 200 ms; markers snap within 6 px; seeking every 200 ms while dragging; position saved every 10 s.
- `35-stream.js`: `abrEwmaDefaultEstimate: 5e6` (assumes 5 Mbps from the start), `abrBandWidthFactor` at 0.95/0.85 (camera 0.7/0.6), `maxBufferLength 30`, `backBufferLength 60`, 4 network retries, 2 media error recoveries. On slow networks (dorm Wi-Fi, a phone hotspot), "start at the highest rendition" noticeably delays the first frame.
- `36-session.js`: retry delays `[2000, 5000]`, default renewal every hour, at least 60 s apart.
- `80-course-list.js`: 2 concurrent requests, 150 ms apart, ≥95% counts as watched, 300 ms debounce.
- `59-slide-deck.js`: `FOLLOW_MIN_SEC 15`, `FOLLOW_STALE_SEC 120`, `FOLLOW_UPDATE_MS 15000`; `pageTitle` takes the top 40% of the page and font sizes within `< 1`; `ar || 0.5625`.
- `10-adapter-echo360.js`: cues without `endMs` default to 3000 ms.
- `90-main.js`: the 8000 ms bootstrap fallback.
- Most are reasonable product parameters; the problem is that they are scattered through function bodies. **Fix**: collect them in one `CONFIG` section with units and their origin.

---

## 4. Module structure

### S1 🟠 Selector collision: two buttons are both `.pclose` (confirmed functional bug)
- **Location**: `30-ui-assets.js:440` (the PDF bar's ✕, `pnav pclose`) and `:542` (the side panel's close button, `btn pclose`); `40-player.js:815`, `d.listen($('.pclose'), 'click', () => this.sidebar.close())`; `:1239`, `bar('.pclose', () => this.setPdfMain(false))`
- **Problem**: `querySelector` returns only the first match in document order, which is the PDF bar's button. Both handlers are bound to it.
- **Consequence**: the ✕ at the top right of the side panel **does nothing**; clicking the PDF view's ✕ closes both the PDF view and the side panel.
- **Fix**: rename them (e.g. `.panelclose` and `.pdfclose`), or scope the queries to their containers (`this.$('.panel .pclose')`). More fundamentally, look up every element reference once in `buildDom` and assert that each selector matches exactly one element.

### S2 🟠 `LitePlayer` is a god class (1,600 lines, about 90 methods)
- **Location**: `40-player.js`
- **Problem**: one class handles DOM building, layout and dragging, both streams and quality, the keyboard (a 40-case switch), seek bar interaction, the floating window, copying, the captions menu, the audio menu, the silence UI, chapter marks, the PDF view, wiring up notes and discussion, toasts and error boxes, and settings persistence. `bindControls()` is about 195 lines, `bindVideo()` about 75.
- **Initialisation order is an implicit dependency**: in the constructor, `setupSilence()` must run before `loadCues()` (which calls `this.silence.start`), `setupSlides()` before `setupDeck()`, and `bindControls()` also creates `this.zoom` and `this.loop` (used by `applyLayout` and `onKey`). Swapping any two lines causes `undefined` errors that no test would catch.
- **Fix**: split out `SeekBar`, `KeyboardShortcuts`, `LayoutController` (including PiP and the divider), `QualityController`, `MenuBar`, `PopoutController`, `SilenceUi`. The player only assembles them and passes dependencies explicitly in the constructor.

### S3 🟡 Components reach back into the player's internals; coupling goes both ways
- `ABLoop` finds its mount point via `this.p.$('.speedmenu').parentElement` and calls `p.toast/p.seek/p.duration` directly
- `SlideReader` reads `player.deck` and `player.video`; `SlidesPane` calls `player.setPdfMain` and reads `player.prefs`
- `Exporter` reads `p.notes.items`, `p.tags`, `p.deck`, `p.lesson` directly
- `NotesPane` reads `player.tags`, `p.sidebar`, `p.deck` and news up an `Exporter` in `exportPanel`
- `DiscussionPane` calls `this.p.opts.onFallback('attachment')`
- The player **attaches a property from outside** to `Stream` instances: `stream.renewedAt` (`recoverAccess`)
- **Fix**: give components only the minimal interface they need (e.g. `{ seek, currentTime, toast }`) instead of the whole player; communicate across components through events or callbacks.

### S4 🟡 Inconsistent lifecycle ownership (three patterns in use)
- Pattern A: receives the player's Disposer (`SessionKeeper`, `SilenceAnalyzer`, `SlideAnalyzer`, `SlideDeckController`, `Zoomer`, `ABLoop`)
- Pattern B: creates its own Disposer, which the player disposes by hand (`TranscriptPanel`, `NotesPane`, `DiscussionPane`, `SlidesPane`, `Sidebar`)
- Pattern C: `this.d.child()` (only `Reporter`)
- In addition, `Sidebar.dispose()` disposes every registered pane, and the player disposes the same panes again at lines 160 and 1205: **double ownership** (harmless for now because `Disposer` is idempotent).
- **Fix**: one pattern, "receive `parent.child()` at construction": whoever creates a component owns it.

### S5 🟡 Global mutable state
- `mediaSession.renew` (`36-session.js`): readable and writable from anywhere. On dispose, `if (mediaSession.renew) mediaSession.renew = null`; if a page ever had a second `SessionKeeper`, the old one's dispose would clear the new one's callback.
- `idbCache.db` (including a cached failed Promise), `sigCtx`, `crcTable`, `tesseractPromise`, `pdfjsPromise` (plus its global Worker), `unexpected.handler`, `cpuFix`'s internal state
- The `defineProperty` trap on `window.Echo` (necessary, but with no way to undo it)
- **Fix**: keep per-playback state (`mediaSession`, the OCR and pdf.js engines) on a player context instead of module globals.

### S6 🟡 Duplicated code
| What is duplicated | Where |
|---|---|
| `duration()`: `video.duration`, else `lesson.duration` | `LitePlayer`, `SilenceAnalyzer`, `SlideAnalyzer` |
| Thumbnail URL `baseUri + '/' + t + '.' + extension` | `thumbnailFor` (11), `previewAt` (40), `loadThumb` and `fromThumbnailsAsync` (56) |
| Drawing `<i>` bars on the seek bar by percentage | `renderSilences`, `renderWatched`, `renderChapterMarks`, `TranscriptPanel.renderMarks`, `MarkersLayer.render` |
| "Click twice to delete" buttons | `NotesPane.deleteButton`, `DiscussionPane.deleteButton`, `tagManager` |
| Background analyzer skeleton (AbortController, BackgroundGate, state/progress/onChange, `v:1` cache, saveData check) | `SilenceAnalyzer`, `SlideAnalyzer`, `SlideTextReader` |
| Master playlist parsing | `pickAudioRendition` (54), `videoVariants` (56) |
| `<canvas>` fallback when `OffscreenCanvas` is missing | `sigContext`, `flatShare` |
| Fetching the syllabus | `courseList.syllabus`, `Exporter.course` |
| Checking whether the hostname is Echo360 | `echo360ClassroomAdapter.matches`, `courseList.matches` |
| `navigator.connection.saveData` check | 54, 56 and 58 |

### S7 ⚪ Dead code and over-abstraction
- `35-stream.js:81`, `get level()`: never used
- `36-session.js` `renewals`: written, never read
- `54-silence.js` `SilenceAnalyzer.stats`: written, never read; `speechSpans()`: only appears in tests and comments ("reserved for later features")
- `56-slides.js:631` `this.reader = reader`: written, never read
- The `ADAPTERS` array and adapter interface have a single implementation; `adapter.matches` accepts any `echo360.*` host while `@match` only allows `echo360.net.au`, so the two disagree
- The multi-language framework in `01-i18n.js` (`LANG` is hard-coded to `'en'`)
- Either delete these, or mark them clearly as "reserved for milestone Mx" with a link to the plan.

### S8 ⚪ File organisation
- Load order depends on numeric file name prefixes. There are two `47-` files and two `58-` files. The comment on line 4 of `58-slide-text.js` says screen reading is in "59-slide-ocr.js"; it is actually `58-slide-ocr.js`.
- Generic utilities live in feature files: the DOM helper `h()` is defined in `46-sidebar.js`; `seg()` is in `11-echo360-api.js` but used by `85-export.js`; `parseAttrs` is in `53` and used by `56`; `FLAG_SCENE_SECONDS` comes from the API module and is used by the player.
- **Fix**: move `h`, `seg`, `parseAttrs` and the canvas helpers to `00-util.js` or a new `02-dom.js`. In the medium term, consider ES modules bundled with esbuild, configured without minification so the output stays readable (which Greasy Fork accepts).

---

## 5. Concurrency and race conditions

> As noted above, there is no in-page recording switch, so the classic "an old recording's task writes into the new recording's state" cannot happen. Background analyses are aborted by `AbortController` on dispose and callbacks generally check `this.destroyed`, which is done well. The real races are in **concurrent user actions** and **repeated asynchronous loads within one component**.

### C1 🟠 Double submit: public posts, replies and notes can be sent twice (confirmed)
- **Location**: `48-discussion.js`, `post()` (line 220) and `submit` in `renderReplyComposer` (line 202); `47-notes.js`, `addNote()` (line 198)
- **Problem**: the only protection is `button.disabled`, but **the Ctrl+Enter keyboard path does not check the button state**. The textarea keeps its text until the request completes, so pressing Ctrl+Enter twice quickly (or pressing it once and clicking the button) sends two write requests.
- **Consequence**: duplicate posts in a discussion the whole class and the instructor can see, which the user then has to delete by hand. Notes are duplicated too.
- **Fix**: keep a `this.busy` flag per component: `if (this.busy) return; this.busy = true; try {…} finally { this.busy = false; }` at the entry of each function. Do not rely on the DOM's disabled state.

### C2 🟠 Responses of concurrent `DiscussionPane.load()` calls can overwrite each other out of order
- **Location**: `48-discussion.js:28`
- **Problem**: `load()` is called concurrently from several places: after every write, when the tab is opened (more than 60 s since the last load), and from "Refresh". There is no sequence number or cancellation, so an older response that **arrives later** overwrites a newer one.
- **Consequence**: a post or like that was just made "flashes and disappears" from the list until the next refresh.
- **Fix**: `const seq = ++this.loadSeq; … if (seq !== this.loadSeq) return;`, or cancel the previous request with an AbortController.

### C3 🟠 When adding a bookmark fails, `tagHere` tags a different bookmark (confirmed)
- **Location**: `47-notes.js:338`
- **Problem**: with no note nearby it calls `await this.addBookmark(e)`, which **swallows its error** and only shows a toast. The code then "picks the bookmark closest to the current time among all bookmarks", however far away it is (possibly one from 40 minutes earlier), and opens its tag picker.
- **Fix**: have `addBookmark` return the created item (null on failure) and use that return value in `tagHere`.

### C4 🟡 IndexedDB read-modify-write is not atomic
- `59-slide-deck.js` `addFiles`/`removeFile` on `deckref:<hash>`: `get` and then `put` or `del` in two separate transactions. Concurrent add and remove in one page, or **two tabs** (two courses using the same PDF) removing at the same time, can lose a reference, so that **a PDF still used by another recording gets deleted**, or an orphan that is never deleted remains.
- `43-watched.js` `save()`: with the same lecture open in two tabs, each writes "base as loaded + what this tab played"; the last writer erases the other tab's watched ranges.
- Settings `prefs` are overwritten as a whole: tabs overwrite each other (minor impact).
- **Fix**: do read-modify-write in a single `readwrite` transaction (`idbCache.update(key, fn)`); re-read and merge watched ranges before writing.

### C5 🟡 After a backup restore, the current page overwrites the restored data with old data
- **Location**: `85-export.js` `restoreBackup`; `40-player.js`, `pagehide → watched.save()`, `store.set('prefs', this.prefs)` on dispose, the debounced `savePrefs`
- **Problem**: after a restore the user is told to reload, but the `pagehide` of that reload writes the in-memory (old) watched data back to `watched:<current lesson>`, and any later settings change writes the old `prefs` back.
- **Consequence**: the restored watch progress for the current lecture is lost, and settings may be reverted.
- **Fix**: after a successful restore set `this.restored = true`, block further writes and call `location.reload()` right away; or skip the keys of the current recording when restoring.

### C6 🟡 Writes to `TagStore` before it has loaded overwrite stored data (latent)
- **Location**: `47-tags.js`: a `ready` flag exists, but no write method checks it
- **Problem**: calling `create/toggle` before `load()` finishes writes the empty `this.tags` or `this.map` to IndexedDB, overwriting the course's existing tags. Today notes only become usable after a network request, which is much slower than reading tags locally, so this is hard to trigger; it will appear if the loading order changes.
- **Fix**: have write methods `await this.loaded` first.

### C7 ⚪ Other small races
- `togglePopout` is async and `this.popout` is still null until `requestWindow` returns, so pressing W twice quickly requests two windows.
- `recoverAccess`: if the user swaps views during a renewal (`loadClock` replaces the hls instance), `stream.resume()` acts on the new instance afterwards. Mostly harmless today, but semantically wrong.
- `SlideDeckController.decide`: `this.job` correctly keeps results for an old set of PDFs out, but a correction (`correct`) made while the Worker is computing relies on the `again` flag to recompute once, and `again` is not reset in `reload()`.

---

## 6. Test coverage

**Current state**: one file with 27 tests covering pure functions and a few classes: time formatting, Disposer, PlayedRanges, FollowerSync, CueIndex, VTT, AudioChain wiring, API paths, playlist and MP4 parsing, silence detection, chapter building, the HMM for PDF following, SessionKeeper, TagStore, zip and Markdown, caption excerpts. For pure algorithms the quality is good.

### T1 🟠 Tests most worth adding (by value)
1. **`adapter.parse` and `intercept`** (`10-adapter-echo360.js`): they decide between taking over and falling back, they are the part most tightly coupled to Echo360's page and the most likely to break on a site update, and they have **zero tests**. Save a sanitised real `echoPlayerV2FullApp` bootstrap JSON as a fixture and cover: normal, live, copyright acknowledgement, no HLS, one and two sources, and a `withStartTime` round trip. For `intercept`, cover three orders: `window.Echo` assigned before the property is set, after it, and the property defined directly with `defineProperty`.
2. **Player creation and teardown**: in jsdom or happy-dom with a fake `HlsLib`, check that after `new LitePlayer(...)` and `destroy()` the host is removed, `overflow` is restored, no interval or timeout is left, and `mediaSession.renew` is null. Also cover **E1** (cleanup after the constructor throws half-way) and **L1** (dispose while a renewal is in flight).
3. **`Reporter`**: the payload (played ranges, position, lifecycle order BEGIN, beacon, END sent once), refreshing the token and retrying once after a 401, nothing sent after detach. Reports may affect attendance statistics, so mistakes are costly.
4. **`Echo360Api` write protection**: refusing writes without a trusted gesture (`isTrusted` false); routing for dryRun `public`/`all`. This is the only safeguard behind the promise that nothing is written to Echo360 without the user knowing.
5. **`sanitizePrefs` and `restoreBackup`** (after fixing E2): invalid values fall back to defaults; backups round-trip; foreign keys are rejected.
6. **`slideTextWorkerSource()`**: evaluate the source in `vm`, call `followLecture`, and compare with the main-thread result. The Worker source is assembled with `Function.prototype.toString`; if anyone uses an outside helper (such as `clamp`) in those functions, the main-thread tests still pass while the Worker throws a ReferenceError and PDF following stops working completely (and `SlideTextWorker` does not recreate a Worker whose script failed to load, so later requests **hang forever**).
7. **`SlideDeckController`** edges of `forces/correct/pageAt/timesOf/partAt/followSamples`: NaN duration, no OCR, overlapping corrections.
8. **`Stream.onError` retry policy** and `applyQuality`/`levelFor`: with a fake hls object, check that 401/403 go to renewal, network errors are retried 4 times and media errors recovered twice before being fatal.
9. **Regression tests for the races**: C1 (two Ctrl+Enter presses send one request), C2 (out-of-order responses), C3.

### T2 🟠 The labelled data is unused
- `test/fixtures/slides-2026-09-15-elec2134.json`, `slides-2026-09-24.json` and `slides-2026-09-28.json` are hand-labelled ground truth of "which page each chapter shows", but nothing in the test file references them. The thresholds from H2 and H3, tuned on a few lectures, therefore have no regression protection.
- The fixtures currently contain only times and page numbers, without OCR text or frame signatures, so they cannot be replayed directly. **Fix**: also store the OCR text (`texts/at`) and the PDF page text, compute accuracy with `followLecture` and assert a lower bound (e.g. ≥ 90%). If that is not possible, delete the files so readers do not assume there is regression protection.

### T3 🟡 Test infrastructure
- The command in the test file's header, `node --test test/`, **fails outright** on Node 22 (`Cannot find module '/home/user/echo360-lite/test'`, reproduced). Only `node --test test/unit.test.mjs` works.
- There is no `package.json`, hence no `npm test`, no lint and no CI. Nothing stops a PR that breaks the build or the tests.
- `loadSources()` selects source files by substring match (`f.includes(n)`); a name like `'47-'` loads both the notes and the tags file, which is fragile.
- **Fix**: add a minimal `package.json` (`"test": "node --test test/*.test.mjs"`, `"build": "node build.mjs"`) and a GitHub Actions job that runs build and tests and checks that `dist/` is in sync with the sources.

---

## 7. Maintainability: the biggest obstacles for someone who knows a little JS

From largest to smallest impact:

1. **No module system, so you cannot tell where a name comes from.** 32 files are concatenated into one IIFE and every top-level name shares one scope. On seeing `idbCache`, `h(...)`, `t(...)`, `seg(...)` or `FLAG_SCENE_SECONDS`, a reader has to search the whole tree to find the definition, and the editor's "go to definition" often fails. Which module depends on which can only be guessed from the numeric file prefixes.
2. **`t` and `h` are shadowed everywhere.** `t()` is the translation function and `h()` the DOM builder, yet `t` is used as a time variable throughout (`update(t)`, `previewAt(t)`, `let t = 0` in `53-media-io.js:20`, `54-silence.js:257`, `56-slides.js:111`) and `h` as a height or hls variable (`const h = this.hls` in `35-stream.js`, `const h = shown.height` in `40-player.js:401`). A beginner who adds `t('xxx')` or `h('div')` inside such a function gets "t is not a function" and will struggle to understand why. **Fix**: rename the translation function to `tr`/`i18n` and the DOM helper to `el`, and enable ESLint's `no-shadow`.
3. **A 1,600-line class with an implicit initialisation order** (see S2). Changing "the seek bar" means first finding the right 60 lines in the middle of `bindControls` among 90 methods.
4. **Long callback chains with no diagram.** For example, "how does the right page come up after adding a PDF": `addFiles → reload → startReading → SlideTextReader.run → onChange → readingChanged → decide → Worker → onChange → player.applyLayout → reader.update → showPage → drawInto`, across 5 files, linked entirely by event callbacks, which is hard to follow even with breakpoints.
5. **Very dense domain knowledge without references.** MP4 box parsing, WebCodecs, Web Audio dynamics, tf-idf, EM fitting of a Gaussian mixture, a hidden Markov model with Viterbi, Echo360's private endpoints (including oddities such as "delete a flag with a GET"), styled-components 4 internals (cpufix). Comments explain *what* but rarely the evidence for *why* (where thresholds came from, how the Echo360 endpoints were discovered), and there are no external links.
6. **Single-letter and abbreviated names**: `p, d, v, f, k, r, a, b, n, tg, rd, ev, ts, fs, sp, qp`, plus `M`, `V`, `N`, `B` in the Viterbi code. Acceptable in algorithm code, a clear burden in UI code.
7. **No type descriptions for data shapes.** The shapes of `lesson`, `chapter`, `page`, `note`, `cue` and the cache records are only described in some file header comments, scattered across files. Define them centrally with JSDoc `@typedef` and enable `// @ts-check` for editor completion and checking, without switching to TypeScript.
8. **Milestone numbers in comments (M7.5, M8.4, M10, ...) refer to a plan that is not in the repository.** Outsiders cannot follow them, and the `CHANGELOG` is written for users.
9. **The generated `dist/` file (8,700 lines) is committed.** Newcomers may edit `dist/` directly and lose the change on the next build. State "only edit `src/`" in a developer section of the README, and have CI check that `dist/` matches the sources.

**Recommendation: add a 1–2 page `ARCHITECTURE.md`** with a module map (one line per file plus dependencies), the startup flow (`main → intercept → parse → LitePlayer`), the lifecycle rules (who owns which Disposer), a diagram of the three background analysis pipelines, all cache keys and their formats, and the debug switches (`echo360lite:debug`, `dryRun`, `silenceFromAudio`).

---

## Appendix: what is done well (keep it when changing things)

- The `Disposer` + `guard` combination lets most resources be released in one call; background tasks generally use `AbortController` and check `signal.aborted`.
- `BackgroundGate`: all background downloads yield to the playback buffer and respect Data Saver.
- Every write to Echo360 requires a trusted user gesture (`requireGesture`), and there is a dry-run mode.
- There is always a way back: one click switches to the original player at the current position, and the CPU fix is enabled on fallback.
- The build is reproducible (`node build.mjs` produced no diff in `dist/` during this review), and it checks that no CJK characters appear in the sources.
- The pure algorithms (chapters, silence, HMM, playlist and MP4 parsing) have unit tests.

## Appendix: suggested order of fixes

1. **Now**: E1, E2, S1, C1. All small changes with the highest payoff.
2. **Next release**: L1, L2, L3, L4, E3/E4 (per-feature fault isolation), E5, C2, C3, items 1–4 of T1, plus `package.json` and CI.
3. **Medium term**: split `LitePlayer` (S2/S3/S4), centralise constants (H1–H6) and version caches by algorithm (H5), support non-English OCR (H3), prune IndexedDB (L7), write `ARCHITECTURE.md`.
