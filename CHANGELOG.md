# Changelog

## 0.11.2
Stability fixes from an independent code review (REVIEW-quality.md).
- If anything fails while the player is being set up, everything it already made is removed and the original player takes over cleanly (before, a black overlay could stay over the original player). Browsers that cannot play the streams go to the original player before anything is built.
- Settings are checked field by field when they are read and when a backup is restored; a damaged value falls back to its default instead of breaking every later visit. A restore only accepts known entries, each checked.
- The side panel's close button works again (it shared a name with the PDF view's close button, which closed both).
- The PDF toolbar's buttons and the top of a picture-in-picture window in a top corner could not be clicked where the title bar overlaps them; the title bar's background now lets clicks through.
- A discussion post, reply, note, bookmark or flag can no longer be sent twice by pressing Ctrl+Enter (or clicking) again while the first request is on its way.
- `G` no longer tags an older bookmark when adding the new one fails.
- After switching to the original player, no background session renewal, slide-following Worker or text-recognition engine keeps running.

## 0.11.1
- Fix: on some recordings the Slides tab never appeared (so no slide PDF could be added either). Two causes: a preview picture that the browser had cached from the original player without the headers this script needs stopped the slide analysis altogether; and a fixed "how flat is a screen" level rejected busy screens (a browser with toolbars) as not being slides. Now a failed picture is fetched again or skipped, the screen view is the one clearly flatter than the other views of that recording (measured on video frames if the preview pictures cannot be read), and the Slides tab is always there once the analysis is done, with or without chapters.

