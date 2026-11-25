import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeCoords, encodeInts, encodeProfile } from '../src/gtfs-codec.mjs';
import { arrivalsAt, timetableFor } from '../src/timetable-data.mjs';

const NAMES = new Map([
  ['A', 'Alpha'],
  ['B', 'Bravo'],
  ['C', 'Charlie'],
  ['A-B', 'Hub'],
  ['D', 'Delta'],
]);

// The loop fixture's ring uses a second interchange (`C-X`), so it needs its
// own names map.
const LOOP_NAMES = new Map([
  ['A', 'Alpha'],
  ['B', 'Bravo'],
  ['C-X', 'Charlie'],
  ['A-B', 'Hub'],
  ['D', 'Delta'],
]);

const weekday = {
  WD: { i: 0, days: [0, 1, 1, 1, 1, 1, 0], start: '20260101', end: '20261231', exceptions: {} },
};
const weekdayServices = new Set(['WD']);

// The times on a row are objects ({ at, arrived }); most assertions only care
// about the arrival seconds.
const arrivalSeconds = (row) => row.times.map((time) => time.at);

// A plain two-direction line (no loop): A -> B -> C and back. Not a loop, so no
// Clockwise/Anticlockwise copy, just the terminus.
function lineFixture() {
  const profile = encodeProfile([
    [0, 0],
    [60, 90],
    [150, 150],
  ]);
  const forward = {
    c: 0,
    s: encodeInts([0, 1000, 2000]),
    // Station indices A, B, C as deltas.
    st: encodeInts([0, 1, 1]),
    h: 0,
    p: [profile],
    t: encodeInts([28800, 600, 600]),
    tp: encodeInts([0, 0, 0]),
  };
  const backward = {
    c: 0,
    s: encodeInts([0, 1000, 2000]),
    // C, B, A as deltas.
    st: encodeInts([2, -1, -1]),
    h: 1,
    p: [profile],
    t: encodeInts([28860]),
    tp: encodeInts([0]),
  };
  return {
    stations: ['A', 'B', 'C'],
    headsigns: ['Charlie', 'Alpha'],
    services: weekday,
    lines: {
      'Test Line': {
        name: 'Test Line',
        code: 'TL',
        order: 1,
        color: '#123456',
        coords: [],
        paths: [forward, backward],
      },
    },
  };
}

test('a plain line names its terminus and lists the next two times', () => {
  const rows = arrivalsAt(timetableFor(lineFixture(), NAMES), 'A', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 'Charlie');
  assert.equal(rows[0].qualifier, null);
  assert.equal(rows[0].line.code, 'TL');
  assert.deepEqual(arrivalSeconds(rows[0]), [28800, 29400]);
});

test('services not running that day are skipped', () => {
  const timetable = timetableFor(lineFixture(), NAMES);
  const rows = arrivalsAt(timetable, 'B', { services: weekdayServices, seconds: 8 * 3600 });
  assert.equal(rows.length, 2);
  // Without any running service nothing departs, even though the paths exist.
  assert.deepEqual(
    arrivalsAt(timetable, 'B', { services: new Set(), seconds: 8 * 3600 }),
    [],
  );
});

