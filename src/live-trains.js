import trainsUrl from './gtfs-trains.json' with { type: 'url' };
import { decodeCoords, decodeInts, decodeProfile } from './gtfs-codec.mjs';

// GTFS times are Singapore local time, which has no daylight saving.
const SGT_OFFSET = 8 * 3600 * 1000;
// A service day starts before the first train and lasts past midnight. Times
// after midnight still belong to the previous day's timetable (GTFS writes
// them as 24:xx, 25:xx…), so anything before this cutoff is served by
// yesterday's services.
const SERVICE_DAY_CUTOFF = 3 * 3600;
const EARTH_RADIUS = 6371000;
const RAD = Math.PI / 180;
// Redraw rate while playing or scrubbing; playing at speed covers a lot of
// ground per tick, so it needs the smooth rate.
const TICK_MS = 1000 / 30;
// Following the real clock, a train's per-tick pixel step depends on zoom: a
// fixed ~12 m/s is well under a pixel per tick zoomed out but many pixels
// zoomed in. The live view therefore picks its rate from zoom so the step
// stays roughly constant and invisible, while avoiding full-map repaints the
// eye cannot see at low zoom.
const NOW_FAST_MS = 1000 / 60; // zoomed right in
const NOW_MID_MS = 1000 / 30; // mid zoom
const NOW_SLOW_MS = 1000 / 10; // zoomed out
const NOW_MID_ZOOM = 15; // below this, 10fps is imperceptible
const NOW_FAST_ZOOM = 18; // above this, 60fps keeps the step under a pixel

// Playback speed, in simulated seconds per real second. 60 = one simulated
// minute per real second, so a full day takes 24 real minutes.
const PLAY_SPEED = 60;
const END_HOLD_MS = 1500;

const DEBUG_TRAINS = new URLSearchParams(location.search).has('trainsdebug');
const GL_LAYER = 'trains-gl';
// Per train: [mercatorX, mercatorY, angle, r, g, b, alpha, scale].
const INSTANCE_STRIDE = 8;

// How long a train takes to fade/scale in or out when it enters or leaves the
// timetable, in wall-clock milliseconds. Long and eased on purpose: a short
// linear fade reads as a pop at the low real-time frame rate.
const TRAIN_FADE_MS = 700;
// Largest time step a single frame may advance a fade by. It must stay below
// the fade duration: after the loop has been paused (scrub, tab background),
// the first frame's elapsed time is huge, and without this cap every new train
// would jump straight to fully visible instead of fading.
const FADE_MAX_STEP_MS = 120;
// Trains enter and leave slightly scaled down, not from nothing; a large size
// change is what makes the fade feel abrupt even when the alpha is smooth.
const TRAIN_MIN_GROW = 0.85;
// Half-width, in metres, of the arc-length window used to smooth each vertex's
// heading. A corner therefore turns over ~2x this much track, so a sharp
// 90-degree bend reads as a gradual swing at any playback speed.
const HEADING_WINDOW = 22;

// Local mercator origin. Train positions are uploaded relative to this so the
// GPU only ever sees small numbers: absolute lng/lat in float32 is ~2m jitter
// at Singapore's longitude, which is visible at max zoom.
const ORIGIN_LNG = 103.82;
const ORIGIN_LAT = 1.35;
const ORIGIN_X = (ORIGIN_LNG + 180) / 360;
const ORIGIN_SIN = Math.sin(ORIGIN_LAT * RAD);
const ORIGIN_Y = 0.5 - Math.log((1 + ORIGIN_SIN) / (1 - ORIGIN_SIN)) / (4 * Math.PI);

// Scratch results written by pointAt and localMercator. Both run once per train
// per frame (~35k times a second with ~390 trains), so returning a fresh array
// or object from each call churned through short-lived allocations and GC.
let pointLng = 0;
let pointLat = 0;
let pointHeading = 0;
let mercX = 0;
let mercY = 0;

// Writes into mercX/mercY rather than returning a pair, since this runs for
// every train on every frame.
function localMercator(lng, lat) {
  const sin = Math.sin(lat * RAD);
  mercX = (lng + 180) / 360 - ORIGIN_X;
  mercY = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) - ORIGIN_Y;
}

function toRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Black or white, whichever reads better on a line colour. Uses relative
// luminance so pale lines (orange, teal) get dark text instead of white.
function contrastInk(hex) {
  const [r, g, b] = toRgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.35 ? '#111' : '#fff';
}

const metres = (a, b) => {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const lat = ((a[1] + b[1]) / 2) * RAD;
  return Math.hypot(dLat, dLon * Math.cos(lat)) * EARTH_RADIUS;
};

// The moment in Singapore, measured in seconds along the current service day.
// Before the cutoff the clock is still counting up yesterday's timetable, so
// seconds runs past 86400 and the date/weekday point at yesterday.
function clock() {
  const milliseconds = Date.now() + SGT_OFFSET;
  const secondsOfDay = (((milliseconds % 86400000) + 86400000) % 86400000) / 1000;
  const serviceMs =
    secondsOfDay < SERVICE_DAY_CUTOFF ? milliseconds - 86400000 : milliseconds;
  const serviceDate = new Date(serviceMs);
  return {
    seconds: secondsOfDay < SERVICE_DAY_CUTOFF ? secondsOfDay + 86400 : secondsOfDay,
    day: serviceDate.toISOString().slice(0, 10).replace(/-/g, ''),
    weekday: serviceDate.getUTCDay(),
  };
}