## 0.11.0
- Video access is renewed in the background: Echo360's access cookies (about two hours) are refreshed ahead of time and at once when a request is refused, so playback, captions, the slide reader and background work carry on without a reload. Only an expired school sign-in still asks to reload.
- Private tags on notes and bookmarks (local only, shared by all recordings of a course): coloured chips, a tag filter, rename / recolour / delete, tag colours on the progress bar. `G` tags the note or bookmark at the current moment.
- Zoom into the screen, camera or PDF view: wheel or pinch to zoom, drag to move, double-click (or `0`) for the whole picture, `+` / `-` on the main picture; a small overview shows the visible part. The PDF is redrawn sharp at the zoom level.
- A-B loop: `I` / `O` (or right-click the progress bar), drag the ends, `X` to end; a jump outside offers to end it.
- Watch progress: what you watched on this device is shown faintly on the progress bar, and the course page shows a small "watched" percentage per recording (Echo360's last position where this device has no record).
- Floating window (`W`): the whole player moves into a Document Picture-in-Picture window and back, without interrupting playback. Hidden where not supported.
- Export (`E`): notes and bookmarks with times, links back to the moment (`#t=`) and tags as Markdown; with the slide PDF, the page on screen at each note as a picture (zip). Whole-course export. Backup and restore of everything that only lives in this browser (optionally with the PDFs).
- Keyboard shortcut list (`?`).
- Fix: the error dialog's styles leaked onto note cards.

## 0.10.0
- Following the slide PDF now reads the text on screen instead of comparing pictures. Every 10 s of the screen view is read at 720p with Tesseract.js (loaded from jsDelivr, pinned, only for recordings with a slide PDF) and compared with the text of every page; one pass over the whole lecture decides all pages at once, so slides shown in a browser, a PDF viewer, zoomed in or with a code editor in between are followed.
- What counts as a match is learnt from each lecture itself, not from fixed thresholds. Pages without text are placed from the pages around them; other windows (code, browser, video call) keep the last page.
- Pictures that did not change are not read again (compared at 160 x 90 on the small rendition; the 720p picture is only downloaded where something changed). Reading starts at the playback position, uses about half of one core while playing and goes full speed while paused; results are cached, and an unfinished reading continues on the next visit.
- The page turns at the slide change found by the chapter analysis (to about a second) instead of up to 10 s late.
- "Wrong page?" corrections now cover the part of the lecture shown on one page and steer the decision around them.
- Removed: the picture-based page matching of 0.8.0.

## 0.9.0
- The slide PDF can go into the picture area as a view of its own: side by side with the video (drag the divider) or as the main picture with the video in a small window, or the other way round. Open it from the Slides tab; swap or close it from its toolbar. The small reader in the side panel stays.
- New Copy button (`P` / `A`): copy the current picture at full resolution (the screen view if it is playing), or copy what was just said: the last 60 seconds of the transcript in whole sentences, with the lecture name and times, ready to paste into an AI chat. The length can be changed in the menu (30 s to 5 min).
- Paused: a small "Paused" label in the title bar instead of a big play icon over the picture. Captions hide while paused (can be turned off in the captions menu).
- When no page has been recognised for two minutes, the reader says "Current page not recognised" instead of presenting an old page as current.

## 0.8.0
- Read along with the lecturer's slides: drop the slide PDF on the player (or add it in the Slides tab) and the tab becomes a PDF reader that turns to the page being talked about. Several PDFs per lecture are fine.
- Page through it yourself at any time: following pauses, and "Back to the page being talked about" resumes it. Each page lists when it was on screen; click a time to jump there.
- "Wrong page?" lets you set the page for the part playing now, or mark it as not a slide. Corrections are saved for this recording.
- A page is only taken as recognised when the match is clear; otherwise the reader keeps the last recognised page and says so.
- The PDF stays on this device (IndexedDB) and can be removed at any time; pdf.js is loaded from jsDelivr (pinned) only when a lecture has slides.

## 0.7.1
- Quality first: playback starts at the highest rendition instead of sizing it to the window, steps down only when the network cannot keep up, and goes back up quickly.
- New quality menu (button next to the speed): Auto or a fixed rendition, separately for the screen and the camera, remembered. Shows the rendition actually playing.
- The camera may use a lower rendition only while it is the small picture-in-picture window, and is the first to step down when bandwidth is short. The screen is never limited.

## 0.7.0
- Slide chapters: the screen view is detected automatically, and every slide change is found and pinned to about a second. Switching briefly to a code editor or a question board and back does not start a new chapter.
- New "Slides" tab: one card per chapter with a picture, the time and the first thing said on that slide. The current slide is highlighted.
- Chapter boundaries on the progress bar; hovering the bar shows a preview picture of the slide.
- `Shift+Left` / `Shift+Right`: previous / next slide.
- Works in the background without disturbing playback (it reads only the start of each 10 s video segment) and is cached, so it is instant on the next visit. Browsers without WebCodecs get approximate chapters from Echo360's per-minute thumbnails.
- Fix: the seek-bar tooltip is no longer covered by captions.

## 0.6.0
- Silence detection: long pauses (breaks, group work) are shown as hatched stretches on the progress bar, with their length on hover.
- Entering a silence shows a "Skip silence" button for a few seconds; "Skip silence automatically" (off by default, with Undo) jumps over it during normal playback.
- Uses the transcript timing when there is a transcript; otherwise analyses the separate audio track in the background (only while playback has enough buffer, never with Data Saver on) and caches the result in IndexedDB, continuing an unfinished analysis on the next visit.
- Audio menu: silence status and progress, auto-skip, shortest silence (15 s to 2 min), sensitivity.
- Fix: open menus are no longer covered by captions.

## 0.5.1
Verification round in a dedicated test Chrome with real playback and real input.
- Fix: Esc did not close menus (an open menu also made the next toolbar click land wrong).
- Fix: captions switched up to 250 ms late at sentence boundaries (timeupdate granularity); a single timer now fires at the next boundary while playing.
- Fix: discussion posts linked to a time now include `thumbnailUri`, chosen exactly like the original player.
- Fix: Echo360 ids in request paths are no longer percent-encoded (`:` stays as is), matching the original player.
- Fix: the Notes tab said flags were anonymous; the original player labels them "Flag For Instructor", so the text now says your instructor can see them.
- Dry-run mode for writes (development): `localStorage["echo360lite:dryRun"] = "public"` or `"all"` builds requests but only records them.

## 0.5.0
- Audio menu with three switches (off by default, remembered): Even out volume (compressor + slowly adapting makeup gain + limiter), Clearer voice (100 Hz high-pass + 3 kHz presence), Mono.
- Only enabled stages are connected; with everything off the audio is untouched. The graph is only created from a user action (remembered settings apply on the first click or key press), so playback can never start silent.
- Disabled with an explanation where Web Audio would be unsafe (native HLS) or unavailable.

## 0.4.0
- Side panel with tabs: Transcript, Notes, Discussion (top-bar buttons; `T` toggles the transcript). Panel state and active tab are remembered.
- Notes tab: private notes at the current time (Ctrl+Enter), bookmarks (`B` or the bookmark button, with Undo), "didn't understand" flags (`U` or the flag button, toggles the current 30 s part, highlighted when set), filter by type, inline edit, two-click delete.
- Discussion tab: the lesson's posts and replies with author or "Anonymous", instructor/TA badges, linked video time (click to jump), like, private "save for later", reply, delete your own posts; sorted by newest or by video time; refresh on open (at most once a minute) and after each change. The composer and every reply box state that posts are visible to instructors and classmates; "Link to current time" and "Hide my name" options; 5,000-character limit.
- Progress-bar markers for notes, bookmarks, flags and timed posts; hover shows the content, a click next to a marker jumps exactly to it.
- Features the lesson does not have, or the course has turned off, are not shown. Attachments, polls, slides and audio description link to the original player.
- Writes to Echo360 only run from a real user action (the browser's `isTrusted` event); scripted clicks are refused before any request is made.
- Lessons that require a copyright acknowledgement go straight to the original player.
- Any unexpected error in the player's handlers hands the page back to the original player with a notice.

## 0.3.0
- Captions over the picture: on/off (button or `C`), four text sizes, dark background, sits above the controls and drops lower when they hide.
- Transcript panel (button or `T`): current sentence highlighted and kept in view; scrolling the list yourself pauses following and shows "Back to current"; click a sentence to jump; search with match count, Enter / Shift+Enter (or arrows) to step through matches, matches marked on the progress bar. Collapsible, resizable (drag its left edge), state remembered.
- One cue list feeds both (transcript API with per-sentence times, WebVTT as fallback). Recordings without captions show neither control.
- Watch reports now state truthfully whether captions are shown and the transcript is open.

## 0.2.0
- Dual view: side by side (draggable divider, double-click resets), picture in picture (drag to move with corner snapping, corner grip to resize, click to swap), single view. Swap views with the button, `S`, or a click on the PiP window. Layout, ratio, PiP size/corner and the primary view are remembered.
- The view with audio is the clock; the other view plays its video-only rendition muted, so audio is downloaded once. A 1 s check while playing nudges the follower's rate for small drift (up to 10%) and seeks it for drift over 1 s; play/pause/seek/rate/buffering are mirrored immediately.
- Swapping in dual layouts only moves the elements; the single layout releases the second stream entirely.
- Every stream caps its rendition at the size it is displayed (small PiP windows stay on 360p).
- If the second view fails, playback continues with one view and a notice offers to retry.
- Unit tests (`node --test test/`) for sync logic, played ranges, cleanup and formatting.

## 0.1.1
- Source split into `src/` modules with a readable single-file build (`node build.mjs` → `dist/echo360-lite.user.js`). The build rejects CJK characters in source code.
- All code and comments in English; user-facing strings moved into one string table (`src/01-i18n.js`, English only for now).
- Unified resource cleanup (`Disposer`): every listener, timer and the hls.js instance is owned by the player and released in one call when handing over to the original player.
- Time label, progress and buffer bars are rendered at most once per animation frame and not at all while the controls are hidden or the tab is in the background; a forced refresh happens when they become visible again.
- Preferences are written to localStorage with a debounce; the local resume position is saved every 10 s from the existing 2 s watchdog tick instead of a separate timer.

## 0.1.0
- First version: native `<video>` + hls.js single-view player with play/pause, seeking with hover time, ±10 s, 0.5–3x speed, volume, full screen, view switching, server-side resume, remembered preferences, keyboard shortcuts, auto-hiding controls, watch reporting, "Original player" button and automatic fallback to the original player with the CPU fix.
