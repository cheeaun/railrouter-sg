// The station sidebar's scheduled arrivals, under the exits. Reads the same
// packed timetable the trains layer animates, but does not depend on that
// layer being on: the shared loader fetches and parses the JSON on first open.

import { clock, runningServices, scheduledDayType, serviceWeekday } from './service-day.mjs';
import { arrivalsAt, loadTimetable, timetableFor } from './timetable.mjs';
import { contrastInk } from './line-color.mjs';

// A whole minute is plenty for countdowns shown in minutes.
const REFRESH_MS = 30 * 1000;
const LIMIT = 2;
const MAX_ROWS = 8;

// Minutes until arrival. Rounds up so "0 min" never shows for a train still
// ahead; anything already due reads as "now".
function relativeMinutes(seconds, now) {
  return Math.max(0, Math.ceil((seconds - now) / 60));
}

// A clock time for an arrival, wrapping past-midnight service-day seconds.
function clockTime(seconds) {
  const total = Math.round(seconds) % (24 * 60 * 60);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

let timer = 0;
let active = null;

function stopTimer() {
  clearInterval(timer);
  timer = 0;
}

function draw(el, rows, now) {
  const $list = el.querySelector('.arrivals-list');
  if (!rows.length) {
    $list.innerHTML = '<p class="arrivals-empty">No more scheduled trains today.</p>';
    return;
  }
  // Every row gets the same number of time cells so the columns line up; a row
  // with only one train left leaves the remaining cells empty.
  const columns = LIMIT;
  const body = rows
    .slice(0, MAX_ROWS)
    .map(({ line, direction, qualifier, times }) => {
      let cells = '';
      for (let i = 0; i < columns; i++) {
        const time = times[i];
        if (!time) {
          cells += '<td class="arrival-time"></td>';
          continue;
        }
        // "Arrived" once the train has reached the platform; it stays up until
        // the train leaves. Otherwise the countdown in minutes, pluralised.
        const minutes = relativeMinutes(time.at, now);
        const content = time.arrived
          ? 'Arrived'
          : `${minutes}<small> min${minutes === 1 ? '' : 's'}</small>`;
        cells += `<td class="arrival-time" title="${clockTime(time.at)}">${content}</td>`;
      }
      // LTA's display sets the direction (Clockwise / Anticlockwise) small and
      // light, then the qualifier — "via Serangoon" or "ends at Dhoby Ghaut" —
      // at normal size underneath it.
      const directionHtml = qualifier
        ? `<span class="arrival-heading">${direction}</span><span class="arrival-qualifier">${qualifier}</span>`
        : direction;
      return `<tr>
        <th scope="row" class="arrival-line" style="--line-color:${line.color};--line-fg:${contrastInk(
          line.color,
        )}"><span>${line.code}</span></th>
        <td class="arrival-direction">${directionHtml}</td>
        ${cells}
      </tr>`;
    })
    .join('');

  // The column headings are for screen readers only: on screen the "min" in
  // each cell already says what the numbers are.
  let headings = '';
  for (let i = 0; i < columns; i++) {
    const which = i === 0 ? 'Next train' : 'Following train';
    headings += `<th scope="col"><span class="visually-hidden">${which}</span></th>`;
  }
  $list.innerHTML = `<table class="arrivals-table">
    <thead><tr><td></td><td></td>${headings}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function refresh(el, stationKey, timetable) {
  const time = clock();
  const dayType = scheduledDayType(time.day, time.weekday, timetable.holidays);
  const services = runningServices(timetable.data.services, {
    day: time.day,
    weekday: serviceWeekday(dayType, time.weekday),
  });
  const rows = arrivalsAt(timetable.index, stationKey, {
    services,
    seconds: time.seconds,
    limit: LIMIT,
  });
  draw(el, rows, time.seconds);
}

export const stationArrivals = {
  mount: async (stationKey, stationNames) => {
    const el = document.querySelector('#station .arrivals');
    if (!el) return;
    stopTimer();
    active = stationKey;
    el.innerHTML = `<h3>Arrival times</h3>
      <p class="arrivals-note"><small>* Based on timetable, not 100% live</small></p>
      <div class="arrivals-list"><p class="arrivals-loading">Loading&hellip;</p></div>`;

    let loaded;
    try {
      loaded = await loadTimetable();
    } catch {
      if (active !== stationKey) return;
      el.querySelector('.arrivals-list').innerHTML =
        '<p class="arrivals-empty">Arrival times unavailable.</p>';
      return;
    }
    if (active !== stationKey) return;

    const timetable = { ...loaded, index: timetableFor(loaded.data, stationNames) };
    refresh(el, stationKey, timetable);
    timer = setInterval(() => {
      if (active !== stationKey) return stopTimer();
      refresh(el, stationKey, timetable);
    }, REFRESH_MS);
  },
  unmount: () => {
    active = null;
    stopTimer();
  },
};
