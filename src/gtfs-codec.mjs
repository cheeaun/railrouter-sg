// Timetable packing shared by both ends: the GTFS builder writes
// src/gtfs-trains.json with these encoders and the app reads it back with the
// decoders. Keeping one copy here means the two sides cannot drift apart.
//
// The timetable is mostly long runs of small integers: coordinate deltas,
// dwell/run times, trip start deltas. Zig-zag packs signed values into
// non-negative integers, then each one is split into 5-bit chunks.
//
// The chunks map to the contiguous ASCII range 63–126 (the same trick as
// Google's encoded polylines, with 0x20 marking a continuation chunk). That
// alphabet compresses far better than base64's three disjoint ranges: with
// brotli it saves roughly 35% even though base64 carries one more bit per
// character. It is also Buffer- and btoa-free, so Parcel has nothing to
// polyfill.

export function encodeInts(values) {
  let out = '';
  for (const value of values) {
    let n = value < 0 ? -value * 2 - 1 : value * 2;
    do {
      let chunk = n % 32;
      n = Math.floor(n / 32);
      if (n > 0) chunk |= 0x20;
      out += String.fromCharCode(chunk + 63);
    } while (n > 0);
  }
  return out;
}

export function decodeInts(encoded) {
  const values = [];
  let n = 0;
  let scale = 1;
  for (let i = 0; i < encoded.length; i++) {
    const chunk = encoded.charCodeAt(i) - 63;
    n += (chunk & 0x1f) * scale;
    if (chunk & 0x20) {
      scale *= 32;
    } else {
      values.push(n % 2 ? -(n + 1) / 2 : n / 2);
      n = 0;
      scale = 1;
    }
  }
  return values;
}

// Coordinates are stored as a delta-of-delta chain in units of 1e-5 degrees
// (~1.1 m grid): track vertices are evenly spaced, so the change between
// consecutive deltas is usually a handful of units and fits in a single
// chunk. Starts with the absolute point, then the first delta, then how each
// delta changed.
export function encodeCoords(coords) {
  const values = [];
  let previousLng = 0;
  let previousLat = 0;
  let previousStepLng = 0;
  let previousStepLat = 0;
  for (const [lng, lat] of coords) {
    const x = Math.round(lng * 1e5);
    const y = Math.round(lat * 1e5);
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
    coords[i / 2] = [lng / 1e5, lat / 1e5];
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
