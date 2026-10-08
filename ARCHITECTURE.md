# Echo360 Lite: how it is built

This is a guide to the code for someone who knows a little JavaScript. It explains where
things are, how the script starts, who owns what, how the background analyses work and what
is stored where. Details live in the comments at the top of each file; this page tells you
which file to open.

## 1. What runs, and how it is built

Echo360 Lite is a userscript: the browser extension that runs userscripts (Violentmonkey,
Tampermonkey) loads one file, `dist/echo360-lite.user.js`, into Echo360's lesson pages and
course pages before the page's own scripts run.

That file is made by `node build.mjs` (or `npm run build`) from the files in `src/`:

- the files are **joined in name order** into one function, so a name declared at the top
  of one file (a `const`, `function` or `class`) can be used by all others;
- the result stays readable (no minifying: userscript sites require readable code);
- the build stops if the joined code does not compile, if a source file contains Chinese or
  Japanese characters (all text the user sees is in `01-i18n.js`), or if the pages listed in
  `src/meta.txt` (`@match`) and in `SITE_HOSTS` (`03-common.js`) differ.

`dist/` is committed, and CI checks that it matches `src/` (see section 9). **Only edit
`src/`**: a change made in `dist/` is lost at the next build.

## 2. Map of the source files

The number in front of a file only sets the order in which files are joined. Files that only
declare things (functions, classes, constants) can be in any order; only top-level code that
runs immediately must come after what it uses.

| Files | What they are |
|---|---|
| `00-util.js` | Logging, errors (`guard`, `featureGuard`, `reportUnexpected`), `Disposer` (cleaning up), settings store (`store`), small maths and time helpers |
| `01-i18n.js` | Every text the user sees, and `tr(key, values)` |
| `02-tuning.js` | Every tuning number (thresholds, sizes, timings) with its unit and why it holds |
| `03-common.js` | Small shared helpers: `el()` (make an element), `confirmButton`, `makeCanvas`, Echo360 URLs, `mediaDuration`, `fetchSyllabus`, `SITE_HOSTS` |
| `04-types.js` | Descriptions of the data passed around (JSDoc typedefs; no code) |
| `10-adapter-echo360.js` | Everything that knows Echo360's lesson page: catching its start-up call, reading it into a `Lesson` |
| `11-echo360-api.js` | Echo360's data API: notes, bookmarks, flags, discussion; refuses writes without a user action |
| `20-reporter.js` | Watch reporting (what the original player sends Echo360 about viewing) |
| `30-ui-assets.js` | Icons, the stylesheet and the player's HTML template |
| `35-stream.js` | One `<video>` fed by hls.js, with retries and recovery (`Stream`) |
| `36-session.js` | Keeping Echo360's video access alive (`SessionKeeper`) |
| `38-sync.js` | Keeping the second (muted) video in step with the first |
| `39-prefs.js` | Settings: defaults and validation |
| `40-player.js` | `LitePlayer`: builds the player, owns the streams and layout, assembles the parts |
| `41`–`47` | The player's parts: seek bar, keyboard, layout dragging, quality, menus, floating window, silence controls |
| `50`–`59` | Features: zoom, A-B loop, watched parts, captions and transcript, side panel, notes, tags, discussion, progress-bar markers, notices |
| `60-audio.js` | Audio tools (levelling, clearer voice, mono) with Web Audio |
| `61-media-io.js` | Background media work: playlist parsing, ranged downloads, the IndexedDB store (`idbCache`), the `BackgroundGate` |
| `62-silence.js` | Silence analysis from the transcript or the audio |
| `63-caches.js` | Versions, last use and clean-up of stored analysis results |
| `64-slides.js` | Slide chapters from the screen view; which view is the screen |
| `65-slides-pane.js` | The Slides tab and the PDF reader |
| `66-slide-ocr.js` | Reading the text on screen (Tesseract.js) |
| `67-slide-text.js` | Which PDF page is on screen, from that text (runs in a Worker) |
| `68-slide-deck.js` | The lecturer's PDF files for a recording, and following the lecture |
| `70-cpufix.js` | When the original player is used: a fix for its CPU use |
| `80-course-list.js` | Course page: a small progress bar per recording |
| `85-export.js` | Export (Markdown, zip) and backup / restore |
| `86-diagnostics.js` | "Copy diagnostics" text |
| `90-main.js` | Start-up |

## 3. Start-up

```
page loads ──► 90-main.js main()
                │
                ├─ course page (/section/<id>/home)? ──► courseList.start()   (80) ── done
                │
                └─ lesson page: adapter.intercept(onBoot)                      (10)
                     Echo360's own start-up call, Echo["echoPlayerV2FullApp"](json),
                     is caught (the Echo object is wrapped in a Proxy)
                                  │
                     page calls it ▼
                   onBoot(json, callOriginal)
                     ├─ settings say "use the original player" ──► callOriginal(json)
                     ├─ adapter.parse(json) ──► Lesson   (throws: live lecture, copyright
                     │                                     acknowledgement, no stream...)
                     ├─ the browser cannot play HLS ──► throw
                     └─ new LitePlayer(lesson, { fetchCues, api, onFallback })
                           any throw above ──► startOriginal(): callOriginal(json),
                                               CPU fix, a short notice

   If the page never makes its start-up call (Echo360 changed), the original player stays,
   with the CPU fix and a notice (checked a few seconds after load).
```

