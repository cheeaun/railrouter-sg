// Day-type helpers. Kept separate from live-trains.js so they stay importable
// by Node tests without touching the browser-only module.

// GTFS times are Singapore local time, which has no daylight saving.
export const SGT_OFFSET = 8 * 3600 * 1000;
// A service day starts before the first train and lasts past midnight. Times
// after midnight still belong to the previous day's timetable (GTFS writes
// them as 24:xx, 25:xx…), so anything before this cutoff is served by
// yesterday's services.
export const SERVICE_DAY_CUTOFF = 3 * 3600;

// Which timetable a service date uses: compact YYYYMMDD date, matching GTFS
// calendar dates. Public holidays use the Sunday/PH timetable even when they
// fall on a weekday.
export function scheduledDayType(day, weekday, holidays) {
  if (weekday === 0 || holidays.has(day)) return 'holidays';
  if (weekday === 6) return 'saturdays';
  return 'weekdays';
}

// The weekday whose `service.days` flags to use. Weekdays all share one
// pattern, so a weekday view on a weekend can use Monday; the real date still
// goes to runningServices for calendar start/end and per-date exceptions.
export function serviceWeekday(dayType, weekday) {
  if (dayType === 'holidays') return 0;
  if (dayType === 'saturdays') return 6;
  return weekday >= 1 && weekday <= 5 ? weekday : 1;
}

// The moment in Singapore, measured in seconds along the current service day.
// Before the cutoff the clock is still counting up yesterday's timetable, so
// seconds runs past 86400 and the date/weekday point at yesterday.
export function clock(now = Date.now()) {
  const milliseconds = now + SGT_OFFSET;
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

// Which services run on a given service day, honouring calendar dates and
// per-date exceptions.
export function runningServices(services, { day, weekday }) {
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
