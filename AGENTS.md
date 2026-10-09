# Development instructions

## Workspace and review

- Work in a separate clone of the GitHub repository, on a `codex/` branch. Do not edit the owner's original checkout or develop on `main`.
- Submit changes through a pull request for the owner's review. Do not merge, enable auto-merge, push to `main`, or publish release tags without the owner's explicit approval.
- The owner's current instructions take precedence over the local roadmap's instructions to continue automatically or release milestones.

## Read before work

Read `README.md`, `ARCHITECTURE.md`, and the latest `CHANGELOG.md` entry. When available, also read `ROADMAP.md` and `PROGRESS.md`; use the latest completed milestone entries rather than their historical version headings. Read the relevant milestone plan before implementing it.

The roadmap, progress log, `FEATURES.md`, `M8.9-PLAN.md`, and `dev/` are local working material excluded by `.gitignore`. They are absent from a fresh GitHub clone. Obtain them from the owner or an authorized existing checkout; keep them local and do not force-add them. Do not publish lecture lists, slide files, account data, or browser profiles.

## Code and performance

- Edit source files in `src/`; generate `dist/` with `npm run build`. Commit the generated script with source changes.
- Keep source and comments in English, user-facing strings in `src/01-i18n.js`, and tuning values in `src/02-tuning.js` with units and justification across courses.
- Preserve plain-script concatenation in filename order and the readable build.
- Update only affected DOM nodes. Batch frequent rendering with requestAnimationFrame and stop it when hidden. Inject styles once.
- Register timers, listeners, observers, workers, and child components with their owning `Disposer`; release them on teardown and fallback.
- Keep expensive work off the main thread or split it into idle chunks. Background work must yield to playback and respect Data Saver. Cache analyses by recording; bump the relevant cache version when an algorithm changes.

## Product requirements

- Always preserve fallback to the original player and its CPU fix.
- Report actual viewing only. Do not implement downloads or exports of video addresses.
- Render server and user content as text; never insert untrusted HTML.
- Keep user data and supplied files local. Follow the roadmap's pinned-library and local-AI requirements.
- Echo360 writes require an explicit trusted user action. Test publicly visible writes only in dry-run mode, comparing request fields; the owner tests real public writes during normal use. Clean up private data created during authorized testing.

## Verification and milestone records

- Use Node.js >=20 (`22` in CI), install locked dependencies with `npm ci`, and run `npm run ci` and `npm run check-requires` before submitting code changes.
- For player changes, run the roadmap regression checklist in a dedicated signed-in test browser. Automated checks do not replace real playback verification. `test/smoke/smoke.mjs` supports Chrome/Edge over CDP and Firefox over BiDi; lecture lists stay local. Report unavailable coverage explicitly.
- Record completed work, design tradeoffs, verification, unresolved issues, and performance self-review in local `PROGRESS.md`; keep the local roadmap current.
- Describe unreleased changes in `CHANGELOG.md`. For an approved release, bump `VERSION` (minor for features, patch for fixes) and rebuild. Setup or documentation alone does not require a player version bump.
- Review every new recurring timer, listener, observer, animation, background task, and network request, including frequency and stop conditions. Do not deliver unfinished features in the interface.
