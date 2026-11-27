import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { decodeDeltas } from '../src/gtfs-codec.mjs';
import { implausibleLeg } from './rail-graph.mjs';

const read = (file) => JSON.parse(fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'));

const timetable = read('gtfs-trains.json');
const stationPoints = new Map();
for (const file of ['sg-rail.geo.json', 'sg-rail-other.geo.json']) {
  for (const feature of read(file).features) {
    if (feature.properties.stop_type === 'station') {
      stationPoints.set(feature.properties.station_codes, feature.geometry.coordinates);
    }
  }
}

const toRad = Math.PI / 180;
const straightLine = (a, b) => {
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat = ((a[1] + b[1]) / 2) * toRad;
  return Math.hypot(dLat, dLon * Math.cos(lat)) * 6371000;
};

// Every stop-to-stop leg in the committed timetable, with its routed length
// (the timetable's own cumulative distances) and the straight line between the
// stations it connects.
function legs() {
  const result = [];
  for (const [line, data] of Object.entries(timetable.lines)) {
    for (const path of data.paths) {
      const stations = decodeDeltas(path.st);
      const distances = decodeDeltas(path.s);
      for (let i = 1; i < stations.length; i++) {
        const from = timetable.stations[stations[i - 1]];
        const to = timetable.stations[stations[i]];
        const points = [stationPoints.get(from), stationPoints.get(to)];
        result.push({
          line,
          from,
          to,
          leg: distances[i] - distances[i - 1],
          straight: points.every(Boolean) ? straightLine(points[0], points[1]) : null,
        });
      }
    }
  }
  return result;
}

test('every timetable station has a drawn point to measure against', () => {
  const missing = legs()
    .filter(({ straight }) => straight === null)
    .map(({ line, from, to }) => `${line} ${from}>${to}`);
  assert.deepEqual(missing, []);
});

test('no timetable leg detours implausibly far from its stations', () => {
  const detours = legs().filter(
    ({ leg, straight }) => straight !== null && implausibleLeg(leg, straight),
  );
  assert.deepEqual(
    detours.map(({ line, from, to, leg, straight }) => ({
      line,
      from,
      to,
      km: Math.round(leg / 100) / 10,
      straightKm: Math.round(straight / 100) / 10,
    })),
    [],
  );
});

test('the Circle Line loop closes at Promenade and Bayfront', () => {
  const pairs = legs().filter(
    ({ from, to }) =>
      (from === 'CC4-DT15' && to === 'CC34-DT16') || (from === 'CC34-DT16' && to === 'CC4-DT15'),
  );
  assert.ok(pairs.length > 0, 'expected Circle Line paths through Promenade and Bayfront');
  for (const { line, from, to, leg } of pairs) {
    assert.ok(
      leg < 2000,
      `${line} ${from}>${to} routed ${(leg / 1000).toFixed(1)}km; the loop did not close`,
    );
  }
});