// Service-day seconds -> "HH:MM" on a 24-hour clock. Times past midnight
// (a service day runs on to ~25:00) wrap, so 24:30 renders as "00:30".
function toTimeValue(seconds) {
  const minutes = Math.round(seconds / 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// "HH:MM" from an <input type="time"> -> service-day seconds. The service day
// starts just after midnight, so early-morning wall-clock times belong to the
// same (previous) service day and count past 86400, exactly like the clock.
function fromTimeValue(value) {
  const [hours, minutes] = value.split(':').map(Number);
  const seconds = hours * 3600 + minutes * 60;
  // SERVICE_DAY_CUTOFF is in seconds; compare in the same unit.
  return seconds < SERVICE_DAY_CUTOFF ? seconds + 86400 : seconds;
}

function runningServices(services, { day, weekday }) {
  const active = new Set();
  for (const [id, service] of Object.entries(services)) {
    const exception = service.exceptions[day];
    const activeToday =
      exception === 1
        ? true
        : exception === 2
          ? false
          : service.days[weekday] === 1 && day >= service.start && day <= service.end;
    if (activeToday) active.add(id);
  }
  return active;
}

// Distance along the track at a given moment of a trip: dwells at stations and
// moves at the timetable's speed between them.
function progressAt(path, profile, elapsed) {
  const stops = path.stops;
  if (elapsed <= profile[0][1]) return stops[0];
  for (let i = 1; i < profile.length; i++) {
    const [arrival, departure] = profile[i];
    if (elapsed < arrival) {
      const previousDeparture = profile[i - 1][1];
      const span = arrival - previousDeparture || 1;
      const t = Math.min(1, Math.max(0, (elapsed - previousDeparture) / span));
      return stops[i - 1] + (stops[i] - stops[i - 1]) * t;
    }
    if (elapsed <= departure) return stops[i];
  }
  return stops[stops.length - 1];
}

// The decoders live in src/gtfs-codec.mjs, shared with the build script.

function prepare(data) {
  // Every service carries its own numeric index; trust that rather than the
  // JSON key order, which a feed with numeric-looking ids could reorder.
  const services = data.services;
  const serviceCount = Object.keys(services).length;
  const serviceOrder = new Array(serviceCount);
  for (const [id, service] of Object.entries(services)) {
    serviceOrder[service.i] = id;
  }
  const lines = {};
  // The scrubber spans the timetable itself: first departure to last arrival.
  let first = Infinity;
  let last = -Infinity;
  for (const [key, line] of Object.entries(data.lines)) {
    // Paths share their track geometry; decode each distinct polyline once.
    const coordsPool = line.coords.map(decodeCoords);
    lines[key] = {
      name: line.name,
      code: line.code || key,
      order: line.order ?? 99,
      color: line.color,
      rgb: toRgb(line.color),
      paths: line.paths.map((path) => {
        const coords = coordsPool[path.c];
        const cumulative = new Float64Array(coords.length);
        for (let i = 1; i < coords.length; i++) {
          cumulative[i] = cumulative[i - 1] + metres(coords[i - 1], coords[i]);
        }
        const profiles = path.p.map(decodeProfile);
        const deltas = decodeInts(path.t);
        const tripCodes = decodeInts(path.tp);
        const trips = new Array(deltas.length);
        // Start times in a flat array for binary search, plus the longest trip
        // so a frame only has to look at trips that could still be running.
        const starts = new Float64Array(deltas.length);
        let maxDuration = 0;
        let start = 0;
        for (let i = 0; i < deltas.length; i++) {
          start += deltas[i];
          starts[i] = start;
          const code = tripCodes[i];
          const profile = Math.floor(code / serviceCount);
          const service = code % serviceCount;
          const minutes = profiles[profile];
          const duration = minutes[minutes.length - 1][1];
          if (duration > maxDuration) maxDuration = duration;
          if (start < first) first = start;
          const arrival = start + duration;
          if (arrival > last) last = arrival;
          trips[i] = { start, profile, service: serviceOrder[service] };
        }
        // Stop distances are stored as monotonic deltas.
        const stopDeltas = decodeInts(path.s);
        const stops = new Float64Array(stopDeltas.length);
        let distanceAlong = 0;
        for (let i = 0; i < stopDeltas.length; i++) {
          distanceAlong += stopDeltas[i];
          stops[i] = distanceAlong;
        }
        return {
          coords,
          cumulative,
          vertexHeading: prepareHeadings(coords, cumulative),
          stops,
          profiles,
          trips,
          starts,
          maxDuration,
        };
      }),
    };
  }
  // Round inwards to whole minutes so both ends have a train on the move.
  const window = {
    start: Math.ceil(first / 60) * 60,
    end: Math.floor(last / 60) * 60,
  };
  // A flat path list so a frame does not have to build an array of entries from
  // the line map every time. Each path carries its line's key and colour, which
  // is all the render loop needs.
  const lineKeys = Object.keys(lines).sort((a, b) => lines[a].order - lines[b].order);
  const paths = [];
  for (const key of lineKeys) {
    const line = lines[key];
    for (const path of line.paths) {
      path.key = key;
      path.rgb = line.rgb;
      paths.push(path);
    }
  }
  return { serviceOrder, lines, lineKeys, paths, window };
}

function bearingOf(a, b) {
  const dLat = b[1] - a[1];
  const dLon = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * RAD);
  return (Math.atan2(dLon, dLat) / RAD + 360) % 360;
}

const TWO_PI = Math.PI * 2;

// Signed shortest turn from one angle to another, so interpolating across the
// ±180° wrap takes the short way round.
function shortestAngle(from, to) {
  let diff = (to - from) % TWO_PI;
  if (diff > Math.PI) diff -= TWO_PI;
  if (diff < -Math.PI) diff += TWO_PI;
  return diff;
}

// Heading at every vertex, smoothed over an arc-length window, plus the
// heading along each segment (a blend of its two end vertices' headings). The
// train reads its orientation by lerping these instead of computing a tangent
// from a short chord: a chord over a fixed distance still jumps the moment it
// crosses a corner vertex, whereas a pre-smoothed vertex heading changes
// gradually through the bend.
function prepareHeadings(coords, cumulative) {
  const n = coords.length;
  const vertexHeading = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const before = positionAtCum(coords, cumulative, Math.max(0, cumulative[i] - HEADING_WINDOW));
    const after = positionAtCum(coords, cumulative, Math.min(cumulative[n - 1], cumulative[i] + HEADING_WINDOW));
    // The car is drawn with its nose on +X, so east (bearing 90°) is 0 rad.
    vertexHeading[i] = (bearingOf(before, after) - 90) * RAD;
  }
  return vertexHeading;
}

