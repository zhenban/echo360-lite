# Changelog

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
