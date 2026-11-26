import {
  prepare,
  buildInstances,
  createTrainOverlay,
  FADE,
  RAMP,
  RAMP_SHARE,
  INSTANCE_STRIDE,
} from './gpu-trains';
import { loadTimetable } from './timetable.mjs';
import { contrastInk } from './line-color.mjs';
import {
  clock,
  runningServices,
  scheduledDayType,
  serviceWeekday,
  SERVICE_DAY_CUTOFF,
} from './service-day.mjs';

// Redraw rate while playing or scrubbing. The overlay draw is cheap, so
// playback uses the display rate.
const TICK_MS = 1000 / 60;
// Following the real clock, a train's per-tick pixel step depends on zoom: a
// fixed ~12 m/s is well under a pixel per tick zoomed out but many pixels
// zoomed in. The live view therefore picks its rate from zoom so the step
// stays roughly constant and invisible, while avoiding compositing work the
// eye cannot see at low zoom.
const NOW_FAST_MS = 1000 / 60; // zoomed right in
const NOW_MID_MS = 1000 / 30; // mid zoom
const NOW_SLOW_MS = 1000 / 10; // zoomed out
const NOW_MID_ZOOM = 15; // below this, 10fps is imperceptible
const NOW_FAST_ZOOM = 18; // above this, 60fps keeps the step under a pixel

// Playback speed in simulated seconds per real second. 1 = real time, 60 = one
// simulated minute per real second, 30 = half that pace. The cycle climbs the
// list and wraps back to real time.
const PLAY_SPEED_REALTIME = 1;
const PLAY_SPEED_SLOW = 30;
const PLAY_SPEED_MEDIUM = 60;
const PLAY_SPEED_FAST = 120;
const PLAY_SPEED_FASTER = 240;
const PLAY_SPEED_FASTEST = 480;
const PLAY_SPEEDS = [
  PLAY_SPEED_REALTIME,
  PLAY_SPEED_SLOW,
  PLAY_SPEED_MEDIUM,
  PLAY_SPEED_FAST,
  PLAY_SPEED_FASTER,
  PLAY_SPEED_FASTEST,
];
// Share of a leg the acceleration ramp may use once playback is too fast for a
// wall-clock ramp to read at all. 0.5 is a full triangular profile.
const RAMP_SHARE_MAX = 0.5;
const END_HOLD_MS = 1500;

function nextPlaySpeed(speed) {
  const index = PLAY_SPEEDS.indexOf(speed);
  return PLAY_SPEEDS[(index + 1) % PLAY_SPEEDS.length];
}

const DEBUG_TRAINS = new URLSearchParams(location.search).has('trainsdebug');
// Wall-clock interval between overlay active-trip list rebuilds.
const REBUILD_MS = 100;
// Trains fade in when the layer is first shown.
const REVEAL_MS = 700;
// When the clock is frozen (paused/scrubbed) there is no time for a fade to
// play in, so use a fade this short: trains are either present or not.
const STATIC_FADE = 0.05;