// Position at an arc length, given raw coords and their cumulative distances.
function positionAtCum(coords, cumulative, distance) {
  const last = coords.length - 1;
  if (distance <= 0) return coords[0];
  if (distance >= cumulative[last]) return coords[last];
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] <= distance) low = mid;
    else high = mid;
  }
  const span = cumulative[high] - cumulative[low] || 1;
  const t = (distance - cumulative[low]) / span;
  const a = coords[low];
  const b = coords[high];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Point plus an interpolated heading (radians in the shader's convention: the
// car lies flat with its nose on +X, so east is 0). The segment's two vertex
// headings are blended by the along-segment fraction, which keeps the angle
// continuous across every vertex including the ±180° wrap.
//
// The position and heading share one segment lookup rather than each searching
// the cumulative array; the result is written to pointLng/pointLat/pointHeading.
function pointAt(path, distance) {
  const { coords, cumulative, vertexHeading } = path;
  const last = coords.length - 1;
  let low;
  let high;
  let t;
  if (distance <= 0) {
    low = 0;
    high = 1;
    t = 0;
  } else if (distance >= cumulative[last]) {
    low = last - 1;
    high = last;
    t = 1;
  } else {
    low = 0;
    high = last;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] <= distance) low = mid;
      else high = mid;
    }
    const span = cumulative[high] - cumulative[low] || 1;
    t = (distance - cumulative[low]) / span;
  }
  const a = coords[low];
  const b = coords[high];
  pointLng = a[0] + (b[0] - a[0]) * t;
  pointLat = a[1] + (b[1] - a[1]) * t;
  const ha = vertexHeading[low];
  const hb = vertexHeading[Math.min(low + 1, last)];
  pointHeading = ha + shortestAngle(ha, hb) * t;
}

// The car is drawn procedurally by the shader: a rounded body in the line
// colour with a dark border and a black window near the nose, lying flat with
// its nose on +X (east).
const CAR_LENGTH = 38;
const CAR_THICKNESS = 16;

