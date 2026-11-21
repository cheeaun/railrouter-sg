import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduledDayType, serviceWeekday } from '../src/service-day.mjs';

const holidays = new Set(['20261109', '20261121']);

test('weekdays use the weekday timetable', () => {
  assert.equal(scheduledDayType('20261110', 2, holidays), 'weekdays');
});

test('saturdays use the Saturday timetable', () => {
  assert.equal(scheduledDayType('20261114', 6, holidays), 'saturdays');
});

test('sundays use the Sunday and public holiday timetable', () => {
  assert.equal(scheduledDayType('20261115', 0, holidays), 'holidays');
});

test('weekday public holidays use the Sunday and public holiday timetable', () => {
  assert.equal(scheduledDayType('20261109', 1, holidays), 'holidays');
});

test('Saturday public holidays use the Sunday and public holiday timetable', () => {
  assert.equal(scheduledDayType('20261121', 6, holidays), 'holidays');
});

test('service weekday follows the chosen day type', () => {
  assert.equal(serviceWeekday('holidays', 2), 0);
  assert.equal(serviceWeekday('saturdays', 6), 6);
  assert.equal(serviceWeekday('weekdays', 3), 3);
});

test('weekday view on a weekend falls back to Monday', () => {
  assert.equal(serviceWeekday('weekdays', 0), 1);
  assert.equal(serviceWeekday('weekdays', 6), 1);
});
