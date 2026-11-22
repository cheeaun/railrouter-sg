import trainsUrl from './gtfs-trains.json' with { type: 'url' };
import holidaysUrl from './public-holidays.json' with { type: 'url' };
import { scheduledDayType, serviceWeekday } from './service-day.mjs';
import { prepare, buildInstances, createTrainOverlay, FADE, INSTANCE_STRIDE } from './gpu-trains';

// GTFS times are Singapore local time, which has no daylight saving.
const SGT_OFFSET = 8 * 3600 * 1000;
// A service day starts before the first train and lasts past midnight. Times
// after midnight still belong to the previous day's timetable (GTFS writes
// them as 24:xx, 25:xx…), so anything before this cutoff is served by
// yesterday's services.
const SERVICE_DAY_CUTOFF = 3 * 3600;
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

// Playback speed in simulated seconds per real second. 60 = one simulated
// minute per real second, 30 = half that pace.
const PLAY_SPEED_SLOW = 30;
const PLAY_SPEED_MEDIUM = 60;
const PLAY_SPEED_FAST = 120;
const PLAY_SPEED_FASTER = 240;
const END_HOLD_MS = 1500;

function nextPlaySpeed(speed) {
  return speed === PLAY_SPEED_SLOW
    ? PLAY_SPEED_MEDIUM
    : speed === PLAY_SPEED_MEDIUM
      ? PLAY_SPEED_FAST
      : speed === PLAY_SPEED_FAST
        ? PLAY_SPEED_FASTER
        : PLAY_SPEED_SLOW;
}

const DEBUG_TRAINS = new URLSearchParams(location.search).has('trainsdebug');
// Wall-clock interval between overlay active-trip list rebuilds.
const REBUILD_MS = 100;
// Trains fade in when the layer is first shown.
const REVEAL_MS = 700;
// When the clock is frozen (paused/scrubbed) there is no time for a fade to
// play in, so use a fade this short: trains are either present or not.
const STATIC_FADE = 0.05;

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

export function createLiveTrains(map) {
  let overlay = null;
  // Active trips written by buildInstances, 8 floats each.
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
    // Last whole-minute value written to the scrubber/label, so per-frame
    // frames do not touch the DOM when the minute has not changed.
    shownMinute: -1,
    nowHasTrains: true,
    window: { start: 0, end: 86400 },
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
  };

  const ui = {
    panel: document.getElementById('trains-time'),
    slider: document.getElementById('trains-time-slider'),
    day: document.getElementById('trains-time-day'),
    field: document.getElementById('trains-time-field'),
    reset: document.getElementById('trains-time-now'),
    play: document.getElementById('trains-time-play'),
    speed: document.getElementById('trains-time-speed'),
    counts: document.getElementById('trains-time-counts'),
  };

  const syncDayUi = () => {
    if (!ui.day || !state.dayType) return;
    if (ui.day.value !== state.dayType) ui.day.value = state.dayType;
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

  // The overlay owns its own canvas inside the map container, so it does not
  // depend on the style being loaded and, crucially, never makes MapLibre
  // repaint the basemap for train movement.
  const ensureOverlay = () => {
    if (overlay) return;
    overlay = createTrainOverlay(map, state.prepared);
    if (DEBUG_TRAINS) window.$trainsGL = overlay;
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
    overlay.setTime(seconds, fadeSeconds);
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
      syncDayUi();
    }
    renderAt(seconds);
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
  if (ui.day) {
    ui.day.addEventListener('change', () => {
      const dayType = ui.day.value;
      if (dayType !== 'weekdays' && dayType !== 'saturdays' && dayType !== 'holidays') return;
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
      if (state.mode !== 'playing') return;
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
      state.loading = Promise.all([
        fetch(trainsUrl).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        }),
        // Holidays are an overlay, not a hard dependency: if the file is
        // missing the timetable still runs, just without weekday holidays.
        fetch(holidaysUrl)
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
      ])
        .then(([data, holidays]) => {
          state.data = data;
          state.prepared = prepare(data);
          const holidayDates =
            holidays && Array.isArray(holidays.dates)
              ? holidays.dates
                  .map((date) => String(date).replace(/-/g, ''))
                  .filter((date) => /^\d{8}$/.test(date))
              : [];
          state.holidays = new Set(holidayDates);
          if (holidayDates.length === 0) {
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
    state.dayOverride = null;
    state.serviceKey = '';
    state.dayType = '';
    state.nowMinute = -1;
    state.shownMinute = -1;
    state.busy = false;
    document.body.classList.remove('trains-busy');
    // Start with a short reveal fade so the whole fleet does not pop in.
    ensureOverlay();
    state.revealStart = performance.now();
    overlay.setReveal(0);
    state.rebuildSecond = -1;
    state.rebuildAt = 0;
    redraw();
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

  return {
    enable,
    disable,
    get visible() {
      return state.visible;
    },
    toggle: async () => (state.visible ? disable() : enable()),
  };
}

