# Changelog

## 0.17.0
A redesign of the controls (the language setting comes in a later version).
- **Control bar**: play, back and forward 10 seconds, volume and time on the left; speed, captions, bookmark, copy picture, copy text, layout and full screen on the right. In a narrow window, copy text, then copy picture, then bookmark move into the ⋮ menu; on a phone the time moves above the progress bar.
- **Speed**: the button shows the speed (for example 1.5×). It opens one slider from 0.5× to 3× that snaps to the common speeds and moves in 0.05 steps; tap a label to jump. `[` and `]` still step between the common speeds.
- **Captions**: the CC button turns them on or off in one press. When a recording has no captions, the button is dimmed and says why. Caption size and "hide while paused" are in the menu.
- **Layout**: the button shows the current layout and its label says what comes next; you can also pick one directly in the menu. With a slide PDF open, the button switches between side by side and picture in picture.
- **One ⋮ menu** in the title bar replaces the separate menus: quality, captions, audio, skip silence, layout, copy text length and theme, each on its own page with a back button; then the floating window, loop a section, export notes and backup, keyboard shortcuts, storage and diagnostics, and switch to the original player. Menus open next to their button; on a phone they open as a sheet from the bottom. Esc or a press outside closes them.
- **Theme**: dark, light or match system (the default). The light theme applies to the side panel, menus and dialogs; the video area stays dark.
- **Didn't understand** is no longer in the control bar. It is in the Notes tab, marked as visible to your instructor, and asks you to confirm before marking (U asks too).
- New colours and icons throughout. Progress-bar markers differ by shape as well as colour (notes are dots, bookmarks are bookmark shapes, "didn't understand" marks are flags, discussion posts are diamonds), and the A-B loop is a white outline.
- Touch: all controls are at least 44 px; nothing needs hovering. Tooltips are for mouse and keyboard only.
- Keyboard: every control has a visible focus ring and a name for screen readers; menus work with the arrow keys and give the focus back to their button when closed.

## 0.16.1
- Fix: transcript search marked the wrong place: a cue spread over several lines got the mark under its last lines, whatever line the match was on. Now exactly the matched characters are marked (for "exam", the "exam" in "example").
- Volume levelling is now on by default (when the browser supports it; otherwise it stays off quietly). Turning it off is remembered. An "off" saved by an earlier version cannot be told apart from the old default, so it is turned on once; turn it off again if you prefer it off.

## 0.16.0
Under the hood (first part of the 1.0 release work): everything that depends on how the player is run — where settings and files are kept, where pdf.js and Tesseract are loaded from, hls.js, saving files — now goes through one small layer, so a browser extension can later be built from the same code. Nothing should look or work differently; please report anything that does.

## 0.15.3
Fixes from a review of touch input, several open tabs, and files changed while work is still running.
- While the controls are hidden, their buttons (including the A-B loop handles) no longer take clicks or taps.
- Tags made, renamed or deleted in two tabs of the same course no longer overwrite each other.
- Replacing a slide PDF with a shorter one while reading a later page no longer breaks the PDF view; a page that was removed or slow to draw is not kept for the new file.
- A reply that fails to send keeps its text and shows the error; a note being edited keeps its text when the list is redrawn.
- Touch: a cancelled touch (for example the browser taking over a gesture) no longer swaps the pictures, and a cancelled seek returns to where playback was; a second finger can no longer finish another finger's drag (progress bar, divider, small picture, loop handles, zoomed picture).
- Safari: a recording that is switched or closed while loading no longer jumps the next one to an old position.
- With the browser's Data Saver on, looking for slide chapters downloads nothing and says why.
- Closing the player while a slide file is being read no longer starts a PDF worker.
- In the pop-out window, captions, the transcript and slides keep updating when the original tab is in the background.

## 0.15.2
- Fix: audio tools request a media playback audio context instead of the default low-latency interactive context. On some Android devices, the interactive output route changed the speaker sound even with all audio tools off; playback mode avoids that route change on the tested Samsung tablet.
- Updates: the script explicitly checks and downloads the latest published release, including when it was originally installed from a version-specific release link.

## 0.15.1
- Fix: on touchscreens, lifting a finger while a recording plays no longer immediately hides the controls. When controls are hidden, the first tap shows them and the next tap can pause playback.

## 0.15.0
The project is renamed **Lite Player for Echo360** (Echo360 轻量播放器), so that it does not read like an Echo360 product. The repository moved to `zhenban/lite-player-for-echo360` (old links redirect).
- This is a new userscript for your manager (new name and namespace): remove the old "Echo360 Lite Player" and install `lite-player-for-echo360.user.js`.
- Settings and data stored in the browser use new names and start empty: settings, resume points kept on this device, watched parts, tags, slide files and analysis results. Notes, bookmarks, flags and discussion are on Echo360 and are not affected. A backup made with an earlier version can be restored after one change in the file: open it in a text editor and replace `"app":"echo360-lite"` (at the very start) with `"app":"lite-player-for-echo360"`.
- Nothing else changes.

## 0.14.1
- License: from this version on, Echo360 Lite is licensed under the GNU General Public License v3 or later (GPL-3.0-or-later). Versions up to 0.14.0 remain under the MIT License.
- hls.js is now required with its SHA-256 hash: Tampermonkey refuses a modified file (the script then leaves the original player in place). Violentmonkey does not check hashes yet.
- The project page: an install link to the latest release, a screenshot, a note that this is an unofficial project (not affiliated with Echo360 or UNSW), a bug report form, and how to report security problems privately (SECURITY.md). Releases are published on GitHub with the script attached.
- No change to how the player works.

