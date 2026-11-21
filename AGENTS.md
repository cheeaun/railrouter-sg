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
- `src/live-trains.js` — the scheduled-trains feature: timetable decode, service-day clock, per-frame instance generation, one instanced WebGL layer, and the trains panel UI.
- `src/gtfs-codec.mjs` — encode/decode for the packed timetable. **Shared by both the build script and the browser app.** Must stay `Buffer`-free (`btoa`/`atob` only) or Parcel's bundle breaks.
- `src/service-day.mjs` — maps a service date to weekday/Saturday/Sunday-and-holiday timetable, shared by the browser app and its tests.
- `scripts/download-gtfs.mjs` — downloads the feed and writes `src/gtfs-trains.json`.
- `scripts/download-holidays.mjs` — downloads Singapore public holidays from data.gov.sg and writes `src/public-holidays.json`.
- `scripts/gtfs-codec.test.mjs` — codec round-trip tests.
- `src/gtfs-trains.json` — **generated, but committed.** Never hand-edit; rerun `npm run gtfs`.

## Data pipeline

- `data/` is git-ignored. It holds the 3.3 MB raw `gtfs-schedule.zip`, which is re-downloadable. Only the built `src/gtfs-trains.json` is committed.
- `.github/workflows/update-gtfs.yml` reruns the builders twice a month, commits both JSON files, and needs the `LTA_ACCOUNT_KEY` secret.
- **The build must stay deterministic.** A build carries no timestamp, so an unchanged feed produces a byte-identical JSON and the CI job's `git diff --staged --quiet` guard skips the commit. Adding anything time- or run-dependent to the output breaks that guard and rewrites the whole 530 KB blob every run. Provenance goes in `data/gtfs-meta.json` (git-ignored), and the commit date says when the timetable last changed. Verify with two `GTFS_OFFLINE=1 npm run gtfs` runs and `cmp`.
- Locally, the account key comes from `LTA_ACCOUNT_KEY` or `scripts/config.json` (`{ "accountKey": "..." }`, git-ignored). `GTFS_OFFLINE=1` rebuilds from the cached ZIP with no network.
- `src/public-holidays.json` is also generated and committed. The browser overlays holiday dates on the GTFS calendar at runtime: a holiday service date uses the Sunday/PH timetable, including observed Monday holidays. The output has no timestamp so reruns stay byte-identical.
- **Judge size by the compressed size, not the raw size.** The file is always served gzip/brotli: ~580 KB raw but ~119 KB gzipped. Optimisations that shrink raw JSON while adding many small unique strings (profile dedup, time quantisation) have previously made gzip *worse* — they were prototyped and reverted. Do not relitigate without measuring gzip.
- Trip polylines are Douglas-Peucker simplified at 1 m with every stop vertex pinned, then stop distances are recomputed and delta-encoded. The drawn layer uses the unsimplified `src/sg-rail.geo.json` geometry, so simplification only affects train positions. At 3 m the corner-cutting was visible when zoomed in, so don't raise the tolerance back without checking that; the extra 1 m vertices cost ~14 KB gzipped.

## live-trains.js gotchas

- **Service day, not calendar day.** The clock returns seconds along a service day that rolls at 03:00 SGT (`SERVICE_DAY_CUTOFF`), so post-midnight trips run past 86400 and the date/weekday point at the previous day. `SERVICE_DAY_CUTOFF` is in **seconds** — compare it against seconds, not hours.
- **Rotation is baked, not eased.** Per-vertex headings are pre-smoothed over an arc-length window (`HEADING_WINDOW`, ±22 m) at prepare time, and within that window of each vertex they are blended into the segment. The rest of a segment uses its exact bearing, so a train on a straight is aligned with the line rather than still easing out of the previous curve. Short segments (≤ 2 × window) rotate vertex-to-vertex. Do not reintroduce temporal heading easing: it lags the rotation behind the position and reads as a pivot around the rear of the car. Headings are stored in shader radians (`bearing - 90`).
- **The GPU does the drawing.** One instanced quad per train, shader-painted; there is no GeoJSON source. Keep per-frame CPU work to writing the instance buffer — the loop is deliberately allocation-free (scratch module vars for position/heading, reused `counts`/active arrays, a flat `paths` list built once in `prepare`). A previous GeoJSON `?trains=symbol` fallback was removed because it cost ~2× the CPU.
- **Fades need the step cap.** `FADE_MAX_STEP_MS` bounds how far one frame may advance a fade; without it the first frame after a pause jumps straight to fully visible.
- **Frame rate tiers by zoom** in `now` mode (10 / 30 / 60 fps). Fades are deliberately excluded from that decision — with ~200 trains one is always fading, which would pin the loop at 30 fps.
- **Per-frame DOM writes are guarded.** The scrubber/time field only update when the whole minute changes; the count pills are built once and updated in place (rebuilding them churned thousands of DOM nodes a second). `map.triggerRepaint()` also creates an `AbortController` + `abort` listener inside MapLibre on every call — that is balanced per frame, not a leak, so ignore it in DevTools' listener counter.

## UI conventions

- Do not hide an unavailable control to save space. Keep it in the layout and show it disabled/faded so spacing never jumps.
- Give elements with changing text a fixed/min width (`min-width: 2ch` for counts) so rows never shift.
- Two-state toggles are a single button, not a `<select>`.
- Use real SVG icons for play/pause, not glyphs.
- Overlay panels sit pinned to the left edge, stacked in one flow, left-aligned, with an explicit `max-width`.
- Inputs bounded by a control's min/max should clamp to the nearest bound rather than reject or error.
- `hidden` is not reflected on SVG elements in Chrome — toggle a class (`is-hidden`) instead.
- MapLibre's own `button:hover` (`rgba(0,0,0,0.05)`) can override a control's fill; the `.active` trains button needs higher specificity and the same colour on hover.

## Verify before finishing

`npm test` and `npm run build` must both pass. For anything touching train
positions, rotation, or the render loop, also load the page, toggle the 🚆
button, and check the trains actually animate — `?trainsdebug` prints the
per-frame update time and `window.$trainsGL.getDebug()` exposes the instance
buffer.
