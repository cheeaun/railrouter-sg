import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHolidayDates } from './download-holidays.mjs';

test('parseHolidayDates sorts, deduplicates, and includes observed dates', () => {
  const records = [
    { date: '2026-08-10' },
    { date: '2026-01-01' },
    { date: '2026-08-09' },
    { date: '2026-08-10' },
  ];
  assert.deepEqual(parseHolidayDates(records), ['2026-01-01', '2026-08-09', '2026-08-10']);
});

test('parseHolidayDates ignores malformed and impossible dates', () => {
  const records = [
    { date: '2026-1-01' },
    { date: '2026-02-30' },
    { date: '' },
    { date: null },
    {},
    { date: '2026-12-25' },
  ];
  assert.deepEqual(parseHolidayDates(records), ['2026-12-25']);
});