## 0.14.0
Under the hood (M8.9 E and F): the player is split into small parts, the code is checked automatically, and a smoke test runs real recordings in Chrome and Firefox. Nothing should look different; please report anything that does.
- The player's start-up is caught however Echo360's page sets it up (one way, defining the start function with `defineProperty`, used to slip past and leave the original player).
- The pages the script acts on are exactly those it is installed for.
- Diagnostics also show the audio levels used for silence detection.
- For developers: `npm test` (unit tests and whole-page tests in a simulated page), `npm run lint`, `npm run typecheck` (the JavaScript is type-checked from JSDoc), `npm run ci`; GitHub Actions runs them on every push and checks that `dist/` matches `src/`. The code layout is described in ARCHITECTURE.md; all tuning values are in `src/02-tuning.js`; shared helpers in `src/03-common.js`; data shapes in `src/04-types.js`. `test/smoke/smoke.mjs` runs the regression checklist on real recordings in a signed-in browser (Chrome or Edge over DevTools, Firefox over WebDriver BiDi).

## 0.13.1
- Fix: in the single-view layout, switching to the camera and back quickly started the recording from the beginning (and could pause it). Every reload of a view (switching views, the PDF view, retry, renewed access) now keeps the position and play state even while the previous switch is still loading; the progress bar no longer jumps to 0 during a switch.
- Fix: on some recordings slide chapters were missing entirely ("unavailable"): the screen view could not be told from the camera when the slides were busy (handwriting on coloured backgrounds) and the camera showed a still room. The screen is now recognised by how it changes over time (still between slide changes, while a camera always moves a little), which separated the views clearly on every recording checked. When it is not clear, the most likely view is used instead of giving up.
- The Slides tab shows which view the slides are found in, and lets you choose the other one (remembered for that recording, included in backups); "Automatic" goes back.

## 0.13.0
Works for more courses (M8.9 C: no settings tuned to one course).
- Slide chapters without a PDF: each recording now learns for itself how large a change of the screen is a new slide (ink, a pointer or scrolling are smaller), instead of using fixed percentages and times. Every slide change found on two hand-checked lectures; one 3-hour lecture went from 12 chapters to 87. Quick switches (a look at the code editor and back, flicking through slides) still make one chapter. Chapter pictures keep the screen's shape (4:3 screens are no longer stretched).
- Recordings cut into segments other than 10 s: chapters, slide reading and silence detection now work in seconds, so they cost the same and stay as precise with any segment length.
- Reading along with slides in other languages: the screen is read in the language of the PDF (Chinese, Japanese, Korean, Russian, Greek, Arabic, Hebrew, Thai, Hindi, or English). Other languages need their text-recognition data once (0.6–2.7 MB); the Slides tab says which and how large while it loads. Words are compared in any script, with accents and PDF ligatures handled, which also makes English slides match slightly better.
- With a slide PDF, the slide reader reuses the pictures already fetched for chapters instead of downloading them again.
- Silence detection no longer has a small glitch at each one-minute boundary of the audio.
- Playback starts from the connection speed the browser reports instead of assuming 5 Mbps.

For developers: every tuning value is in `src/02-tuning.js` with its unit and why it holds across courses; two hand-labelled lectures are replayed in the unit tests (as hashed word bags, no slide text) with a minimum accuracy.

## 0.12.0
New:
- Empty parts: a black screen, a "no signal" picture or any one-colour screen while nobody speaks is found from the slide analysis (no extra download) and marked on the progress bar like silences, with the same Skip button and setting (hover says "silence", "black screen and silence" or "black screen"). An empty screen while someone is still speaking is left alone.
- End of the lecture: when the recording ends with such an empty part, playback reaching it says "The lecture has ended" with "Skip to the end" or "Stop here", and the watched percentage leaves it out (watching all of the content is 100%).
- Course page: each recording gets a small progress bar showing both what you watched on this device (filled parts, with the percentage) and where Echo360 says you stopped last time (a tick, any device). The player's progress bar also shows that tick.
- ⋯ menu: how much space analysis results take on this device, with a Clear button (unused results are also removed after 60 days, and results from older versions are made again), "Copy diagnostics" for bug reports (shown before copying; no sign-in data, addresses, names, notes or posts), and the shortcut list.

More robust:
- Only a failure in playback itself still switches to the original player. A failure in any other feature turns just that feature off with one short notice; playback goes on.
- One unreadable segment no longer ends slide chapters, silence detection or slide reading; results found so far are kept, and parts that could not be read are tried again on the next visit.
- Storage: failed writes are reported (a PDF that cannot be stored says so), storage that failed to open is tried again, and records shared by several tabs (slide files, watched parts) are changed in one step so tabs cannot undo each other. A restored backup is written all at once and the page reloads straight away, so it cannot write older data back.
- The floating window recovers if moving the player into it fails, and cannot be opened twice by a double press; after switching to the original player nothing of this player comes back.
- Memory: rendered PDF pages are kept within a fixed pixel budget; pdf.js's worker ends when no PDF is open; pictures of old chapters are released.
- Discussion: an older refresh that answers late no longer hides a post just made.
- Console output: warnings and errors only, in one format (details with localStorage `echo360lite:debug` = true).

## 0.11.2
Stability fixes from an independent code review ([docs/REVIEW-quality.md](docs/REVIEW-quality.md)).
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