// The board is "Arrival times", so it must show when the train reaches the
// platform, not when it leaves. In the fixture B's profile pair is [60, 90]:
// arriving 60 s into the trip and leaving 30 s later, so the arrival times are
// 30 s earlier than the departures would be.
test('times are arrivals, not departures', () => {
  const rows = arrivalsAt(timetableFor(lineFixture(), NAMES), 'B', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  const towardsC = rows.find((row) => row.direction === 'Charlie');
  assert.deepEqual(arrivalSeconds(towardsC), [28860, 29460]);
});

test('the terminus is not offered as a boarding point', () => {
  const rows = arrivalsAt(timetableFor(lineFixture(), NAMES), 'C', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 'Alpha');
  assert.deepEqual(arrivalSeconds(rows[0]), [28860]);
});

test('a departure already gone is not returned', () => {
  const rows = arrivalsAt(timetableFor(lineFixture(), NAMES), 'A', {
    services: weekdayServices,
    seconds: 8 * 3600 + 601,
  });
  assert.deepEqual(arrivalSeconds(rows[0]), [30000]);
});

// A train that has reached the platform but not yet left is still on the board,
// flagged so the UI can say "Arrived". In the fixture A's first trip departs at
// 08:00:00 and the next at 08:10:00; at 08:00:10 the first has gone.
test('a train that has arrived is flagged, not dropped', () => {
  const timetable = timetableFor(lineFixture(), NAMES);
  const rows = arrivalsAt(timetable, 'A', {
    services: weekdayServices,
    seconds: 28800,
  });
  // At the exact arrival moment it is "Arrived", not missing.
  assert.equal(rows[0].times[0].arrived, true);
  assert.equal(rows[0].times[1].arrived, false);
});

// A stop with no dwell has arrival == departure, so a strict "already left"
// test is the only thing that keeps it visible on the tick it arrives.
test('a zero-dwell stop still shows on the tick it arrives', () => {
  const NAMES_ZERO = new Map([
    ['A', 'Alpha'],
    ['B', 'Bravo'],
    ['C', 'Charlie'],
  ]);
  const profile = encodeProfile([
    [0, 0],
    [60, 60],
    [150, 150],
  ]);
  const path = {
    c: 0,
    s: encodeInts([0, 1000, 2000]),
    st: encodeInts([0, 1, 1]),
    h: 0,
    p: [profile],
    t: encodeInts([28800]),
    tp: encodeInts([0]),
  };
  const data = {
    stations: ['A', 'B', 'C'],
    headsigns: ['Charlie'],
    services: weekday,
    lines: { L: { name: 'L', code: 'TL', order: 1, color: '#123456', coords: [], paths: [path] } },
  };
  const timetable = timetableFor(data, NAMES_ZERO);
  // 08:01:00 is exactly when the train reaches B and leaves it.
  const rows = arrivalsAt(timetable, 'B', { services: weekdayServices, seconds: 28860 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].times[0].arrived, true);
});

test('unknown stations return no rows', () => {
  const timetable = timetableFor(lineFixture(), NAMES);
  assert.deepEqual(arrivalsAt(timetable, 'NOPE', { services: weekdayServices, seconds: 0 }), []);
});

// A loop line: one closed path that returns to its start, plus a short
// terminating path. LTA's copy is "via <next interchange>" for the through
// service and "ends at <terminus>" for the terminating one, under a
// Clockwise/Anticlockwise direction.
//
// The ring is Hub → Bravo → Charlie → Delta → Hub. Two of those (Hub and
// Charlie) are interchanges, so the "via" cue has somewhere to point from every
// station on the ring; a ring with a single interchange would leave the station
// just before it with nothing ahead.
function loopFixture({ clockwise = false } = {}) {
  // The ring drawn either way round. The sign of the closed path's area decides
  // which way is which, so the coordinate order matters.
  const loop = clockwise
    ? [
        [103.8, 1.3],
        [103.8, 1.31],
        [103.81, 1.31],
        [103.81, 1.3],
        [103.8, 1.3],
      ]
    : [
        [103.8, 1.3],
        [103.81, 1.3],
        [103.81, 1.31],
        [103.8, 1.31],
        [103.8, 1.3],
      ];
  // Station indices: Hub(3), Bravo(1), Charlie(2), Delta(4), back to Hub(3).
  // Deltas: 3, -2, 1, 2, -1.
  // Both services run every few minutes, like the real Circle Line, so both
  // rows stay on the board as time advances. The two paths are staggered so
  // their soonest arrivals keep crossing — the case that used to reorder rows.
  const closed = {
    c: 0,
    s: encodeInts([0, 1000, 2000, 3000, 4000]),
    st: encodeInts([3, -2, 1, 2, -1]),
    // The feed headsign for a loop trip; the direction comes from geometry.
    h: 0,
    p: [encodeProfile([[0, 0], [60, 90], [120, 150], [180, 210], [240, 240]])],
    // Trips every 4 minutes from 08:00, enough to cover the hour the order test
    // walks through.
    t: encodeInts([28800, ...Array(20).fill(240)]),
    tp: encodeInts(Array(21).fill(0)),
  };
  // A terminating service: Hub(3) -> Bravo(1), ending at Bravo, every 4 minutes
  // but offset by 2 minutes so its arrivals interleave with the loop's.
  const terminating = {
    c: 0,
    s: encodeInts([0, 1000]),
    st: encodeInts([3, -2]),
    h: 1,
    p: [encodeProfile([[0, 0], [60, 60]])],
    t: encodeInts([28920, ...Array(20).fill(240)]),
    tp: encodeInts(Array(21).fill(0)),
  };
  return {
    stations: ['A', 'B', 'C-X', 'A-B', 'D'],
    headsigns: ['Loop', 'Bravo'],
    services: weekday,
    lines: {
      Loop: {
        name: 'Loop',
        code: 'LP',
        order: 1,
        color: '#123456',
        coords: [encodeCoords(loop)],
        paths: [closed, terminating],
      },
    },
  };
}

test('a loop direction comes from the geometry, not the headsign', () => {
  const anticlockwise = arrivalsAt(timetableFor(loopFixture(), LOOP_NAMES), 'A-B', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  const through = anticlockwise.find((row) => row.qualifier?.startsWith('via'));
  assert.ok(through, 'expected a via row');
  assert.equal(through.direction, 'Anticlockwise');

  const clockwise = arrivalsAt(timetableFor(loopFixture({ clockwise: true }), LOOP_NAMES), 'A-B', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  const cwThrough = clockwise.find((row) => row.qualifier?.startsWith('via'));
  assert.equal(cwThrough.direction, 'Clockwise');
});

test('a through loop service is labelled "via" the next interchange', () => {
  const rows = arrivalsAt(timetableFor(loopFixture(), LOOP_NAMES), 'A-B', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  const through = rows.find((row) => row.qualifier?.startsWith('via'));
  // Standing at the hub, the next interchange ahead is Charlie (Bravo is not
  // one), so that is the cue.
  assert.equal(through.qualifier, 'via Charlie');
});

test('a terminating loop service is labelled "ends at" its terminus', () => {
  const rows = arrivalsAt(timetableFor(loopFixture(), LOOP_NAMES), 'A-B', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  const terminating = rows.find((row) => row.qualifier?.startsWith('ends at'));
  assert.ok(terminating, 'expected an ends-at row');
  assert.equal(terminating.qualifier, 'ends at Bravo');
  // Same direction as the through service, different copy.
  assert.equal(terminating.direction, 'Anticlockwise');
});

test('a loop direction never shows more than two rows', () => {
  const rows = arrivalsAt(timetableFor(loopFixture(), LOOP_NAMES), 'A-B', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  const anticlockwise = rows.filter((row) => row.direction === 'Anticlockwise');
  assert.ok(anticlockwise.length <= 2);
});

// The bug this guards: the "via" search walked forward only, so the last
// station before the hub found no interchange ahead and fell back to
// plain-line labelling, losing its Clockwise/Anticlockwise direction entirely.
test('the station just before the hub still gets a loop direction', () => {
  // Delta is the last stop on the ring before it returns to the hub.
  const rows = arrivalsAt(timetableFor(loopFixture(), LOOP_NAMES), 'D', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  assert.ok(rows.length > 0, 'expected rows at the seam station');
  for (const row of rows) {
    assert.ok(
      row.direction === 'Clockwise' || row.direction === 'Anticlockwise',
      `expected a loop direction, got "${row.direction}"`,
    );
    assert.ok(row.qualifier?.startsWith('via '), 'expected a via cue');
  }
});

// The bug this guards: the per-group cap was applied before rows were merged,
// so two paths that share a direction and a label could produce a row with more
// than `limit` times, out of order, hiding the soonest train.
test('a row never shows more times than the limit, and they stay in order', () => {
  // Both paths leave B towards C (same direction) and terminate at D (same
  // label), so their arrivals merge into one row: 08:01:00, 08:01:30, 08:02:30.
  // The third is the one the cap must drop.
  const profile = encodeProfile([
    [0, 0],
    [60, 90],
  ]);
  const short = {
    c: 0,
    s: encodeInts([0, 1000, 2000]),
    st: encodeInts([0, 1, 1]),
    h: 0,
    p: [profile],
    t: encodeInts([28800, 600]),
    tp: encodeInts([0, 0]),
  };
  const long = {
    c: 0,
    s: encodeInts([0, 1000, 2000, 3000]),
    st: encodeInts([0, 1, 1, 1]),
    h: 0,
    p: [profile],
    t: encodeInts([28950]),
    tp: encodeInts([0]),
  };
  const data = {
    stations: ['A', 'B', 'C', 'D'],
    headsigns: ['Delta'],
    services: weekday,
    lines: {
      L: { name: 'L', code: 'TL', order: 1, color: '#123456', coords: [], paths: [short, long] },
    },
  };
  const rows = arrivalsAt(timetableFor(data, NAMES), 'B', {
    services: weekdayServices,
    seconds: 8 * 3600,
    limit: 2,
  });
  assert.equal(rows.length, 1);
  const ats = rows[0].times.map((time) => time.at);
  assert.equal(ats.length, 2, `expected 2 times, got ${ats.length}`);
  assert.deepEqual(ats, [28860, 29010]);
});

// The bug this guards: the row order used to break ties on the next arrival
// time. On a line where one direction alternates between a through and a
// terminating service, those two times cross constantly, so the rows swapped
// places every few minutes. The order must depend only on static attributes.
test('row order does not change as the clock advances', () => {
  const timetable = timetableFor(loopFixture(), LOOP_NAMES);
  const signature = (seconds) =>
    arrivalsAt(timetable, 'A-B', { services: weekdayServices, seconds })
      .map((row) => `${row.line.code}|${row.direction}|${row.qualifier ?? ''}`)
      .join(' / ');

  const first = signature(8 * 3600);
  // Step through the following hour; the order must never change.
  for (let minute = 1; minute <= 60; minute++) {
    assert.equal(signature(8 * 3600 + minute * 60), first, `order changed at +${minute} min`);
  }
});

test('the through service sorts before the terminating one', () => {
  const rows = arrivalsAt(timetableFor(loopFixture(), LOOP_NAMES), 'A-B', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  const anticlockwise = rows.filter((row) => row.direction === 'Anticlockwise');
  assert.ok(anticlockwise[0].qualifier.startsWith('via '));
  assert.ok(anticlockwise[1].qualifier.startsWith('ends at '));
});

// The bug this guards: station names arrive from a separate fetch, so the index
// can be built before they are available. The index is cached, so baking the
// names into it froze station *codes* into the labels for the whole session.
test('names resolve even when the index was built without them', () => {
  const data = loopFixture();
  // First call: no names yet, so labels fall back to station codes.
  const early = timetableFor(data, new Map());
  const earlyRows = arrivalsAt(early, 'A-B', { services: weekdayServices, seconds: 8 * 3600 });
  // With no names, the cue falls back to the raw station key.
  assert.ok(earlyRows.some((row) => row.qualifier === 'via C-X'));

  // Names arrive; the same cached timetable must now use them.
  const late = timetableFor(data, LOOP_NAMES);
  assert.equal(late, early, 'the index should still be the cached one');
  const lateRows = arrivalsAt(late, 'A-B', { services: weekdayServices, seconds: 8 * 3600 });
  assert.ok(lateRows.some((row) => row.qualifier === 'via Charlie'));
  assert.ok(lateRows.some((row) => row.qualifier === 'ends at Bravo'));
  assert.ok(!lateRows.some((row) => row.qualifier?.includes('C-X')));
});

// The bug this guards: a headsign names a terminus, not a direction. On a plain
// line, trains terminating at different stations while running the same way
// must not split into one row per terminus.
test('short-turn paths on a plain line share one row', () => {
  const profile = encodeProfile([
    [0, 0],
    [60, 90],
    [150, 150],
  ]);
  const full = {
    c: 0,
    s: encodeInts([0, 1000, 2000]),
    st: encodeInts([0, 1, 1]),
    h: 0,
    p: [profile],
    t: encodeInts([28800, 400]),
    tp: encodeInts([0, 0]),
  };
  const short = {
    c: 0,
    s: encodeInts([0, 1000]),
    st: encodeInts([0, 1]),
    h: 1,
    p: [encodeProfile([[0, 0], [60, 60]])],
    t: encodeInts([29000]),
    tp: encodeInts([0]),
  };
  const data = {
    stations: ['A', 'B', 'C'],
    headsigns: ['Charlie', 'Bravo'],
    services: weekday,
    lines: {
      L: { name: 'L', code: 'TL', order: 1, color: '#123456', coords: [], paths: [full, short] },
    },
  };
  // Both paths run A -> B first, so they are the same direction. One row.
  const rows = arrivalsAt(timetableFor(data, NAMES), 'A', {
    services: weekdayServices,
    seconds: 8 * 3600,
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(arrivalSeconds(rows[0]), [28800, 29000]);
});