export function createLiveTrains(map) {
  let layersReady = false;
  let glLayer = null;
  // One instance per train: [mercatorX, mercatorY, angle, r, g, b].
  let instanceData = new Float32Array(1024 * INSTANCE_STRIDE);
  let instanceCount = 0;
  const growInstances = (needed) => {
    if (needed * INSTANCE_STRIDE <= instanceData.length) return;
    const next = new Float32Array(Math.max(needed, (instanceData.length / INSTANCE_STRIDE) * 2) * INSTANCE_STRIDE);
    next.set(instanceData);
    instanceData = next;
  };
  const state = {
    visible: false,
    loading: null,
    data: null,
    prepared: null,
    services: new Set(),
    day: '',
    raf: 0,
    nextTick: 0,
    // 'now' follows the clock, 'manual' stays put, 'playing' advances on its
    // own, and 'holding' pauses at the end before rewinding.
    mode: 'now',
    picked: 0,
    rendered: null,
    lastAdvance: 0,
    holdUntil: 0,
    nowMinute: -1,
    // Last whole-minute value written to the scrubber/label, so per-frame
    // frames do not touch the DOM when the minute has not changed.
    shownMinute: -1,
    nowHasTrains: true,
    window: { start: 0, end: 86400 },
    // Multiplier on PLAY_SPEED; 1x is the default pace.
    speed: 1,
    // True while not following the real clock; drives hiding of crowd markers.
    busy: false,
  };

  const ui = {
    panel: document.getElementById('trains-time'),
    slider: document.getElementById('trains-time-slider'),
    field: document.getElementById('trains-time-field'),
    reset: document.getElementById('trains-time-now'),
    play: document.getElementById('trains-time-play'),
    speed: document.getElementById('trains-time-speed'),
    counts: document.getElementById('trains-time-counts'),
  };

  const syncSpeedButton = () => {
    if (!ui.speed) return;
    ui.speed.textContent = state.speed === 0.5 ? '0.5x' : '1x';
    const title = state.speed === 0.5 ? 'Switch to 1x speed' : 'Switch to 0.5x speed';
    ui.speed.title = title;
    ui.speed.setAttribute('aria-label', title);
  };
  syncSpeedButton();
  // Both glyphs live in the button; toggling `hidden` swaps them without
  // replacing the element the pointer is pressed on (which would drop a click).
  const playIcons = ui.play
    ? {
        play: ui.play.querySelector('.trains-icon-play'),
        pause: ui.play.querySelector('.trains-icon-pause'),
      }
    : null;

  // Index of the last trip that has started at or before `seconds`. Trips are
  // stored sorted by start time, so only trips before this index (and within
  // one trip's duration of now) can still be running.
  const lastStartedIndex = (starts, seconds) => {
    let low = 0;
    let high = starts.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (starts[mid] <= seconds) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  };

  // Is anything running right now? Checked once a minute, not on every frame.
  const hasTrainsAt = (seconds) => {
    for (const line of Object.values(state.prepared.lines)) {
      for (const path of line.paths) {
        const last = lastStartedIndex(path.starts, seconds);
        const first = lastStartedIndex(path.starts, seconds - path.maxDuration);
        for (let i = first + 1; i <= last; i++) {
          const trip = path.trips[i];
          if (!state.services.has(trip.service)) continue;
          const profile = path.profiles[trip.profile];
          if (seconds - trip.start <= profile[profile.length - 1][1]) return true;
        }
      }
    }
    return false;
  };

  const syncTimeUi = (time, seconds) => {
    if (!ui.panel) return;
    ui.panel.hidden = !state.visible;
    if (!state.visible) return;
    // The slider and time field only show whole minutes, so writing them every
    // frame is wasted layout/paint work; update only when the minute changes.
    const shownMinute = Math.floor(seconds / 60);
    if (shownMinute !== state.shownMinute) {
      state.shownMinute = shownMinute;
      ui.slider.value = String(shownMinute);
      const value = toTimeValue(seconds);
      // Do not clobber a field the user is editing.
      if (ui.field && ui.field.value !== value && ui.field !== document.activeElement) {
        ui.field.value = value;
      }
    }
    const minute = Math.floor(time.seconds / 60);
    if (minute !== state.nowMinute) {
      state.nowMinute = minute;
      state.nowHasTrains = hasTrainsAt(time.seconds);
    }
    const playing = state.mode === 'playing';
    const atNow = state.mode === 'now';
    // The "Live" button stays in the layout so the row never shifts. It is
    // disabled when already live, or when nothing runs at the real current
    // time (there is no live service to switch to).
    ui.reset.disabled = atNow || !state.nowHasTrains;
    ui.reset.title = atNow
      ? 'Showing live trains'
      : state.nowHasTrains
        ? 'Back to live trains'
        : 'No trains are running right now';
    // Visual state: live is a filled red button; every other state is the
    // white button with a red outline. Off-hours additionally fades it.
    ui.reset.classList.toggle('is-live', atNow);
    ui.reset.classList.toggle('is-off', !atNow && !state.nowHasTrains);
    // Speed only matters while the day is playing back; disable it otherwise.
    if (ui.speed) ui.speed.disabled = !playing;
    if (playIcons) {
      // `.hidden` is not reflected on SVG elements, so use a class.
      playIcons.play.classList.toggle('is-hidden', playing);
      playIcons.pause.classList.toggle('is-hidden', !playing);
    }
    const playTitle = playing ? 'Pause' : 'Play through the day';
    if (ui.play.title !== playTitle) {
      ui.play.title = playTitle;
      ui.play.setAttribute('aria-label', playTitle);
    }
    // Crowd markers only clutter the map when trains are playing or scrubbed to
    // some other time; while following the real clock, keep them visible.
    const busy = state.mode !== 'now';
    if (busy !== state.busy) {
      state.busy = busy;
      document.body.classList.toggle('trains-busy', busy);
    }
  };

  const addLayers = () => {
    if (map.getLayer(GL_LAYER)) return;
    glLayer = createInstancedTrainLayer(map);
    map.addLayer(glLayer);
  };

  // The toggle can be pressed before the basemap has finished loading, and a
  // source cannot be added to a style that is not there yet.
  const ensureLayers = () => {
    if (layersReady) return;
    layersReady = true;
    if (map.isStyleLoaded()) {
      addLayers();
      return;
    }
    // isStyleLoaded() also waits for the basemap's sources, so it can be false
    // long after the style itself is ready to accept a layer. Try now, and
    // keep the style.load fallback for the case where it really is too early.
    map.once('style.load', addLayers);
    try {
      addLayers();
    } catch {}
  };

  // Per-line train counts as coloured pills next to the scrubber, with the
  // fleet total in front. Every line is always shown (a zero still renders,
  // dimmed) so the row neither reflows nor hides a line that later wakes up.
  // `counts` maps line key -> running count; missing keys read as 0.
  // The pill row is rebuilt only when the line set changes. Counts change every
  // frame while playing, and recreating ~7 nodes per line each time churned
  // thousands of DOM nodes a second, so existing pills are updated in place.
  let countPills = null;

  const buildCounts = (keys) => {
    const lines = state.prepared.lines;
    const fragment = document.createDocumentFragment();
    const totalEl = document.createElement('span');
    totalEl.className = 'trains-count-total';
    fragment.append(totalEl);
    const pills = new Map();
    for (const key of keys) {
      const line = lines[key];
      const pill = document.createElement('span');
      pill.className = 'trains-count-pill';
      pill.style.setProperty('--line-color', line.color);
      pill.style.setProperty('--line-fg', contrastInk(line.color));
      // A small inverted badge names the line, since the LRT loops all share
      // the same grey and the count alone does not say which is which.
      const badge = document.createElement('span');
      badge.className = 'trains-count-badge';
      badge.textContent = line.code;
      const value = document.createElement('span');
      value.className = 'trains-count-value';
      pill.append(badge, value);
      fragment.append(pill);
      pills.set(key, { pill, value, last: -1 });
    }
    ui.counts.replaceChildren(fragment);
    countPills = { totalEl, pills, keys, total: -1 };
  };

  const renderCounts = (counts) => {
    if (!ui.counts) return;
    const lines = state.prepared.lines;
    const keys = Object.keys(lines).sort((a, b) => lines[a].order - lines[b].order);
    const sameSet =
      countPills &&
      countPills.keys.length === keys.length &&
      countPills.keys.every((key, i) => key === keys[i]);
    if (!sameSet) buildCounts(keys);

    let total = 0;
    for (const key of keys) {
      const count = counts[key] || 0;
      total += count;
      const entry = countPills.pills.get(key);
      // Writing textContent is the expensive part, so only do it when the
      // number actually changed.
      if (entry.last !== count) {
        entry.last = count;
        entry.value.textContent = String(count);
        entry.pill.classList.toggle('is-empty', count === 0);
        entry.pill.setAttribute('aria-label', `${lines[key].code}: ${count} on the ${lines[key].name}`);
        entry.pill.title = `${count} on the ${lines[key].name}`;
      }
    }
    if (countPills.total !== total) {
      countPills.total = total;
      countPills.totalEl.textContent = `${total} ${total === 1 ? 'train' : 'trains'}`;
    }
  };

  // Trips drawn last frame, so any that vanish can be faded out where they
  // were. Animation state lives on each trip record and is stamped with a
  // frame counter, so a steady frame allocates nothing and finds departures
  // in O(1) (the stamp no longer matches).
  let activeTrips = [];
  // Holds the frame being built, then swaps with activeTrips at the end of the
  // frame. Reusing the two arrays keeps the render loop allocation-free.
  let spareActive = [];
  let lastRenderAt = 0;
  let frameGen = 0;

  // Eased 0..1 curve. Trains fade on this so motion starts and ends gently
  // instead of the linear ramp a per-frame step produces.
  const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

  const renderFrame = (seconds, counts) => {
    const now = performance.now();
    // Wall-clock ms since the last frame, capped so a paused loop or a
    // backgrounded tab cannot jump a fade straight to its end in one step.
    const elapsedMs = lastRenderAt ? Math.min(now - lastRenderAt, FADE_MAX_STEP_MS) : 0;
    lastRenderAt = now;
    frameGen++;

    let settling = false;
    let count = 0;
    const draw = (anim) => {
      if (anim.enter < 1 || anim.leave > 0) settling = true;
      if (anim.alpha <= 0) return;
      if ((count + 1) * INSTANCE_STRIDE > instanceData.length) growInstances(count + 1);
      const offset = count * INSTANCE_STRIDE;
      localMercator(anim.lng, anim.lat);
      instanceData[offset] = mercX;
      instanceData[offset + 1] = mercY;
      instanceData[offset + 2] = anim.heading;
      instanceData[offset + 3] = anim.rgb[0];
      instanceData[offset + 4] = anim.rgb[1];
      instanceData[offset + 5] = anim.rgb[2];
      instanceData[offset + 6] = anim.alpha;
      instanceData[offset + 7] = anim.grow;
      count++;
    };

    // Reuse the previous frame's array as this frame's output buffer, so a
    // steady frame allocates nothing for the train lists either.
    const nextActive = spareActive;
    nextActive.length = 0;
    for (const key of state.prepared.lineKeys) counts[key] = 0;
    for (const path of state.prepared.paths) {
      // Only trips that have started and are still within one trip's
      // duration of now can be running; the rest are skipped.
      const last = lastStartedIndex(path.starts, seconds);
      const first = lastStartedIndex(path.starts, seconds - path.maxDuration);
      for (let tripIndex = first + 1; tripIndex <= last; tripIndex++) {
        const trip = path.trips[tripIndex];
        if (!state.services.has(trip.service)) continue;
        const elapsed = seconds - trip.start;
        const profile = path.profiles[trip.profile];
        if (elapsed > profile[profile.length - 1][1]) continue;
        pointAt(path, progressAt(path, profile, elapsed));
        let anim = trip.anim;
        if (!anim) {
          // Enter at its current heading (no spin-in) and full size, then
          // fade in with a gentle scale swell.
          anim = trip.anim = { enter: 0, leave: 0, lng: 0, lat: 0, rgb: path.rgb, heading: 0 };
        }
        // The heading is already continuous in space (smoothed vertex
        // chords), so it follows the track directly. Easing it in time would
        // lag the rotation behind the moving body, reading as an off-centre
        // pivot.
        anim.heading = pointHeading;
        // Coming back after a fade-out, reverse it from wherever it got to
        // rather than restarting at zero.
        anim.enter = Math.min(1, anim.enter + elapsedMs / TRAIN_FADE_MS);
        anim.leave = Math.max(0, anim.leave - elapsedMs / TRAIN_FADE_MS);
        anim.alpha = smoothstep(anim.enter) * (1 - smoothstep(anim.leave));
        anim.grow = TRAIN_MIN_GROW + (1 - TRAIN_MIN_GROW) * anim.enter;
        anim.lng = pointLng;
        anim.lat = pointLat;
        anim.rgb = path.rgb;
        anim.gen = frameGen;
        nextActive.push(trip);
        counts[path.key]++;
        draw(anim);
      }
    }

    // Trains in the previous frame that were not refreshed this one fade out
    // where they last were, then are forgotten.
    for (const trip of activeTrips) {
      const anim = trip.anim;
      if (!anim || anim.gen === frameGen) continue;
      anim.leave = Math.min(1, anim.leave + elapsedMs / TRAIN_FADE_MS);
      anim.alpha = smoothstep(anim.enter) * (1 - smoothstep(anim.leave));
      if (anim.leave >= 1) {
        trip.anim = null;
        continue;
      }
      anim.grow = TRAIN_MIN_GROW + (1 - TRAIN_MIN_GROW) * (1 - smoothstep(anim.leave));
      draw(anim);
    }

    // The array just walked as activeTrips is now free to be rebuilt next frame.
    spareActive = activeTrips;
    activeTrips = nextActive;
    instanceCount = count;
    if (glLayer) glLayer.setInstances(instanceData, instanceCount);
    map.triggerRepaint();
    state.settling = settling;
  };

  // Reused across frames; renderFrame zeroes it before counting per line.
  const counts = {};

  const update = (time, seconds) => {
    if (time.day !== state.day) {
      state.day = time.day;
      state.services = runningServices(state.data.services, time);
    }
    renderFrame(seconds, counts);
    renderCounts(counts);
    state.rendered = state.mode === 'manual' ? seconds : null;
  };

  const currentSeconds = (time) => (state.mode === 'now' ? time.seconds : state.picked);

  const startLoop = () => {
    if (state.raf) return;
    state.nextTick = performance.now();
    state.lastAdvance = state.nextTick;
    state.raf = requestAnimationFrame(tick);
  };

  const redraw = () => {
    const time = clock();
    const seconds = currentSeconds(time);
    update(time, seconds);
    syncTimeUi(time, seconds);
    startLoop();
  };

  const advance = (now) => {
    const delta = Math.min((now - state.lastAdvance) / 1000, 0.5);
    state.lastAdvance = now;
    if (state.mode === 'playing') {
      state.picked += delta * PLAY_SPEED * state.speed;
      if (state.picked >= state.window.end) {
        state.picked = state.window.end;
        state.mode = 'holding';
        state.holdUntil = now + END_HOLD_MS;
      }
    } else if (state.mode === 'holding' && now >= state.holdUntil) {
      // Back to the first train, ready to play again.
      state.mode = 'manual';
      state.picked = state.window.start;
      state.rendered = null;
    }
  };

  const tick = () => {
    if (!state.visible) return;
    const now = performance.now();
    if (state.mode === 'manual' && state.rendered !== null && !state.settling) {
      // Nothing changes until the user scrubs or presses play/now; those
      // handlers redraw and restart the loop themselves. Keep going while
      // trains are still fading in or out.
      state.raf = 0;
      return;
    }
    // Live mode picks its rate from zoom (coarse steps are invisible zoomed
    // out, obvious zoomed in); play/scrub always need the smooth rate. Fades
    // deliberately do not boost the rate: over 200 trains one is almost always
    // entering or leaving, so a settling-triggered boost would pin the loop at
    // 30fps and erase the saving.
    let interval = TICK_MS;
    if (state.mode === 'now') {
      const zoom = map.getZoom();
      interval = zoom >= NOW_FAST_ZOOM ? NOW_FAST_MS : zoom >= NOW_MID_ZOOM ? NOW_MID_MS : NOW_SLOW_MS;
    }
    // When the rate rises after a zoom change, the old deadline can be up to a
    // slow tick away; pull it in so the faster rate starts immediately.
    if (state.nextTick - now > interval) state.nextTick = now + interval;
    if (now >= state.nextTick) {
      // Step the deadline rather than resetting it to now, so a frame that
      // lands slightly late doesn't drag the whole rate down. If we fall a
      // few frames behind (a slow frame, a hidden tab), resync instead of
      // bursting to catch up.
      state.nextTick += interval;
      if (now - state.nextTick > interval * 4) state.nextTick = now + interval;
      advance(now);
      const time = clock();
      const seconds = currentSeconds(time);
      const started = DEBUG_TRAINS ? performance.now() : 0;
      update(time, seconds);
      syncTimeUi(time, seconds);
      if (DEBUG_TRAINS) {
        state.frameMs = (state.frameMs || 0) * 0.9 + (performance.now() - started) * 0.1;
        state.frameCount = (state.frameCount || 0) + 1;
        if (now - (state.debugAt || 0) > 2000) {
          state.debugAt = now;
          console.log(
            `[trains] update ${state.frameMs.toFixed(2)}ms, ${instanceCount} instances, ${(state.frameCount / 2).toFixed(0)} updates/s`,
          );
          state.frameCount = 0;
        }
      }
    }
    state.raf = requestAnimationFrame(tick);
  };

  if (ui.slider) {
    ui.slider.addEventListener('input', () => {
      state.mode = 'manual';
      state.picked = Number(ui.slider.value) * 60;
      state.rendered = null;
      redraw();
    });
  }
  // Pick a time directly. The field covers 00:00–23:59 while the timetable
  // window is only part of that, so an out-of-hours (or blank/invalid) value
  // is clamped to the nearest end the slider can actually reach.
  if (ui.field) {
    const pick = () => {
      const value = ui.field.value;
      const valid = /^\d{2}:\d{2}$/.test(value);
      const raw = valid ? fromTimeValue(value) : clock().seconds;
      const clamped = Math.min(state.window.end, Math.max(state.window.start, raw));
      state.mode = 'manual';
      state.picked = clamped;
      // Force the next sync to repaint the slider and field, even if the whole
      // minute happens to match the last one shown.
      state.shownMinute = -1;
      state.rendered = null;
      redraw();
    };
    ui.field.addEventListener('change', pick);
  }
  if (ui.reset) {
    ui.reset.addEventListener('click', () => {
      state.mode = 'now';
      state.rendered = null;
      redraw();
    });
  }
  if (ui.speed) {
    ui.speed.addEventListener('click', () => {
      if (state.mode !== 'playing') return;
      state.speed = state.speed === 1 ? 0.5 : 1;
      syncSpeedButton();
    });
  }
  if (ui.play) {
    ui.play.addEventListener('click', () => {
      if (state.mode === 'playing') {
        state.mode = 'manual';
      } else {
        if (state.mode === 'now') state.picked = clock().seconds;
        if (state.picked < state.window.start || state.picked >= state.window.end) {
          state.picked = state.window.start;
        }
        state.mode = 'playing';
      }
      state.lastAdvance = performance.now();
      state.rendered = null;
      redraw();
    });
  }

  const load = () => {
    if (!state.loading) {
      state.loading = fetch(trainsUrl)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then((data) => {
          state.data = data;
          state.prepared = prepare(data);
          const feedEnd = data.feed && data.feed.end;
          if (feedEnd && feedEnd < clock().day) {
            console.warn(`Timetable expired on ${feedEnd}; trains are no longer current.`);
          }
          state.window = state.prepared.window;
          state.day = '';
          state.picked = state.window.start;
          if (ui.slider) {
            ui.slider.min = String(Math.floor(state.window.start / 60));
            ui.slider.max = String(Math.ceil(state.window.end / 60));
          }
          return data;
        })
        .catch((error) => {
          state.loading = null;
          throw error;
        });
    }
    return state.loading;
  };

  const enable = async () => {
    await load();
    if (state.visible) return true;
    state.visible = true;
    state.mode = 'now';
    state.rendered = null;
    state.nowMinute = -1;
    state.shownMinute = -1;
    state.busy = false;
    document.body.classList.remove('trains-busy');
    // Start from a clean animation frame so the first render fades in.
    activeTrips = [];
    lastRenderAt = 0;
    // Adds the source and layer now, or as soon as the style is ready.
    ensureLayers();
    redraw();
    return true;
  };

  const disable = () => {
    state.visible = false;
    state.rendered = null;
    state.mode = 'now';
    state.nowMinute = -1;
    state.busy = false;
    document.body.classList.remove('trains-busy');
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    for (const trip of activeTrips) if (trip.anim) trip.anim = null;
    activeTrips = [];
    lastRenderAt = 0;
    state.settling = false;
    state.shownMinute = -1;
    instanceCount = 0;
    if (glLayer) glLayer.setInstances(instanceData, 0);
    map.triggerRepaint();
    if (ui.panel) ui.panel.hidden = true;
    return false;
  };

  return {
    enable,
    disable,
    get visible() {
      return state.visible;
    },
    toggle: async () => (state.visible ? disable() : enable()),
  };
}