Inside `new LitePlayer` (`40-player.js`, `init()`), in this order:

1. read the settings; build the player's DOM in a shadow root over the page;
2. the session keeper and the two streams (`clock`: audio + video; `follower`: video only);
3. the parts (`setupParts()`): seek bar, quality, layout dragging, menus, keyboard, floating window;
4. video events and the control buttons; watched parts; watch reporting;
5. the features, each started on its own (`featureGuard`): silence, slide chapters, slide
   files, captions, notes and discussion, audio tools;
6. load the clock stream at the start position (a `#t=` link, else Echo360's last position,
   else this device's) and lay out the views.

If anything throws during construction, everything made so far is released and the
original player takes over (`startOriginal`).

## 4. Ownership and clean-up: the `Disposer`

Everything that must be undone later (event listeners, timers, observers, child objects)
is registered with a `Disposer` (`00-util.js`) at the moment it is made:

```js
d.listen(button, 'click', fn);        // removed on dispose
d.interval(fn, 1000);                 // cleared on dispose
d.add(() => something.close());       // run on dispose
const part = new SeekBar(deps, d.child());   // the part owns a child: disposed with d
```

Rules:

- **Whoever creates a part owns it** and passes it `parent.child()` (or `feature(name)`).
  The part never disposes what it did not create.
- `d.feature(name)`: a child for an optional feature. An error in that feature's callbacks
  turns off only that feature (one notice: "… was turned off"); playback goes on.
- `d.core()`: for playback itself. An error there hands the page to the original player.
- `player.destroy()` disposes everything; after that the player does nothing (callbacks
  check `destroyed`).

Errors: `guard(fn)` wraps a callback so an exception is logged instead of breaking the page;
in a feature or core disposer it is reported at that level (see the top of `00-util.js`).

## 5. The player and its parts

The player keeps what several parts share: the two streams and which view each plays
(`clockPos`, `followerPos`, `primaryPos`), the layout (`layout`, `pdfMode`), the settings
(`prefs`, `savePrefs()`), `ui.dragging` (something is being dragged), toasts and errors.

Each part gets a small object with only the functions and elements it needs, not the
player itself. For example the seek bar gets `{ $, video, clock, duration, seek, isIdle,
armIdle, markers, ui, previewAt, skipAt }`. That keeps each part readable on its own and
makes it clear what it can change. (The side-panel tabs, `55`–`57` and `65`, still get the
player itself; narrowing them is planned with M9's platform layer.)

Two `<video>` elements play: the **clock** plays audio and video and drives time, reporting
and seeking; the **follower** shows the other view muted and is kept in step (`38-sync.js`),
so the audio is downloaded once. Swapping views side by side only moves the elements; in the
single-view layout the clock is reloaded with the other view. While a stream is (re)loading,
its element says 0 s and paused, so ask the stream (`stream.position()`, `stream.playing()`).

## 6. Background analyses

Three analyses run in the background. They share these rules:

- **Playback first.** Every download waits for the `BackgroundGate` (`61-media-io.js`): it
  runs only while the video is paused or has enough buffered ahead. Nothing runs with the
  browser's Data Saver on.
- **Cached.** Results are stored in IndexedDB with a version (`CACHE_KINDS`, `63-caches.js`);
  a result from another version is made again. Unused results are removed after 60 days.
- **Tolerant.** One unreadable segment is skipped; several in a row stop the analysis,
  keeping what was found (and the next visit continues).
- **Learnt per recording.** Thresholds come from the recording itself (see `02-tuning.js`
  for the few fixed numbers and why they hold).

### Silences (`62-silence.js`, shown by `47-silence-ui.js`)

```
transcript cues ──► gaps between cues ≥ minimum ──► silences
     (none)
audio rendition ──► 60 s chunks (byte ranges) ──► decode to 16 kHz mono
                ──► speech-band level per 0.1 s (envelope, cached) ──► threshold between
                    noise floor (10th percentile) and speech level (90th) ──► silences
silences + empty screens (from slide chapters) ──► skippable stretches ──► marks on the
    bar, Skip button, auto-skip, "the lecture has ended"
```

### Slide chapters (`64-slides.js`)

```
which view is the screen?
   chosen by hand ─► that view
   one view       ─► that view
   else: pairs of keyframes 10 s apart in each view; a screen is still between changes,
         a camera always changes a little ─► the stiller view (a guess if not clear;
         the Slides tab lets the user choose)
keyframes of the screen view, one per 10 s (360p, ~20 KB each, only the keyframe bytes)
   ─► 160×90 brightness picture ─► change against the last visibly different one
   ─► threshold learnt from this recording's changes (Otsu) ─► runs of the same picture
   ─► chapters (returns, short looks elsewhere and flicking merged) ─► each change pinned
      to about a second by decoding that stretch ─► cached
```

The same pictures also say where the screen is one colour (black screen, blank slide).

### Following the PDF (`66`, `67`, `68`)

```
PDF files dropped ─► stored locally (by SHA-256) ─► pages' text (pdf.js)
                  ─► language of the slides ─► text recognition in that language
screen keyframes (720p where the 360p picture changed; else the text is reused)
   ─► Tesseract.js text per distinct picture (cached)
   ─► Worker: words (any script) ─► tf-idf scores per picture and page ─► how scores look
      for right and wrong pages, learnt from this lecture ─► sequence model over time
      (Viterbi) ─► page per sample ─► the page shown while following
```

## 7. What is stored

IndexedDB database `echo360lite`, store `cache` (`61-media-io.js` `idbCache`); formats in
`04-types.js`:

| Key | What | Kind |
|---|---|---|
| `slides:<mediaId>` | chapters, screen view, empty-screen stretches | analysis (versioned, pruned) |
| `silence-env:<mediaId>` | audio level envelope | analysis |
| `ocr:<mediaId>:<view>[:<lang>]` | text read on screen | analysis |
| `watched:<lessonId>` | parts watched on this device | user data |
| `tags:<sectionId>`, `tagmap:<mediaId>` | private tags and which item has which | user data |
| `deck:<mediaId>`, `deckref:<hash>`, `deckfile:<hash>` | slide files of a recording | user data |
| `screenpick:<mediaId>` | screen view chosen by hand | user data |

User data is included in backups (`85-export.js`); analysis results are not.
`localStorage` (prefix `echo360lite:`): `prefs` (settings), `pos:<id>` (resume point),
and the switches below.

## 8. Talking to Echo360

- **Reading:** the lesson page's own data (start-up call), the transcript, player properties
  (course page), notes, discussion.
- **Video:** HLS playlists and segments from Echo360's CDN; access cookies are renewed in the
  background (`36-session.js`) by loading the lesson page again.
- **Watch reporting** (`20-reporter.js`): the same session and heartbeat messages as the
  original player, based on what was actually played.
- **Writing** (notes, bookmarks, flags, discussion) only through `Echo360Api.write`, which
  refuses to run without a trusted user event (a real click or key press). Tested in
  `test/unit.test.mjs` (T1.4).

## 9. Development

```sh
npm install          # ESLint, TypeScript (type checking only), happy-dom (page tests)
npm run build        # src/ -> dist/echo360-lite.user.js
npm test             # unit tests and whole-page tests (test/*.test.mjs)
npm run lint         # ESLint; no-shadow keeps locals from hiding shared names
npm run typecheck    # TypeScript checks the JavaScript (tsconfig.json, types/)
npm run ci           # all of the above, plus "dist/ matches src/" (what GitHub runs)
```

- **Tests** load the sources into a sandbox (`loadSources`), or the whole script into a
  simulated page (`test/player.test.mjs`). Labelled lectures are replayed in the tests from
  `test/fixtures` as hashed word bags (no slide text is in the repository).
- **Switches** in `localStorage` (prefix `echo360lite:`): `debug` = `true` (more logging; the
  player is reachable as `window.__echo360LitePlayer`), `dryRun` = `"public"` or `"all"`
  (writes are recorded, not sent), `forceOriginal` = `true` (always the original player),
  `silenceFromAudio` = `true` (analyse the audio even with a transcript).
- **Changing a threshold:** it is in `02-tuning.js`; run the tests (the labelled lectures
  have accuracy floors), and bump the analysis' version in `CACHE_KINDS` so stored results
  are made again.
- **Adding a part of the player:** a class in its own file taking `(deps, disposer)`;
  create it in `setupParts()` with only the functions it needs and `this.d.child()`.

## 10. Background reading

The code uses some techniques that are not everyday web programming. The comments say what
the code does with them; these explain the ideas:

- Fragmented MP4 (the boxes `moof`, `trun`, `mdat` in `64-slides.js`):
  [ISO base media file format](https://en.wikipedia.org/wiki/ISO_base_media_file_format);
  HLS: [RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216).
- Decoding single frames: [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API).
- Audio tools: [Web Audio](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API),
  [DynamicsCompressorNode](https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode).
- The chapter threshold: [Otsu's method](https://en.wikipedia.org/wiki/Otsu%27s_method).
- Matching screen text to pages: [tf-idf](https://en.wikipedia.org/wiki/Tf%E2%80%93idf);
  learning what "right" and "wrong" scores look like:
  [EM for a mixture of Gaussians](https://en.wikipedia.org/wiki/Expectation%E2%80%93maximization_algorithm);
  deciding all pages at once: [hidden Markov model](https://en.wikipedia.org/wiki/Hidden_Markov_model) and the
  [Viterbi algorithm](https://en.wikipedia.org/wiki/Viterbi_algorithm).
- Echo360's endpoints are not documented: they were found by watching the requests the
  original player makes (browser developer tools, Network tab), and this script makes the
  same requests in the same way. If Echo360 changes them, the lesson-page reading
  (`10-adapter-echo360.js`) and the API (`11-echo360-api.js`) are where to look, and the
  tests with the saved page data (`test/fixtures/boot-echo360-classroom.json`) show what
  the code expects.

