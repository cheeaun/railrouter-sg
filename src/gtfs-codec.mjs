// Timetable packing shared by both ends: the GTFS builder writes
// src/gtfs-trains.json with these encoders and the app reads it back with the
// decoders. Keeping one copy here means the two sides cannot drift apart.
//
// The timetable is mostly long runs of small integers: coordinate deltas,
// dwell/run times, trip start deltas. Zig-zag + varint packs each into one or
// two bytes, then base64 keeps the whole file valid JSON and gzip-friendly.

// btoa/atob exist in both Node and browsers, so the codec needs no Buffer
// polyfill when Parcel bundles the decoders.
export function encodeInts(values) {
  const bytes = [];
  for (const value of values) {
    let n = value < 0 ? -value * 2 - 1 : value * 2;
    while (n >= 0x80) {
      bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    bytes.push(n);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeInts(encoded) {
  const binary = atob(encoded);
  const values = [];
  let n = 0;
  let scale = 1;
  for (let i = 0; i < binary.length; i++) {
    const byte = binary.charCodeAt(i);
    n += (byte & 0x7f) * scale;
    if (byte & 0x80) {
      scale *= 128;
    } else {
      values.push(n % 2 ? -(n + 1) / 2 : n / 2);
      n = 0;
      scale = 1;
    }
  }
  return values;
}

// Coordinates are stored as a delta-of-delta chain in micro-degrees: track
// vertices are evenly spaced, so the change between consecutive deltas is
// usually a handful of units and fits in a single byte. Starts with the
// absolute point, then the first delta, then how each delta changed.
export function encodeCoords(coords) {
  const values = [];
  let previousLng = 0;
  let previousLat = 0;
  let previousStepLng = 0;
  let previousStepLat = 0;
  for (const [lng, lat] of coords) {
    const x = Math.round(lng * 1e6);
    const y = Math.round(lat * 1e6);
    const stepLng = x - previousLng;
    const stepLat = y - previousLat;
    values.push(stepLng - previousStepLng, stepLat - previousStepLat);
    previousLng = x;
    previousLat = y;
    previousStepLng = stepLng;
    previousStepLat = stepLat;
  }
  return encodeInts(values);
}

export function decodeCoords(encoded) {
  const values = decodeInts(encoded);
  const coords = new Array(values.length / 2);
  let lng = 0;
  let lat = 0;
  let stepLng = 0;
  let stepLat = 0;
  for (let i = 0; i < values.length; i += 2) {
    stepLng += values[i];
    stepLat += values[i + 1];
    lng += stepLng;
    lat += stepLat;
    coords[i / 2] = [lng / 1e6, lat / 1e6];
  }
  return coords;
}

// A profile is arrival/departure seconds relative to the trip's first
// departure. Store the first arrival, then alternate dwell, run, dwell, run…
export function encodeProfile(profile) {
  const values = [profile[0][0], profile[0][1] - profile[0][0]];
  for (let i = 1; i < profile.length; i++) {
    values.push(profile[i][0] - profile[i - 1][1], profile[i][1] - profile[i][0]);
  }
  return encodeInts(values);
}

export function decodeProfile(encoded) {
  const values = decodeInts(encoded);
  const profile = new Array(values.length / 2);
  let time = values[0];
  for (let i = 0; i < values.length; i += 2) {
    const departure = time + values[i + 1];
    profile[i / 2] = [time, departure];
    if (i + 2 < values.length) time = departure + values[i + 2];
  }
  return profile;
}
