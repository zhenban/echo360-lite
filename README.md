**English** | [简体中文](README.zh-CN.md)

# Echo360 Lite Player

A userscript that replaces the Echo360 lecture-recording player with a lightweight native one.

The stock player keeps one CPU core busy for the whole lecture (loud fans, drained battery). Echo360 Lite plays the same streams with the browser's own video player, at close to the cost of playing a plain video file, and adds a few things that make watching lectures easier.

> Status: **0.10.0, in development.** Tested on `echo360.net.au` (Australia). If the page is not recognised, the original player is used automatically.

## Features

- **Low CPU use**: native `<video>` with [hls.js](https://github.com/video-dev/hls.js), using hardware decoding.
- **Two views at once**: show the screen and the camera side by side (drag the divider) or as picture in picture (drag, resize, snap to corners). You can also show a single view. Swap them with one click or `S`. The two views stay in sync.
- **Sharp slides**: always the highest quality the network allows, chosen separately for the screen and the camera.
- **Captions and transcript**: caption overlay in four sizes. A transcript panel follows along with the lecture, lets you click a sentence to jump there, and searches the full text, with matches marked on the progress bar.
- **Notes, bookmarks, "didn't understand" flags and discussion**: these use the same data as the original player, so everything stays in sync with Echo360. Items with a time are marked on the progress bar.
- **Audio tools** (off by default): even out the volume (for lecturers without a microphone), clearer voice, mono.
- **Silence detection**: long pauses (breaks, group work) are marked on the progress bar. A "Skip silence" button appears when you reach one, and an optional auto-skip jumps over them.
- **Slide chapters**: slide changes in the screen view are found automatically. A Slides tab lists every slide with a picture and what was said; the progress bar shows chapter boundaries and a preview when you hover. `Shift+←` / `Shift+→` move to the previous / next slide.
- **Read along with the slides**: drop the lecturer's slide PDF on the player and the Slides tab turns into a PDF reader that follows the lecture, turning to the page being talked about (it reads the text on screen and finds it in the PDF). Page through it yourself at any time; one click brings you back. The PDF stays on your device.
- **Resume**: playback continues where you stopped, across devices (uses Echo360's own record).
- **Honest watch reporting**: viewing progress is reported to Echo360 exactly like the original player, based on what you actually played.
- **Always a way back**: the "Original player" button switches to Echo360's player at the current position. If anything goes wrong, the script falls back to the original player and turns on a CPU fix for it.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / pause |
| `←` / `→` | Back / forward 5 s |
| `J` / `L` | Back / forward 10 s |
| `↑` / `↓` | Volume |
| `M` | Mute |
| `F` | Fullscreen |
| `S` | Swap views |
| `C` | Captions |
| `T` | Transcript |
| `B` | Bookmark |
| `U` | "Didn't understand" flag |
| `Shift+←` / `Shift+→` | Previous / next slide |
| `P` | Copy the current picture |
| `A` | Copy what was just said (transcript, last 60 s) |
| `[` / `]` | Slower / faster |
| `Esc` | Close menus |

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
   In Chrome or Edge, open the Tampermonkey details at `chrome://extensions` and turn on **Allow user scripts** (on older versions, turn on Developer mode).
2. Install [`dist/echo360-lite.user.js`](dist/echo360-lite.user.js) (open the raw file and your manager will offer to install it).
3. Open any Echo360 lecture recording. The browser console (F12) shows `[Echo360 Lite] v… active`.

## Privacy

- The script only runs on Echo360 lecture pages and sends nothing anywhere except Echo360 itself.
- Settings, resume positions and analysis caches are stored only in your browser (localStorage and IndexedDB).
- hls.js is loaded from jsDelivr at a pinned version; pdf.js and Tesseract.js (text recognition) too, only when a recording has a slide PDF. Text recognition runs in your browser.
- Nothing is ever posted for you. Writes to Echo360 (notes, posts, flags) only happen when you click. Anything your instructors or classmates can see is labelled before you send it.
- There is no download feature.

## Known limitations

- Live lectures and recordings that require a copyright acknowledgement use the original player.
- Polls, slide decks, attachments and audio description are only in the original player (a button takes you there).
- Echo360's video access expires about every 24 hours. If it expires during playback, you will be asked to reload, and playback continues from the same position.
- When a recording has no transcript, silence is detected from the audio, and quiet talk far from the microphone may be marked as silence. Skipping is always your choice unless you turn on auto-skip.

## Development

```sh
node build.mjs                    # src/*.js -> dist/echo360-lite.user.js (readable, not minified)
node --test test/unit.test.mjs    # unit tests
```

Source files in `src/` are plain scripts concatenated in name order. Code and comments are in English, and user-facing strings live in `src/01-i18n.js`.

## License

[MIT](LICENSE)
