# Design brief: Lite Player for Echo360

## Product and audience
A replacement player for university lecture recordings. Students watch for one to three hours at a time, often at 1.5–2x, while reading slides, taking notes and searching the transcript. The interface is a tool, not a showcase: the lecture content (video, slides, transcript) is the hero, and the chrome should recede until it is needed.

Quality reference: the calm, precise feel of YouTube's player, IINA and the Apple TV app. Not a landing page; no "bold aesthetic risk". The one place to be memorable is how good it feels to use: crisp controls, clear states, smooth and fast.

## Hard constraints
- System font stack only (no web fonts; performance rule). Use font-variant-numeric: tabular-nums for every time, speed and counter so digits never jitter.
- All styles inside the existing Shadow DOM; every colour, radius, spacing and duration comes from CSS custom properties (design tokens). No hard-coded colours in components.
- Icons: one consistent set, inline SVG, same grid (24px), same stroke width and same corner treatment. No mixing filled and outlined styles unless filled means "active".
- Accessibility floor: WCAG AA contrast for text and icons in both themes; visible focus ring for keyboard users only (:focus-visible); prefers-reduced-motion respected; every control has an accessible name.
- Touch: hit targets at least 44x44 px on coarse pointers (the visible icon can be smaller); nothing depends on hover or right-click.

## Tokens (propose concrete values, then critique them before building)
- Colour, dark theme (default for the video area, always): layered neutral greys rather than pure black, so the panel, the control bar and menus read as separate surfaces. Video letterboxing stays true black.
- Colour, light theme (side panel, menus, dialogs only): a soft neutral off-white base with slightly darker layered surfaces. Not pure #FFFFFF, and not warm cream. Text is a dark grey, not pure black.
- One accent colour, used sparingly and only for meaning: progress fill, the active state of toggles, the current item, focus. Choose an accent that is not one of the common AI defaults (terracotta/clay orange, acid green, generic SaaS indigo). It must pass contrast on both themes.
- Semantic colours for markers on the progress bar (silence, black screen, bookmark, notes, tags, flag for instructor, last position) must be distinguishable from each other and from the accent, including for colour-blind users (vary shape or pattern as well as hue).
- Spacing on a 4px scale. A small radius hierarchy (e.g. small for chips, medium for menus, none for the video), not one radius on everything.
- Motion: 120–200 ms ease-out for menus and state changes; motion only in response to the user (opening, closing, confirming). No decorative animation.

## Components (build once, use everywhere)
- Popover: anchored to the button that opened it (above for the bottom bar, below for the top bar), shifted inward at screen edges, a bottom sheet at phone width, closes on Esc and outside click, returns focus to its button.
- Toggle button: clear on/off state that does not rely on colour alone.
- Settings menu with second-level pages and a back button.
- Tooltip (desktop only, never the only way to learn what a control does).

## Bottom bar
- Play/pause, -10/+10 s, volume, time; then speed, captions, bookmark, copy picture, copy text, layout, fullscreen.
- Priority overflow: when the bar is too narrow, the lowest-priority buttons (copy text, copy picture, bookmark, in that order) move into the ⋮ menu automatically, and come back when there is room. Define the priority order in one place.
- Speed: the button shows the current speed ("1.5×"). It is the only bottom-bar button that opens a popover. Do not build it as a row of cramped boxes: design a single horizontal control, for example a track with snap points at 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5 and 3, labels under the main stops, a thumb that can also move in 0.05 steps, and the current value shown large. It must work with a finger and with the keyboard ([ and ] step between snap points).
- Captions: one press turns captions on or off; disabled with a reason when the recording has none. Caption options live in the settings menu.
- Layout: the icon shows the current layout; the tooltip says what the next press switches to; direct choice is in the settings menu. Define how the cycle changes when the PDF view is open.
- "Flag for instructor" is visible to the instructor: it does not live in the bottom bar; it lives in the Notes tab, is labelled as instructor-visible and asks for confirmation.

## Copy
Sentence case, plain verbs, no all-caps labels, no filler. A control keeps the same name everywhere (button, tooltip, menu, shortcut list, confirmation). Errors say what happened and what to do; "Switch to the original player" is offered directly in any error that blocks playback.

## Avoid (these read as generated)
Cream background with terracotta accent; near-black with one neon accent; identical rounded cards with the same soft shadow everywhere; gradients as decoration; ALL-CAPS eyebrow labels; middle-dot meta strings; monospace for small labels; arrows appended to button text; hover animations on everything.

## Process
1. Write the token plan (named colour values for both themes, type scale, spacing, radii, motion) and an ASCII sketch of the bottom bar at desktop, 768 px and 390 px widths. Critique it against this brief and say what you changed and why.
2. Build the shared components first, then migrate the controls.
3. Screenshot every state in the test browser: dark and light, desktop, narrow and touch, menus open, speed popover, captions disabled, overflow active. Critique the screenshots ("look in the mirror and remove one accessory") and fix what you find before reporting.
4. Report with the screenshots.
