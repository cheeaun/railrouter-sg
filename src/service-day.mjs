// Day-type helpers. Kept separate from live-trains.js so they stay importable
// by Node tests without touching the browser-only module.

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