// Column-major 4x4 multiply: out = a * b.
function multiplyMat4(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

const TRAIN_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 aCorner;
in vec2 aCenter;
in float aAngle;
in vec3 aColor;
in float aAlpha;
in float aGrow;

uniform mat4 uMatrix;
uniform float uUnitsPerPixel;
uniform float uScale;
uniform vec2 uBaseSize;

out vec2 vLocal;
out vec3 vColor;
out float vAlpha;

void main() {
  vec2 local = aCorner * uBaseSize;
  float c = cos(aAngle);
  float s = sin(aAngle);
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 pos = aCenter + rotated * uScale * aGrow * uUnitsPerPixel;
  gl_Position = uMatrix * vec4(pos, 0.0, 1.0);
  vLocal = local;
  vColor = aColor;
  vAlpha = aAlpha;
}`;

const TRAIN_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vLocal;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

void main() {
  // Base geometry in icon pixels; uScale handles zoom, so these stay fixed.
  const float W = 38.0;
  const float H = 16.0;
  const float R = 5.0;
  const float STROKE = 2.0;
  const float WIN_FROM_NOSE = 4.0;
  const float WIN_LEN = 6.0;
  const float WIN_THICK = 8.0;
  const float WIN_R = 2.0;

  vec2 p = vLocal;
  float aa = max(fwidth(p.x), 0.0001);

  float dOuter = sdRoundBox(p, vec2(W, H) * 0.5, R + STROKE * 0.5);
  float dInner = sdRoundBox(
    p,
    vec2(W - STROKE * 2.0, H - STROKE * 2.0) * 0.5,
    max(R - STROKE * 0.5, 0.5)
  );
  float outer = 1.0 - smoothstep(-aa, aa, dOuter);
  float inner = 1.0 - smoothstep(-aa, aa, dInner);

  vec2 winCenter = vec2(W * 0.5 - WIN_FROM_NOSE - WIN_LEN * 0.5, 0.0);
  float dWin = sdRoundBox(p - winCenter, vec2(WIN_LEN, WIN_THICK) * 0.5, WIN_R);
  float win = 1.0 - smoothstep(-aa, aa, dWin);

  vec3 color = mix(vec3(0.0667), vColor, inner);
  color = mix(color, vec3(0.0), win * inner);
  // MapLibre's blend expects premultiplied alpha.
  float alpha = outer * vAlpha;
  outColor = vec4(color * alpha, alpha);
}`;

// Draws every train as one instanced, procedurally shaded quad. The CPU only
// writes ~400 instances per frame and MapLibre draws them in a single call;
// there is no GeoJSON source, so no per-frame parsing or tiling.
function createInstancedTrainLayer(map) {
  let gl = null;
  let program = null;
  let vao = null;
  let quadBuffer = null;
  let instanceBuffer = null;
  let capacity = 0;
  let count = 0;
  let data = null;
  let dirty = false;
  let uniforms = null;
  const mvp = new Float32Array(16);
  // Relative-to-origin view-projection: mainMatrix * translate(origin).
  const translation = new Float64Array(16);
  translation[0] = translation[5] = translation[10] = translation[15] = 1;
  translation[12] = ORIGIN_X;
  translation[13] = ORIGIN_Y;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Train shader failed: ${log}`);
    }
    return shader;
  };

  const grow = (needed) => {
    if (needed <= capacity) return;
    capacity = Math.max(needed, Math.max(256, capacity * 2));
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * INSTANCE_STRIDE * 4, gl.DYNAMIC_DRAW);
  };

  const layer = {
    id: GL_LAYER,
    type: 'custom',
    renderingMode: '2d',

    // Debug hook used by ?trainsdebug to check the GPU transform against
    // map.project().
    getDebug() {
      return { count, data, mvp, capacity };
    },

    onAdd(_map, context) {
      gl = context;
      const vertex = compile(gl.VERTEX_SHADER, TRAIN_VERTEX_SHADER);
      const fragment = compile(gl.FRAGMENT_SHADER, TRAIN_FRAGMENT_SHADER);
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Train program failed: ${gl.getProgramInfoLog(program)}`);
      }

      uniforms = {
        matrix: gl.getUniformLocation(program, 'uMatrix'),
        unitsPerPixel: gl.getUniformLocation(program, 'uUnitsPerPixel'),
        scale: gl.getUniformLocation(program, 'uScale'),
        baseSize: gl.getUniformLocation(program, 'uBaseSize'),
      };

      quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);

      instanceBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      capacity = 1024;
      gl.bufferData(gl.ARRAY_BUFFER, capacity * INSTANCE_STRIDE * 4, gl.DYNAMIC_DRAW);

      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      const stride = INSTANCE_STRIDE * 4;
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 8);
      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 12);
      gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 24);
      gl.vertexAttribDivisor(4, 1);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 28);
      gl.vertexAttribDivisor(5, 1);

      gl.bindVertexArray(null);
    },

    setInstances(nextData, nextCount) {
      data = nextData;
      count = nextCount;
      dirty = true;
    },

    render(context, args) {
      if (!program || !count || !data) return;
      gl = context;
      grow(count);

      gl.useProgram(program);
      if (dirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * INSTANCE_STRIDE));
        dirty = false;
      }

      // Match the old symbol layer's icon-size curve: 0.34 at zoom 10,
      // 1.1 at zoom 17.5.
      const zoom = map.getZoom();
      const t = Math.min(1, Math.max(0, (zoom - 10) / 7.5));
      const scale = 0.34 + t * 0.76;

      multiplyMat4(mvp, args.defaultProjectionData.mainMatrix, translation);
      gl.uniformMatrix4fv(uniforms.matrix, false, mvp);
      gl.uniform1f(uniforms.scale, scale);
      gl.uniform1f(uniforms.unitsPerPixel, 1 / (512 * Math.pow(2, zoom)));
      gl.uniform2f(uniforms.baseSize, CAR_LENGTH, CAR_THICKNESS);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.bindVertexArray(null);
    },

    onRemove() {
      if (program) gl.deleteProgram(program);
      if (quadBuffer) gl.deleteBuffer(quadBuffer);
      if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
      if (vao) gl.deleteVertexArray(vao);
      program = quadBuffer = instanceBuffer = vao = null;
    },
  };
  if (DEBUG_TRAINS) window.$trainsGL = layer;
  return layer;
}
