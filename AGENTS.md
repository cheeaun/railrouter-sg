# AGENTS.md

Guidance for coding agents working in this repo. See `README.md` for what the
project is; this file covers how to work in it without breaking things.

## Commands

```sh
npm i            # install
npm start        # dev server on http://localhost:1987 (port is pinned, do not change)
npm run build    # production build into dist/
npm test         # node --test scripts/*.test.mjs
npm run gtfs     # rebuild src/gtfs-trains.json from LTA's GTFS feed
npm run holidays # rebuild src/public-holidays.json from data.gov.sg
npm run gen-style # regenerate src/basemap-style.json from OpenFreeMap's Bright style
npm run links    # rebuild src/station-links.json from the external station pages
```

There is no lint or format script wired up, even though `.oxfmtrc.json` exists
(single quotes, otherwise defaults). Match the surrounding style by hand.

**Parcel runs with `--no-hmr`.** Every source edit needs a dev-server restart
before the browser shows it. Worse: Parcel can serve a **stale bundle** after a
restart, so if a change appears not to take effect, check the bundle hash in the
page (`index-<hash>.js`) changed, or hard-reload with a fresh `?v=` query param,
before debugging your code.

## Layout

- `src/index.js` — map setup, layers, stations/exits/search/crowd UI. Imports and wires `createLiveTrains`.
- `src/live-trains.js` — the scheduled-trains feature: service-day clock, playback/mode state, active-trip list, the trains panel UI, and wiring for the GPU overlay.
- `src/gpu-trains.js` — the GPU renderer: 10 m path resampling, baked headings, the stop/profile textures, the active-instance builder, and the separate overlay canvas.
- `src/gtfs-codec.mjs` — encode/decode for the packed timetable. **Shared by both the build script and the browser app.** Must stay `Buffer`-free (`btoa`/`atob` only) or Parcel's bundle breaks.
- `src/service-day.mjs` — maps a service date to weekday/Saturday/Sunday-and-holiday timetable, and holds the shared service-day clock and `runningServices`. Imported by the browser app and its tests.
- `src/timetable.mjs` — the one loader for `gtfs-trains.json` + `public-holidays.json`. Both the trains layer and the station sidebar call it, so the JSON is fetched and parsed once per session.
- `src/timetable-data.mjs` — pure timetable queries (station → boarding points, next arrivals). No fetch or JSON imports, so Node tests import it directly.
- `src/station-arrivals.js` — the station sidebar's Arrival times table, under Exits.
- `src/line-color.mjs` — `contrastInk()`, the black-or-white ink for a line colour, shared by the trains panel and the arrival badges.
- `scripts/download-gtfs.mjs` — downloads the feed and writes `src/gtfs-trains.json`.
- `scripts/download-holidays.mjs` — downloads Singapore public holidays from data.gov.sg and writes `src/public-holidays.json`.
- `scripts/build-station-links.mjs` — scrapes the external sources and writes `src/station-links.json`, keyed by `station_codes`. A station only gets a source when that source really has a page for it. SGTrains has no per-station pages: its line pages read the station from the URL hash (`network-<line>.html#<CODE>`), so that is the deep link. SBS Transit only covers the lines it operates (DTL/NEL/SK/PG LRT) and SMRT only its own (NS/EW/CC/TE/BP), so those two keys are absent for most stations.
- `scripts/gtfs-codec.test.mjs` — codec round-trip tests.
- `scripts/timetable-data.test.mjs` — arrival-board query tests.
- `src/gtfs-trains.json` — **generated, but committed.** Never hand-edit; rerun `npm run gtfs`.

## Data pipeline

- `data/` is git-ignored. It holds the 3.3 MB raw `gtfs-schedule.zip`, which is re-downloadable. Only the built `src/gtfs-trains.json` is committed.
- `.github/workflows/update-gtfs.yml` reruns the builders twice a month, commits both JSON files, and needs the `LTA_ACCOUNT_KEY` secret.
- **The build must stay deterministic.** A build carries no timestamp, so an unchanged feed produces a byte-identical JSON and the CI job's `git diff --staged --quiet` guard skips the commit. Adding anything time- or run-dependent to the output breaks that guard and rewrites the whole 530 KB blob every run. Provenance goes in `data/gtfs-meta.json` (git-ignored), and the commit date says when the timetable last changed. Verify with two `GTFS_OFFLINE=1 npm run gtfs` runs and `cmp`.
- Locally, the account key comes from `LTA_ACCOUNT_KEY` or `scripts/config.json` (`{ "accountKey": "..." }`, git-ignored). `GTFS_OFFLINE=1` rebuilds from the cached ZIP with no network.
- `src/public-holidays.json` is also generated and committed. The browser overlays holiday dates on the GTFS calendar at runtime: a holiday service date uses the Sunday/PH timetable, including observed Monday holidays. The output has no timestamp so reruns stay byte-identical.
- **Judge size by the compressed size, not the raw size.** The file is always served gzip/brotli: ~580 KB raw but ~119 KB gzipped. Optimisations that shrink raw JSON while adding many small unique strings (profile dedup, time quantisation) have previously made gzip *worse* — they were prototyped and reverted. Do not relitigate without measuring gzip.
- Trip polylines are Douglas-Peucker simplified at 1 m with every stop vertex pinned, then stop distances are recomputed and delta-encoded. The drawn layer uses the unsimplified `src/sg-rail.geo.json` geometry, so simplification only affects train positions. At 3 m the corner-cutting was visible when zoomed in, so don't raise the tolerance back without checking that; the extra 1 m vertices cost ~14 KB gzipped.
- **Station identity is a separate table.** A path's `s` is only stop *distances* along the track; it says nothing about which station a stop is. The builder therefore also emits a sorted `stations` array (combined `station_codes` keys) and a per-path `st` list of station indices, delta-coded like `s`. That is what the sidebar's arrival board reads. It costs ~3.4 KB gzipped; keep the table sorted so the output stays deterministic.
- **A headsign is a terminus, not a direction.** The builder also emits a sorted `headsigns` table and a per-path `h` index (~0.8 KB gzipped). Do not group arrivals by headsign: southbound from Ang Mo Kio, trains terminate at Ang Mo Kio, Toa Payoh *and* Marina South Pier while all running the same way, which split one direction into three rows. Group by the **next station** along the path and use the headsign of the pattern with the most trips as the label.
- **Loop direction copy follows LTA's CCL wayfinding** (`lta.gov.sg/cclwayfinding`). A loop line's direction is Clockwise/Anticlockwise, decided by the **signed area** of the path geometry — the GTFS headsign is unreliable there (sometimes the compass direction, sometimes the terminus). Under the direction, LTA shows `via <next interchange>` for a through (closed-path) service and `ends at <terminus>` for a terminating one. Both are derived, never hardcoded. The two trains shown per direction can carry different copy, so rows are keyed by direction *and* qualifier.