// The five LRT loops share #748477. A low-chroma line colour like that gets a
// single chart band, so the five indistinguishable grays don't stack five times.
function isGrayColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  return max === 0 || (max - Math.min(r, g, b)) / max < 0.2;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Service-day seconds -> "HH:MM:SS" on a 24-hour clock. Times past midnight
// (a service day runs on to ~25:00) wrap, so 24:30:15 renders as "00:30:15".
function toTimeValue(seconds) {
  const total = Math.round(seconds) % (24 * 60 * 60);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// "HH:MM" or "HH:MM:SS" from an <input type="time"> -> service-day seconds.
// The service day starts just after midnight, so early-morning wall-clock
// times belong to the same (previous) service day and count past 86400, exactly
// like the clock.
function fromTimeValue(value) {
  const [hours, minutes, seconds = 0] = value.split(':').map(Number);
  const total = hours * 3600 + minutes * 60 + seconds;
  // SERVICE_DAY_CUTOFF is in seconds; compare in the same unit.
  return total < SERVICE_DAY_CUTOFF ? total + 86400 : total;
}

export function createLiveTrains(map) {
  let overlay = null;
  // Active trips written by buildInstances, INSTANCE_STRIDE floats each.
  let instanceData = new Float32Array(4096 * INSTANCE_STRIDE);
  let instanceCount = 0;
  const state = {
    visible: false,
    loading: null,
    data: null,
    prepared: null,
    services: new Set(),
    holidays: new Set(),
    // The timetable day currently shown ('weekdays', 'saturdays' or
    // 'holidays'), and a user override that wins over the calendar.
    dayType: '',
    dayOverride: null,
    serviceKey: '',
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
    // Last whole-minute value written to the scrubber and last whole-second
    // value written to the time field, so per-frame updates do not touch the
    // DOM when the displayed value has not changed.
    shownMinute: -1,
    shownSecond: -1,
    nowHasTrains: true,
    window: { start: 0, end: 86400 },
    // Minutes of the first departure and last arrival, for the scale labels.
    endMarks: null,
    // The same, restricted to MRT/LRT services, for the secondary scale marks.
    mrtEndMarks: null,
    // Simulated seconds per real second; 30x is the default pace.
    speed: PLAY_SPEED_SLOW,
    // True while not following the real clock; drives hiding of crowd markers.
    busy: false,
    // Wall-clock start of the reveal fade when the layer is shown.
    revealStart: 0,
    // When the overlay's active-trip list was last rebuilt (sim second and
    // wall clock), so the loop does not rebuild it every frame.
    rebuildSecond: -1,
    rebuildAt: 0,
    lastFade: -1,
    // Ramp profile for new legs, and the previous one that legs already under
    // way keep using so a speed change never moves a train mid-leg.
    ease: {
      ramp: RAMP,
      share: RAMP_SHARE,
      fromRamp: RAMP,
      fromShare: RAMP_SHARE,
      switchAt: 0,
    },
    lastSeconds: 0,
  };

  const ui = {
    panel: document.getElementById('trains-time'),
    slider: document.getElementById('trains-time-slider'),
    sliderWrap: document.getElementById('trains-time-slider-wrap'),
    sliderChart: document.getElementById('trains-time-slider-chart'),
    sliderLabels: document.getElementById('trains-time-slider-labels'),
    day: document.getElementById('trains-time-day'),
    field: document.getElementById('trains-time-field'),
    reset: document.getElementById('trains-time-now'),
    play: document.getElementById('trains-time-play'),
    speed: document.getElementById('trains-time-speed'),
    total: document.getElementById('trains-time-total'),
    pills: document.getElementById('trains-time-pills'),
  };

  const syncDayUi = () => {
    if (!ui.day || !state.dayType) return;
    if (ui.day.value !== state.dayType) ui.day.value = state.dayType;
  };

  const sliderBounds = () => {
    if (!ui.slider) return null;
    const min = Number(ui.slider.min);
    const max = Number(ui.slider.max);
    return max > min ? { min, max } : null;
  };

  // Draw the day's running-train profile behind the scale. Trips are bucketed
  // per minute into a difference array, then accumulated into stacked bands
  // (one per line, with the gray LRT loops merged) so the chart's top edge is
  // the fleet total at that minute.
  const buildSliderChart = () => {
    const chart = ui.sliderChart;
    if (!chart || !state.prepared) return;
    const { start, end } = state.window;
    const minutes = Math.max(1, Math.round((end - start) / 60));

    const groups = new Map();
    for (const key of state.prepared.lineKeys) {
      const line = state.prepared.lines[key];
      const groupKey = isGrayColor(line.color) ? 'gray' : key;
      const group = groups.get(groupKey);
      if (group) {
        group.order = Math.min(group.order, line.order);
      } else {
        groups.set(groupKey, {
          color: line.color,
          order: line.order,
          values: new Float32Array(minutes + 1),
        });
      }
    }

    const offsetMinutes = start / 60;
    for (const path of state.prepared.paths) {
      const line = state.prepared.lines[path.key];
      if (!line) continue;
      const group = groups.get(isGrayColor(line.color) ? 'gray' : path.key);
      if (!group) continue;
      for (const trip of path.trips) {
        if (!state.services.has(trip.service)) continue;
        const from = Math.max(0, Math.min(minutes, Math.floor(trip.start / 60 - offsetMinutes)));
        const to = Math.max(
          0,
          Math.min(minutes, Math.ceil((trip.start + trip.duration) / 60 - offsetMinutes)),
        );
        if (to <= from) continue;
        group.values[from] += 1;
        group.values[to] -= 1;
      }
    }

    const series = [...groups.values()].sort((a, b) => a.order - b.order);
    const totals = new Float32Array(minutes + 1);
    for (const group of series) {
      let running = 0;
      for (let i = 0; i <= minutes; i++) {
        running += group.values[i];
        group.values[i] = running;
        totals[i] += running;
      }
    }
    let peak = 0;
    for (let i = 0; i <= minutes; i++) if (totals[i] > peak) peak = totals[i];
    if (!peak) {
      chart.replaceChildren();
      return;
    }

    // About sixty samples is plenty for a strip this wide; keeping the path
    // coordinates whole numbers keeps the markup compact.
    const stride = Math.max(1, Math.round(minutes / 60));
    const xs = [];
    for (let x = 0; x < minutes; x += stride) xs.push(x);
    xs.push(minutes);

    const height = 100;
    const headroom = 6;
    const y = (value) => Math.round(height - (value / peak) * (height - headroom));
    const fragment = document.createDocumentFragment();
    const below = new Float32Array(minutes + 1);
    const above = new Float32Array(minutes + 1);
    for (const group of series) {
      let banded = false;
      for (let i = 0; i <= minutes; i++) {
        above[i] = below[i] + group.values[i];
        if (group.values[i]) banded = true;
      }
      if (banded) {
        let d = '';
        for (const x of xs) d += `${d ? 'L' : 'M'}${x},${y(above[x])}`;
        for (let i = xs.length - 1; i >= 0; i--) d += `L${xs[i]},${y(below[xs[i]])}`;
        const area = document.createElementNS(SVG_NS, 'path');
        area.setAttribute('d', `${d}Z`);
        area.setAttribute('fill', group.color);
        area.setAttribute('fill-opacity', '0.5');
        fragment.append(area);
      }
      below.set(above);
    }
    chart.setAttribute('viewBox', `0 0 ${minutes} ${height}`);
    chart.replaceChildren(fragment);
  };

  // The two attractions' people movers run longer than the rail network and
  // would stretch the MRT/LRT service window to theirs.
  const isNonRailLine = (name) => /Skytrain|Sentosa/i.test(name);

  // A clock-time label for the scale, e.g. "5am", "12pm" or "6:30pm".
  const formatMark = (minutes) => {
    const total = minutes % (24 * 60);
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    const suffix = hours < 12 ? 'am' : 'pm';
    return mins === 0 ? `${hour12}${suffix}` : `${hour12}:${String(mins).padStart(2, '0')}${suffix}`;
  };

  // The scale inside the bar: the service's first and last train plus noon,
  // 6pm and midnight when they fall inside it. Labels are placed by value, so
  // they move with the window if the feed changes.
  const buildSliderLabels = () => {
    if (!ui.sliderLabels) return;
    const bounds = sliderBounds();
    if (!bounds) {
      ui.sliderLabels.replaceChildren();
      return;
    }
    const span = bounds.max - bounds.min;
    const ends = state.endMarks || { start: bounds.min, end: bounds.max };
    const marks = [];
    const add = (minute, edge, secondary = false) => {
      if (minute < bounds.min || minute > bounds.max) return;
      const percent = ((minute - bounds.min) / span) * 100;
      // Skip a label that would collide with one already placed. Primary and
      // secondary labels sit on opposite edges of the bar, so they only compete
      // within their own row.
      if (
        marks.some(
          (mark) =>
            mark.secondary === secondary && Math.abs(mark.percent - percent) < 3,
        )
      ) {
        return;
      }
      marks.push({ percent, label: formatMark(minute), edge, secondary });
    };
    add(ends.start, 'start');
    add(ends.end, 'end');
    if (state.mrtEndMarks) {
      add(state.mrtEndMarks.start, 'start', true);
      add(state.mrtEndMarks.end, 'end', true);
    }
    add(12 * 60);
    add(18 * 60);
    add(24 * 60);
    marks.sort((a, b) => a.percent - b.percent);
    const fragment = document.createDocumentFragment();
    for (const mark of marks) {
      const el = document.createElement('span');
      el.className = 'trains-slider-mark';
      if (mark.secondary) el.classList.add('is-secondary');
      el.style.left = `${mark.percent}%`;
      if (mark.edge) el.classList.add(`is-${mark.edge}`);
      const tick = document.createElement('i');
      tick.className = 'trains-slider-tick';
      const label = document.createElement('span');
      label.className = 'trains-slider-label';
      label.textContent = mark.label;
      el.append(tick, label);
      fragment.append(el);
    }
    ui.sliderLabels.replaceChildren(fragment);
    cullOverlappingMarks();
  };

  // The reachable part of the day for the services running on the selected
  // timetable, as the raw first departure and last arrival. Different days
  // have different first and last trains, so this cannot come from the whole
  // feed.
  const extentsFor = (services) => {
    const prepared = state.prepared;
    let first = Infinity;
    let last = -Infinity;
    for (const id of services) {
      const extent = prepared.serviceWindows.get(id);
      if (!extent) continue;
      if (extent.first < first) first = extent.first;
      if (extent.last > last) last = extent.last;
    }
    if (!Number.isFinite(first) || !Number.isFinite(last)) return prepared.extent;
    return { first, last };
  };

  // First departure and last arrival across only the MRT/LRT lines, so the
  // secondary scale marks describe the rail network rather than the attractions.
  const railExtentsFor = (services) => {
    let first = Infinity;
    let last = -Infinity;
    for (const path of state.prepared.paths) {
      const line = state.prepared.lines[path.key];
      if (!line || isNonRailLine(line.name)) continue;
      for (const trip of path.trips) {
        if (!services.has(trip.service)) continue;
        if (trip.start < first) first = trip.start;
        const end = trip.start + trip.duration;
        if (end > last) last = end;
      }
    }
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
    return { first, last };
  };

  // Point the scrubber at the selected timetable's window and pull the picked
  // time inside it. The window sits a minute either side of the real service
  // ends so both ends start and finish with nothing running; the scale is
  // labelled with the real ends, not the bleed.
  const applyWindow = () => {
    const { first, last } = extentsFor(state.services);
    state.window = {
      start: Math.ceil(first / 60) * 60 - 60,
      end: Math.floor(last / 60) * 60 + 60,
    };
    if (state.window.end <= state.window.start) state.window = state.prepared.window;
    // The scale marks the first departure and last arrival minutes, one minute
    // inside the bleed the bar gives them.
    state.endMarks = { start: Math.ceil(first / 60), end: Math.floor(last / 60) };
    const rail = railExtentsFor(state.services);
    state.mrtEndMarks = rail
      ? { start: Math.ceil(rail.first / 60), end: Math.floor(rail.last / 60) }
      : null;
    if (ui.slider) {
      ui.slider.min = String(Math.floor(state.window.start / 60));
      ui.slider.max = String(Math.ceil(state.window.end / 60));
    }
    if (state.picked < state.window.start || state.picked > state.window.end) {
      state.picked = Math.min(state.window.end, Math.max(state.window.start, state.picked));
      // The loop may already have drawn this frame from the old time, so paint
      // the clamp straight to the controls and resync the next frame.
      state.shownMinute = -1;
      state.shownSecond = -1;
      if (ui.slider) ui.slider.value = String(Math.floor(state.picked / 60));
      if (ui.field && ui.field !== document.activeElement) {
        ui.field.value = toTimeValue(state.picked);
      }
    }
    buildSliderLabels();
  };

  // Once laid out, drop labels that would overlap a neighbour. The window's
  // ends win: a fixed mark next to an edge label is the one removed.
  const cullOverlappingMarks = () => {
    const container = ui.sliderLabels;
    if (!container || !container.getBoundingClientRect().width) return;
    // Primary labels sit at the bottom and secondary ones at the top, so they
    // only overlap with their own row.
    const kept = { primary: [], secondary: [] };
    for (const el of [...container.children]) {
      // Marks are zero-width anchors; the label holds the visible width.
      const label = el.querySelector('.trains-slider-label') || el;
      const rect = label.getBoundingClientRect();
      const row = kept[el.classList.contains('is-secondary') ? 'secondary' : 'primary'];
      while (row.length && rect.left < row[row.length - 1].rect.right + 4) {
        if (el.classList.contains('is-end')) row.pop().el.remove();
        else {
          el.remove();
          break;
        }
      }
      if (el.isConnected) row.push({ el, rect });
    }
  };

  const syncSpeedButton = () => {
    if (!ui.speed) return;
    ui.speed.textContent = `${state.speed}x`;
    const title = `Switch to ${nextPlaySpeed(state.speed)}x speed`;
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
    for (const path of state.prepared.paths) {
      const last = lastStartedIndex(path.starts, seconds);
      if (last < 0) continue;
      const first = lastStartedIndex(path.starts, seconds - path.maxDuration);
      for (let i = first + 1; i <= last; i++) {
        const trip = path.trips[i];
        if (!state.services.has(trip.service)) continue;
        if (seconds - trip.start <= trip.duration) return true;
      }
    }
    return false;
  };

  const syncTimeUi = (time, seconds) => {
    if (!ui.panel) return;
    ui.panel.hidden = !state.visible;
    if (!state.visible) return;
    // The slider only moves in whole minutes, while the time field shows
    // seconds, so each is updated on its own boundary. Writing every frame is
    // wasted layout/paint work.
    const shownMinute = Math.floor(seconds / 60);
    if (shownMinute !== state.shownMinute) {
      state.shownMinute = shownMinute;
      ui.slider.value = String(shownMinute);
    }
    const shownSecond = Math.floor(seconds);
    if (shownSecond !== state.shownSecond) {
      state.shownSecond = shownSecond;
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
    const atNow = state.mode === 'now' && !state.dayOverride;
    // The "Live" button stays in the layout so the row never shifts. It is
    // disabled when already live, or when nothing runs at the real current
    // time (there is no live service to switch to). A day override always
    // leaves it enabled so the user can get back to the live timetable.
    ui.reset.disabled = atNow || (!state.dayOverride && !state.nowHasTrains);
    ui.reset.title = atNow
      ? 'Showing live trains'
      : state.dayOverride
        ? 'Back to the live timetable'
        : state.nowHasTrains
          ? 'Back to live trains'
          : 'No trains are running right now';
    // Visual state: live is a filled red button; every other state is the
    // white button with a red outline. Off-hours additionally fades it.
    ui.reset.classList.toggle('is-live', atNow);
    ui.reset.classList.toggle('is-off', !atNow && !state.nowHasTrains && !state.dayOverride);
    if (playIcons) {
      // `.hidden` is not reflected on SVG elements, so use a class.
      playIcons.play.classList.toggle('is-hidden', playing);
      playIcons.pause.classList.toggle('is-hidden', !playing);
    }
    // Idle is a white chip with a teal glyph; playing flips to a filled chip.
    if (ui.play) ui.play.classList.toggle('is-playing', playing);
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

  // The overlay owns its own canvas inside the map container, so it does not
  // depend on the style being loaded and, crucially, never makes MapLibre
  // repaint the basemap for train movement.
  const ensureOverlay = () => {
    if (overlay) return;
    overlay = createTrainOverlay(map, state.prepared);
    if (DEBUG_TRAINS) window.$trainsGL = overlay;
  };

  // Per-line train counts as coloured pills on the rows under the fleet total,
  // which shares its line with the timetable footnote. Every line is always
  // shown (a zero still renders, dimmed) so the row neither reflows nor hides a
  // line that later wakes up.
  // `counts` maps line key -> running count; missing keys read as 0.
  // The pill row is rebuilt only when the line set changes. Counts change every
  // frame while playing, and recreating ~7 nodes per line each time churned
  // thousands of DOM nodes a second, so existing pills are updated in place.
  let countPills = null;

  const buildCounts = (keys) => {
    const lines = state.prepared.lines;
    const fragment = document.createDocumentFragment();
    const colorCounts = new Map();
    for (const key of keys) {
      const color = lines[key].color;
      colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
    }
    const pills = new Map();
    for (const key of keys) {
      const line = lines[key];
      const pill = document.createElement('span');
      pill.className = 'trains-count-pill';
      pill.style.setProperty('--line-color', line.color);
      pill.style.setProperty('--line-fg', contrastInk(line.color));
      const value = document.createElement('span');
      value.className = 'trains-count-value';
      if (colorCounts.get(line.color) > 1) {
        // Shared-colour lines need their names to distinguish otherwise
        // identical count pills.
        const badge = document.createElement('span');
        badge.className = 'trains-count-badge';
        badge.textContent = line.code;
        pill.append(badge, value);
      } else {
        pill.append(value);
      }
      fragment.append(pill);
      pills.set(key, { pill, value, last: -1 });
    }
    ui.pills.replaceChildren(fragment);
    countPills = { pills, keys, total: -1 };
  };

  const renderCounts = (counts) => {
    if (!ui.pills || !ui.total) return;
    const lines = state.prepared.lines;
    const keys = Object.keys(lines).sort((a, b) => lines[a].order - lines[b].order);
    const sameSet =
      countPills &&
      countPills.keys.length === keys.length &&
      countPills.keys.every((key, i) => key === keys[i]);
    if (!sameSet) buildCounts(keys);

    const zoom = map.getZoom();
    let total = 0;
    for (const key of keys) {
      const count = (lines[key].minzoom ?? 0) > zoom ? 0 : counts[key] || 0;
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
      ui.total.textContent = `${total} ${total === 1 ? 'train' : 'trains'}`;
    }
  };

  // Reused; buildInstances zeroes it before counting per line.
  const counts = {};

  // Everything time-dependent is evaluated on the GPU. The CPU only refills
  // the active-trip list when it can change, and hands the overlay a time
  // uniform plus a fade duration each frame.
  const renderAt = (seconds) => {
    if (!overlay) return;
    const now = performance.now();
    const speedFactor = state.mode === 'playing' ? state.speed : 1;
    // Fades are wall-clock in this app; the shader works in simulated seconds,
    // so scale by the playback rate. With a frozen clock there is no fade time
    // to spend, so make fades effectively instant.
    const fadeSeconds =
      state.mode === 'now' ? FADE : state.mode === 'playing' ? FADE * speedFactor : STATIC_FADE;
    // Acceleration and braking are wall-clock too, otherwise the ease is over
    // in a blink of simulated time at playback speeds. Past 2x the ramp starts
    // eating the leg instead, so widen the share toward a triangular profile
    // as the leg shortens in wall time. Pausing and scrubbing keep the
    // playback pace so resuming does not retune the legs either.
    const rampSpeed = state.mode === 'now' ? 1 : state.speed;
    const rampTarget = RAMP * rampSpeed;
    const shareTarget =
      RAMP_SHARE +
      (RAMP_SHARE_MAX - RAMP_SHARE) *
        Math.min(1, Math.max(0, (rampSpeed - PLAY_SPEED_SLOW) / 90));
    const ease = state.ease;
    // A clock jump (switching back to live, a scrub) already repositions every
    // train, so retune all legs at once rather than dragging the old ramp into
    // the new timeline; otherwise only legs still in flight keep the old ramp.
    const jumped = Math.abs(seconds - state.lastSeconds) > speedFactor * 0.5 + 1;
    if (rampTarget !== ease.ramp || shareTarget !== ease.share) {
      ease.fromRamp = jumped ? rampTarget : ease.ramp;
      ease.fromShare = jumped ? shareTarget : ease.share;
      ease.switchAt = jumped ? 0 : seconds;
      ease.ramp = rampTarget;
      ease.share = shareTarget;
    } else if (jumped && ease.switchAt !== 0) {
      // The jump can land a frame after the rate change; retune then too.
      ease.fromRamp = ease.ramp;
      ease.fromShare = ease.share;
      ease.switchAt = 0;
    }
    state.lastSeconds = seconds;
    overlay.setTime(seconds, fadeSeconds, ease);
    if (fadeSeconds !== state.lastFade) {
      // A different playback rate changes how long a finished trip has to stay
      // resident for its fade, so refill the list.
      state.lastFade = fadeSeconds;
      state.rebuildSecond = -1;
      state.rebuildAt = 0;
    }

    if (state.revealStart) {
      const reveal = Math.min(1, (now - state.revealStart) / REVEAL_MS);
      overlay.setReveal(reveal);
      if (reveal >= 1) state.revealStart = 0;
    }

    const second = Math.floor(seconds);
    const rebuildInterval = Math.max(REBUILD_MS, 1000 / speedFactor);
    if (
      state.mode === 'manual' ||
      state.rebuildSecond !== second ||
      now - state.rebuildAt >= rebuildInterval
    ) {
      state.rebuildSecond = second;
      state.rebuildAt = now;
      const prefetch = speedFactor * (rebuildInterval / 1000) + 1;
      instanceCount = buildInstances(
        state.prepared,
        seconds,
        state.services,
        instanceData,
        fadeSeconds,
        prefetch,
        counts,
      );
      overlay.setInstances(instanceData, instanceCount);
    }
    overlay.draw();
  };

  const update = (time, seconds) => {
    const dayType = state.dayOverride || scheduledDayType(time.day, time.weekday, state.holidays);
    const serviceKey = `${time.day}:${dayType}`;
    if (serviceKey !== state.serviceKey) {
      state.serviceKey = serviceKey;
      state.services = runningServices(state.data.services, {
        day: time.day,
        weekday: serviceWeekday(dayType, time.weekday),
      });
      state.dayType = dayType;
      // The live "anything running now?" check follows the selected timetable.
      state.nowMinute = -1;
      state.rebuildSecond = -1;
      state.rebuildAt = 0;
      applyWindow();
      buildSliderChart();
      syncDayUi();
      // The clamp may have moved the picked time; the caller computed `seconds`
      // before that, so recompute it now to keep this frame's UI in step.
      seconds = currentSeconds(time);
    }
    renderAt(seconds);
    renderCounts(counts);
    state.rendered = state.mode === 'manual' ? seconds : null;
    return seconds;
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
    const seconds = update(time, currentSeconds(time));
    syncTimeUi(time, seconds);
    startLoop();
  };

  const advance = (now) => {
    const delta = Math.min((now - state.lastAdvance) / 1000, 0.5);
    state.lastAdvance = now;
    if (state.mode === 'playing') {
      state.picked += delta * state.speed;
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
    if (state.mode === 'manual' && state.rendered !== null) {
      // Nothing changes until the user scrubs or presses play/now; those
      // handlers redraw and restart the loop themselves. The overlay still
      // tracks pan/zoom on its own while the loop is stopped.
      state.raf = 0;
      return;
    }
    // Live mode picks its rate from zoom (coarse steps are invisible zoomed
    // out, obvious zoomed in); play/scrub always use the display rate.
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
      let seconds = currentSeconds(time);
      const started = DEBUG_TRAINS ? performance.now() : 0;
      seconds = update(time, seconds);
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

  // Freeze the clock at the time on screen. Picking a day or starting to edit
  // the time field should not let the value move underneath the user; the Live
  // button is the way back to the real clock. Returns whether anything changed;
  // callers redraw once with their new state.
  const pausePlayback = () => {
    if (state.mode === 'manual') return false;
    if (state.mode === 'now') state.picked = clock().seconds;
    state.mode = 'manual';
    state.rendered = null;
    return true;
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
      const valid = /^\d{2}:\d{2}(:\d{2})?$/.test(value);
      const raw = valid ? fromTimeValue(value) : clock().seconds;
      const clamped = Math.min(state.window.end, Math.max(state.window.start, raw));
      state.mode = 'manual';
      state.picked = clamped;
      // Force the next sync to repaint the slider and field, even if the whole
      // minute happens to match the last one shown.
      state.shownMinute = -1;
      state.shownSecond = -1;
      state.rendered = null;
      redraw();
    };
    ui.field.addEventListener('change', pick);
    // Focusing the field means the user is about to change the time; stop the
    // clock first so the value they are editing stays put.
    ui.field.addEventListener('focus', () => {
      if (pausePlayback()) redraw();
    });
  }
  if (ui.day) {
    ui.day.addEventListener('change', () => {
      const dayType = ui.day.value;
      if (dayType !== 'weekdays' && dayType !== 'saturdays' && dayType !== 'holidays') return;
      pausePlayback();
      state.dayOverride = dayType;
      state.serviceKey = '';
      state.rendered = null;
      redraw();
    });
  }
  if (ui.reset) {
    ui.reset.addEventListener('click', () => {
      state.dayOverride = null;
      state.serviceKey = '';
      state.mode = 'now';
      state.rendered = null;
      redraw();
    });
  }
  if (ui.speed) {
    ui.speed.addEventListener('click', () => {
      state.speed = nextPlaySpeed(state.speed);
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
      state.loading = loadTimetable()
        .then(({ data, holidays }) => {
          state.data = data;
          state.prepared = prepare(data);
          state.holidays = holidays;
          if (holidays.size === 0) {
            console.warn('Public holidays unavailable; only Sundays use the Sunday timetable.');
          }
          const feedEnd = data.feed && data.feed.end;
          if (feedEnd && feedEnd < clock().day) {
            console.warn(`Timetable expired on ${feedEnd}; trains are no longer current.`);
          }
          state.window = state.prepared.window;
          state.serviceKey = '';
          state.dayType = '';
          state.dayOverride = null;
          state.picked = state.window.start;
          applyWindow();
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
    state.dayOverride = null;
    state.serviceKey = '';
    state.dayType = '';
    state.nowMinute = -1;
    state.shownMinute = -1;
    state.shownSecond = -1;
    state.busy = false;
    document.body.classList.remove('trains-busy');
    // Start with a short reveal fade so the whole fleet does not pop in.
    ensureOverlay();
    state.revealStart = performance.now();
    overlay.setReveal(0);
    state.rebuildSecond = -1;
    state.rebuildAt = 0;
    redraw();
    // The panel is visible now, so labels can be measured and de-overlapped.
    buildSliderLabels();
    return true;
  };

  const disable = () => {
    state.visible = false;
    state.rendered = null;
    state.mode = 'now';
    state.dayOverride = null;
    state.serviceKey = '';
    state.nowMinute = -1;
    state.busy = false;
    document.body.classList.remove('trains-busy');
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.shownMinute = -1;
    state.shownSecond = -1;
    instanceCount = 0;
    state.revealStart = 0;
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    if (DEBUG_TRAINS && window.$trainsGL) delete window.$trainsGL;
    if (ui.panel) ui.panel.hidden = true;
    return false;
  };

  // The GPU hides a line's trains below its minzoom every frame, but the count
  // pills are DOM and need a nudge when that threshold is crossed.
  let zoomMask = '';
  const syncZoomCounts = () => {
    if (!state.visible || !state.prepared) return;
    const zoom = map.getZoom();
    const mask = state.prepared.lineKeys
      .map((key) => (zoom >= (state.prepared.lines[key].minzoom ?? 0) ? '1' : '0'))
      .join('');
    if (mask === zoomMask) return;
    zoomMask = mask;
    renderCounts(counts);
  };
  map.on('zoom', syncZoomCounts);

  return {
    enable,
    disable,
    get visible() {
      return state.visible;
    },
    toggle: async () => (state.visible ? disable() : enable()),
  };
}

