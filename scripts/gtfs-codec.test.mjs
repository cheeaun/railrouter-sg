import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeCoords,
  decodeInts,
  decodeProfile,
  encodeCoords,
  encodeInts,
  encodeProfile,
} from '../src/gtfs-codec.mjs';

test('encodeInts round-trips signed values, including zero and run lengths', () => {
  const values = [0, 1, -1, 127, 128, -128, -129, 300, -300, 65535, -65536, 1e6, -1e6];
  assert.deepEqual(decodeInts(encodeInts(values)), values);
});

test('encodeInts handles long runs of small values', () => {
  const values = Array.from({ length: 5000 }, (_, i) => (i % 7) - 3);
  assert.deepEqual(decodeInts(encodeInts(values)), values);
});

test('encodeCoords preserves coordinates to 1e-5 degree precision', () => {
  const coords = Array.from({ length: 400 }, (_, i) => [
    103.8 + i * 0.0007,
    1.3 + Math.sin(i / 5) * 0.01,
  ]);
  const decoded = decodeCoords(encodeCoords(coords));
  assert.equal(decoded.length, coords.length);
  for (let i = 0; i < coords.length; i++) {
    assert.ok(Math.abs(decoded[i][0] - Math.round(coords[i][0] * 1e5) / 1e5) < 1e-9);
    assert.ok(Math.abs(decoded[i][1] - Math.round(coords[i][1] * 1e5) / 1e5) < 1e-9);
  }
});

test('encodeProfile round-trips arrival/departure pairs', () => {
  const profile = [
    [0, 25],
    [95, 120],
    [180, 205],
    [260, 300],
  ];
  assert.deepEqual(decodeProfile(encodeProfile(profile)), profile);
});

test('encodeProfile handles a single stop and a negative first arrival', () => {
  const single = [[-330, 330]];
  assert.deepEqual(decodeProfile(encodeProfile(single)), single);
});