## live-trains.js gotchas

- **Service day, not calendar day.** The clock returns seconds along a service day that rolls at 03:00 SGT (`SERVICE_DAY_CUTOFF`), so post-midnight trips run past 86400 and the date/weekday point at the previous day. `SERVICE_DAY_CUTOFF` is in **seconds** — compare it against seconds, not hours.
- **Rotation is baked, not eased.** `gpu-trains.js` resamples each path at 10 m and reads its heading from a ±30 m chord, so corners swing over a short arc instead of snapping at a vertex. Do not reintroduce temporal heading easing: it lags the rotation behind the position.
- **Speed is eased, position is not.** `legProgress` in the vertex shader runs a trapezoidal velocity profile over each stop-to-stop leg (ramps from `uRamp`, capped at a share of the leg that widens from 35% toward a full triangular profile as playback speeds up, so short hops become triangular) so trains pull out of and brake into platforms instead of starting and stopping dead. `live-trains.js` scales `uRamp` by the playback rate, like the fades, so the ease keeps the same wall-clock length at every speed instead of vanishing in fast playback. A new rate only applies to legs that start after it: the shader holds `uRampFrom`/`uRampShareFrom` for legs already under way, so changing speed never slides trains mid-leg. Clock jumps (back to live, scrubbing) retune every leg, since the jump already repositions the fleet. It must stay a monotonic 0→1 function of time within the leg, since the timetable still owns the schedule.
- **The GPU resolves the timetable.** Three static RGBA32F textures hold path vertices/headings, per-pool metadata and stop profiles. The vertex shader walks the profile from `uTime`; the CPU writes one time uniform per frame and refills the active-trip instance list at most once per simulated second (10×/s at high playback, with the look-ahead scaled to match). Never rebuild or upload per-train data per frame.
- **The trains are a separate canvas.** `createTrainOverlay` appends a transparent WebGL2 canvas over the map (`pointer-events: none`, `z-index: 1`), so moving trains never make MapLibre repaint the basemap. Camera sync is a homography fitted from four public `map.project()` samples around the centre; it is exact for the Mercator plane with bearing and pitch, and is recomputed only when the camera or canvas size changes. The map is not redrawn for train movement, so do not call `triggerRepaint()` from the train loop.
- **Fades are simulated-time.** The shader fades over `uFade` seconds of simulated time, so playback scales it by `PLAY_SPEED * speed` to stay ~0.7 s wall-clock. Modes with a frozen clock use a near-zero fade, otherwise trains would freeze half-transparent. Turning the layer on uses `uReveal` to fade the whole fleet in.
- **Frame rate tiers by zoom** in `now` mode (10 / 30 / 60 fps); playback and scrubbing draw every frame. The loop stops entirely in `manual` mode and while paused; the overlay still redraws on pan/zoom itself.
- **Per-frame DOM writes are guarded.** The scrubber/time field only update when the whole minute changes; the count pills are built once and updated in place.

## UI conventions

- Do not hide an unavailable control to save space. Keep it in the layout and show it disabled/faded so spacing never jumps.
- Give elements with changing text a fixed/min width (`min-width: 2ch` for counts) so rows never shift.
- Two-state toggles are a single button, not a `<select>`.
- Use real SVG icons for play/pause, not glyphs.
- Overlay panels sit pinned to the left edge, stacked in one flow, left-aligned, with an explicit `max-width`.
- Inputs bounded by a control's min/max should clamp to the nearest bound rather than reject or error.
- `hidden` is not reflected on SVG elements in Chrome — toggle a class (`is-hidden`) instead.
- MapLibre's own `button:hover` (`rgba(0,0,0,0.05)`) can override a control's fill; the `.active` trains button needs higher specificity and the same colour on hover.
- **The trains toggle stays usable while a station sheet is open.** The general `.sheet.open ~ #map` rule hides the map controls, and `.maplibregl-ctrl-trains` is exempted from it; the trains *panel* (`#bottom-left #trains-time`) is still hidden, since the sheet owns that corner. On narrow screens the sheet is a bottom sheet, so the bottom-right control stack is lifted above it (50vh, or 100px when the sheet is collapsed) or the toggle would sit underneath the sheet.

## Verify before finishing

`npm test` and `npm run build` must both pass. For anything touching train
positions, rotation, or the render loop, also load the page, toggle the 🚆
button, and check the trains animate and stay on the lines while panning and
zooming — `?trainsdebug` prints the update time and
`window.$trainsGL.getDebug()` exposes counts, textures and the camera key.
