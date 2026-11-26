// Loads the packed GTFS timetable shared by the trains layer and the station
// sidebar's arrivals. The query logic lives in timetable-data.mjs, which has
// no fetch or JSON imports so Node tests can import it directly.

import trainsUrl from './gtfs-trains.json' with { type: 'url' };
import holidaysUrl from './public-holidays.json' with { type: 'url' };

export { arrivalsAt, timetableFor } from './timetable-data.mjs';

let loading = null;

// Fetch and parse the timetable and public holidays once. The sidebar and the
// trains layer both call this, so the ~590 KB JSON is only downloaded and
// parsed a single time per session.
export function loadTimetable() {
  if (!loading) {
    loading = Promise.all([
      fetch(trainsUrl).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }),
      // Holidays are an overlay, not a hard dependency: without the file the
      // timetable still runs, just without weekday public holidays.
      fetch(holidaysUrl)
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null),
    ])
      .then(([data, holidays]) => {
        const dates =
          holidays && Array.isArray(holidays.dates)
            ? holidays.dates
                .map((date) => String(date).replace(/-/g, ''))
                .filter((date) => /^\d{8}$/.test(date))
            : [];
        return { data, holidays: new Set(dates) };
      })
      .catch((error) => {
        loading = null;
        throw error;
      });
  }
  return loading;
}
