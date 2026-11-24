// GPU-driven trains.
//
// The timetable is resolved on the GPU: three static float textures hold the
// path vertices, per-path metadata and the stop profiles, and the only thing
// the CPU sends per frame is the service-day time. The render loop rebuilds the
// (small) list of active trips about once a simulated second; between rebuilds
// it writes no per-train data at all.
//
// Layout:
//   uAtlas     RGBA32F  [localMercatorX, localMercatorY, cosHeading, sinHeading]
//   uPathMeta  RGBA32F  [atlasOffset, vertexCount, lastDistance, unused] per pool
//   uProfiles  RGBA32F  [arrival, departure, stopDistance, unused] per stop row
//
// Paths are resampled to uniform SPACING so the shader can turn a distance
// along the track into a vertex index without a search. Resampling follows the
// existing polyline exactly (no invented curvature); headings are smoothed
// over a short arc-length window so corners rotate gradually.

import { decodeCoords, decodeInts, decodeProfile } from './gtfs-codec.mjs';

const EARTH_RADIUS = 6371000;
const RAD = Math.PI / 180;

// Metres between resampled path vertices.
export const SPACING = 10;
// Seconds a train takes to fade/scale in and out.
export const FADE = 0.7;
// Seconds a train spends pulling out of, or braking into, a platform at 1x.
// Playback scales it so the ease lasts the same wall-clock time at any speed.
export const RAMP = 15;
// Ceiling on the ramp as a share of the leg at 1x. It rises toward a full
// triangular profile at high playback, where the whole leg is under a second
// and a fixed share is the only thing left that can keep the ease visible.
export const RAMP_SHARE = 0.35;
// Texels per atlas row. 4096 keeps every mobile GPU comfortably inside
// MAX_TEXTURE_SIZE while still giving us ~74 rows for the whole network.
const ATLAS_WIDTH = 4096;
// Profile rows are flattened into a 1024-wide texture so the height stays well
// under even the smallest MAX_TEXTURE_SIZE.
const PROFILE_WIDTH = 1024;
// floats per active trip: poolId, start, duration, profileRow,
// stopCount, r, g, b, handover
export const INSTANCE_STRIDE = 9;
// Active list look-ahead, in simulated seconds, used when the caller does not
// supply one. It must exceed the rebuild interval plus FADE so a trip is
// already resident while its alpha is still zero instead of popping in.
const PREFETCH = 2;

// ?solid draws oversized flat line-coloured boxes with no fade, for debugging
// texture/instance problems without the car shader.
const SOLID = new URLSearchParams(location.search).has('solid');

// Local mercator origin: keep float32 positions near zero.
const ORIGIN_LNG = 103.82;
const ORIGIN_LAT = 1.35;
const ORIGIN_SIN = Math.sin(ORIGIN_LAT * RAD);
const ORIGIN_X = (ORIGIN_LNG + 180) / 360;
const ORIGIN_Y = 0.5 - Math.log((1 + ORIGIN_SIN) / (1 - ORIGIN_SIN)) / (4 * Math.PI);

const localX = (lng) => (lng + 180) / 360 - ORIGIN_X;
function localY(lat) {
  const sin = Math.sin(lat * RAD);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) - ORIGIN_Y;
}

function metres(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const lat = ((a[1] + b[1]) / 2) * RAD;
  return Math.hypot(dLat, dLon * Math.cos(lat)) * EARTH_RADIUS;
}

export function toRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// Resample one polyline at a uniform arc-length step and bake a smoothed
// heading per vertex. Returns flat local-mercator arrays plus the exact
// polyline length so the shader can interpolate the final short segment.
function resample(coords) {
  const n = coords.length;
  const cumulative = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cumulative[i] = cumulative[i - 1] + metres(coords[i - 1], coords[i]);
  }
  const length = cumulative[n - 1];
  const slots = Math.floor(length / SPACING) + 1;

  const lngs = [];
  const lats = [];
  let cursor = 0;
  for (let slot = 0; slot < slots; slot++) {
    const distance = slot * SPACING;
    while (cursor < n - 2 && cumulative[cursor + 1] <= distance) cursor++;
    const span = cumulative[cursor + 1] - cumulative[cursor] || 1;
    let t = (distance - cumulative[cursor]) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const a = coords[cursor];
    const b = coords[cursor + 1];
    lngs.push(a[0] + (b[0] - a[0]) * t);
    lats.push(a[1] + (b[1] - a[1]) * t);
  }
  // Keep the true endpoint unless it coincides with the last 10 m slot.
  if (length - (slots - 1) * SPACING > 1e-6) {
    lngs.push(coords[n - 1][0]);
    lats.push(coords[n - 1][1]);
  }
  if (lngs.length < 2) {
    lngs.push(lngs[0]);
    lats.push(lats[0]);
  }

  const count = lngs.length;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = localX(lngs[i]);
    y[i] = localY(lats[i]);
  }
  // Heading from a +-3 slot (about +-30 m) chord: abrupt corners become a
  // short, smooth swing, which is all the eye needs at any zoom.
  const cx = new Float32Array(count);
  const cy = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 3);
    const b = Math.min(count - 1, i + 3);
    const dx = x[b] - x[a];
    const dy = y[b] - y[a];
    const len = Math.hypot(dx, dy) || 1;
    cx[i] = dx / len;
    cy[i] = dy / len;
  }
  return { count, x, y, cx, cy, length };
}

export function prepare(data) {
  const serviceCount = Object.keys(data.services).length;
  const serviceOrder = new Array(serviceCount);
  for (const [id, service] of Object.entries(data.services)) serviceOrder[service.i] = id;

  // One pass to size the profile texture (max stops in any pattern).
  let maxStops = 2;
  let profileRows = 0;
  for (const line of Object.values(data.lines)) {
    for (const path of line.paths) {
      const stops = decodeInts(path.s).length;
      if (stops > maxStops) maxStops = stops;
      profileRows += path.p.length;
    }
  }
  const profileHeight = Math.max(1, Math.ceil((profileRows * maxStops) / PROFILE_WIDTH));
  const profiles = new Float32Array(profileHeight * PROFILE_WIDTH * 4);

  const atlas = [];
  const pools = [];
  const paths = [];
  const lines = {};
  // First and last point of every coordinate pool, for terminal handovers.
  const poolEnds = [];
  let row = 0;
  let vertexCount = 0;
  let firstStart = Infinity;
  let lastEnd = -Infinity;
  // Per-service extremes, so the scrubber can show only the part of the day the
  // selected timetable actually runs.
  const serviceWindows = new Map();

  const lineKeys = Object.keys(data.lines).sort(
    (a, b) => (data.lines[a].order ?? 99) - (data.lines[b].order ?? 99),
  );

  for (const key of lineKeys) {
    const line = data.lines[key];
    const rgb = toRgb(line.color);
    const poolBase = pools.length / 4;
    lines[key] = {
      name: line.name,
      code: line.code || key,
      order: line.order ?? 99,
      color: line.color,
    };

    for (const encoded of line.coords) {
      const coords = decodeCoords(encoded);
      const pool = resample(coords);
      const offset = vertexCount;
      for (let i = 0; i < pool.count; i++) {
        atlas.push(pool.x[i], pool.y[i], pool.cx[i], pool.cy[i]);
      }
      vertexCount += pool.count;
      pools.push(offset, pool.count, pool.length, 0);
      poolEnds.push(coords[0], coords[coords.length - 1]);
    }

    for (const path of line.paths) {
      const stopDeltas = decodeInts(path.s);
      const stopCount = stopDeltas.length;
      const stopDistances = new Float64Array(stopCount);
      for (let i = 0; i < stopCount; i++) {
        stopDistances[i] = (i ? stopDistances[i - 1] : 0) + stopDeltas[i];
      }

      const decoded = path.p.map(decodeProfile);
      const profileBase = row;
      const durations = new Array(decoded.length);
      for (let pi = 0; pi < decoded.length; pi++) {
        const profile = decoded[pi];
        const lastPair = profile[profile.length - 1];
        durations[pi] = lastPair ? lastPair[1] : 0;
        const base = row * maxStops * 4;
        row++;
        for (let i = 0; i < stopCount; i++) {
          const pair = profile[Math.min(i, profile.length - 1)] || [0, 0];
          const o = base + i * 4;
          profiles[o] = pair[0];
          profiles[o + 1] = pair[1];
          profiles[o + 2] = stopDistances[i];
        }
      }

      const startDeltas = decodeInts(path.t);
      const codes = decodeInts(path.tp);
      const trips = new Array(startDeltas.length);
      const starts = new Float64Array(startDeltas.length);
      let start = 0;
      let maxDuration = 0;
      for (let i = 0; i < startDeltas.length; i++) {
        start += startDeltas[i];
        const code = codes[i];
        const profileIndex = Math.floor(code / serviceCount);
        const serviceIndex = code % serviceCount;
        const duration = durations[profileIndex] || 0;
        if (duration > maxDuration) maxDuration = duration;
        if (start < firstStart) firstStart = start;
        const end = start + duration;
        if (end > lastEnd) lastEnd = end;
        starts[i] = start;
        trips[i] = {
          start,
          duration,
          profileRow: profileBase + profileIndex,
          service: serviceOrder[serviceIndex],
        };
        const serviceId = serviceOrder[serviceIndex];
        const extent = serviceWindows.get(serviceId);
        if (extent) {
          if (start < extent.first) extent.first = start;
          if (end > extent.last) extent.last = end;
        } else {
          serviceWindows.set(serviceId, { first: start, last: end });
        }
      }

      paths.push({
        key,
        poolId: poolBase + path.c,
        stopCount,
        starts,
        trips,
        maxDuration,
        rgb,
        first: poolEnds[(poolBase + path.c) * 2],
        last: poolEnds[(poolBase + path.c) * 2 + 1],
      });
    }
  }

  const handovers = linkTerminals(paths);

  // Pad the atlas to whole rows: texImage2D wants the full rectangle.
  const atlasRows = Math.max(1, Math.ceil(vertexCount / ATLAS_WIDTH));
  const atlasData = new Float32Array(atlasRows * ATLAS_WIDTH * 4);
  atlasData.set(atlas);

  return {
    atlas: atlasData,
    atlasWidth: ATLAS_WIDTH,
    atlasRows,
    vertexCount,
    pools: new Float32Array(pools),
    poolCount: pools.length / 4,
    profiles,
    profileRows,
    profileWidth: PROFILE_WIDTH,
    profileHeight,
    maxStops,
    paths,
    lines,
    lineKeys,
    handovers,
    serviceWindows,
    // First departure and last arrival across the whole feed.
    extent: { first: firstStart, last: lastEnd },
    // Bleed a minute past the first departure and last arrival, to the minute
    // either side, so both ends of the scrubber are an empty timetable.
    window: {
      start: Math.ceil(firstStart / 60) * 60 - 60,
      end: Math.floor(lastEnd / 60) * 60 + 60,
    },
  };
}

// Neither `block_id` nor anything else in the packed timetable says which train
// turns back into which, but it does not have to: a terminus is a single point
// shared by both directions, and both platform stops sit on it, so the trip that
// arrives there and the trip that leaves from there minutes later are the same
// vehicle. Pair them one departure per arrival, newest waiting train first, so
// the overlay can hold that train at the platform instead of fading it out and
// fading its successor in on the same spot.
const HANDOVER_GAP = 600;

function linkTerminals(paths) {
  const terminalKey = (point) => `${point[0].toFixed(5)},${point[1].toFixed(5)}`;
  const terminals = new Map();
  const terminalAt = (point) => {
    const key = terminalKey(point);
    let terminal = terminals.get(key);
    if (!terminal) terminals.set(key, (terminal = { arrivals: [], departures: [] }));
    return terminal;
  };
  for (const path of paths) {
    const end = terminalAt(path.last);
    const start = terminalAt(path.first);
    for (const trip of path.trips) {
      end.arrivals.push(trip);
      start.departures.push(trip);
    }
  }

  let handovers = 0;
  for (const { arrivals, departures } of terminals.values()) {
    if (!arrivals.length || !departures.length) continue;
    const endOf = (trip) => trip.start + trip.duration;
    arrivals.sort((a, b) => endOf(a) - endOf(b));
    departures.sort((a, b) => a.start - b.start);
    // Trains standing at the platform that no departure has claimed yet, oldest
    // first, so the newest one is the nearest match.
    const waiting = new Map();
    let next = 0;
    for (const departure of departures) {
      while (next < arrivals.length && endOf(arrivals[next]) <= departure.start) {
        const arrival = arrivals[next++];
        const queue = waiting.get(arrival.service);
        if (queue) queue.push(arrival);
        else waiting.set(arrival.service, [arrival]);
      }
      const queue = waiting.get(departure.service);
      if (!queue) continue;
      while (queue.length && departure.start - endOf(queue[queue.length - 1]) > HANDOVER_GAP) {
        queue.pop();
      }
      const arrival = queue.pop();
      if (!arrival) continue;
      arrival.next = departure.start;
      departure.prev = true;
      handovers++;
    }
  }

  // Held trips are on screen for longer than their own duration, so the active
  // list's look-back has to cover the whole span.
  for (const path of paths) {
    for (const trip of path.trips) {
      if (trip.next && trip.next - trip.start > path.maxDuration) {
        path.maxDuration = trip.next - trip.start;
      }
    }
  }
  return handovers;
}

// Last index whose start is <= seconds, or -1.
function lastStartedIndex(starts, seconds) {
  let low = -1;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= seconds) low = mid;
    else high = mid - 1;
  }
  return low;
}

// Fill `out` with the trips that should be on the GPU right now. Called about
// once per simulated second, never per frame. When `counts` is given it is
// filled with running trips per line (finished trips that are still fading are
// drawn but not counted, matching the original pill behaviour).
export function buildInstances(
  prepared,
  seconds,
  services,
  out,
  fadeSeconds = FADE,
  prefetchSeconds = PREFETCH,
  counts = null,
) {
  let count = 0;
  const capacity = out.length / INSTANCE_STRIDE;
  const horizon = seconds + prefetchSeconds;
  if (counts) {
    for (const key of prepared.lineKeys) counts[key] = 0;
  }
  for (const path of prepared.paths) {
    const last = lastStartedIndex(path.starts, horizon);
    if (last < 0) continue;
    const first = lastStartedIndex(path.starts, seconds - path.maxDuration - fadeSeconds);
    for (let i = first + 1; i <= last; i++) {
      const trip = path.trips[i];
      if (!services.has(trip.service)) continue;
      const elapsed = seconds - trip.start;
      // A train that hands over to another trip stands at the platform until
      // that trip departs; the next one takes over at the same point with no
      // fade on either side. Everything else fades out after its own duration.
      // Both spans are inclusive, so the handover second draws both at the
      // same spot (the counts count both trips for that second, as the
      // timetable does) and neither is ever missing.
      const until = trip.next ? trip.next - trip.start : trip.duration + fadeSeconds;
      if (elapsed > until) continue;
      if (count >= capacity) return count;
      const o = count * INSTANCE_STRIDE;
      out[o] = path.poolId;
      out[o + 1] = trip.start;
      out[o + 2] = trip.duration;
      out[o + 3] = trip.profileRow;
      out[o + 4] = path.stopCount;
      out[o + 5] = path.rgb[0];
      out[o + 6] = path.rgb[1];
      out[o + 7] = path.rgb[2];
      out[o + 8] = (trip.prev ? 1 : 0) | (trip.next ? 2 : 0);
      count++;
      if (counts && elapsed >= 0 && elapsed <= trip.duration) {
        counts[path.key] = (counts[path.key] || 0) + 1;
      }
    }
  }
  return count;
}

// The car model, in icon pixels: x runs along the car, y across it and z up
// from the track point. It is an extruded rounded rectangle, so the roof, the
// flanks and the nose/tail each take one flat cel tone.
const CAR_LENGTH = 38;
const CAR_WIDTH = 16;
const CAR_HEIGHT = 11;
const CAR_RADIUS = 4.5;
const CAR_ARC_STEPS = 6;
// Screen thickness of the black rim, in icon pixels.
const CAR_OUTLINE = 2.0;

function buildCarMesh() {
  const arcX = CAR_LENGTH / 2 - CAR_RADIUS;
  const arcY = CAR_WIDTH / 2 - CAR_RADIUS;
  const ring = [];
  for (let corner = 0; corner < 4; corner++) {
    const signX = corner === 1 || corner === 2 ? -1 : 1;
    const signY = corner >= 2 ? -1 : 1;
    for (let i = 0; i <= CAR_ARC_STEPS; i++) {
      const angle = ((corner * 90 + (90 * i) / CAR_ARC_STEPS) * Math.PI) / 180;
      const nx = Math.cos(angle);
      const ny = Math.sin(angle);
      ring.push([signX * arcX + nx * CAR_RADIUS, signY * arcY + ny * CAR_RADIUS, nx, ny]);
    }
  }

  const data = [];
  // Outline vertices move along the angle-averaged normal so the expanded
  // shell stays watertight where the roof meets the wall.
  const hull = (nx, ny) => {
    const length = Math.hypot(nx, ny, 1);
    return [nx / length, ny / length, 1 / length];
  };
  // The bottom ring expands down as well as out, mirroring the roof ring. With
  // only the lateral component the underside rim is a ground-plane offset, and
  // a pitched camera foreshortens that by sin(pitch); it came out thinner than
  // the other three sides instead of matching them.
  const hullDown = (nx, ny) => {
    const length = Math.hypot(nx, ny, 1);
    return [nx / length, ny / length, -1 / length];
  };
  const vertex = (x, y, z, nx, ny, nz, hx, hy, hz) => {
    data.push(x, y, z, nx, ny, nz, hx, hy, hz);
    return data.length / 9 - 1;
  };

  // Shared vertices plus an index list. The vertex shader does the whole
  // per-trip job (stop-profile walk, atlas fetch, homography) once per vertex,
  // so letting the roof fan, the wall top and the wall bottom reuse corners
  // drops that from 252 runs per car to 85; the GPU's post-transform cache
  // collapses the repeated indices.
  const count = ring.length;
  const roof = ring.map((p) => vertex(p[0], p[1], CAR_HEIGHT, 0, 0, 1, ...hull(p[2], p[3])));
  const top = ring.map((p) => vertex(p[0], p[1], CAR_HEIGHT, p[2], p[3], 0, ...hull(p[2], p[3])));
  const bottom = ring.map((p) => vertex(p[0], p[1], 0, p[2], p[3], 0, ...hullDown(p[2], p[3])));
  const centre = vertex(0, 0, CAR_HEIGHT, 0, 0, 1, 0, 0, 1);

  const index = [];
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    // Roof fan, then the two wall triangles. Culling is off and the projection
    // keeps these faces on the outside at every pitch; the wall normals are
    // per-vertex so the rounded ends shade smooth.
    index.push(centre, roof[j], roof[i]);
    index.push(top[i], bottom[j], bottom[i]);
    index.push(top[i], top[j], bottom[j]);
  }
  return { data: new Float32Array(data), index: new Uint16Array(index), count: index.length };
}

// The flat icon used while the camera is level: one quad, larger than the car
// so the black ring has room. It is kept in the same buffer as the model so a
// single VAO can draw either of them.
const FLAT_QUAD = (() => {
  const data = [];
  const vertex = (x, y) => data.push(x, y, 0, 0, 0, 1, 0, 0, 1);
  vertex(-24, -16);
  vertex(24, -16);
  vertex(-24, 16);
  vertex(24, 16);
  return { data: new Float32Array(data), index: new Uint16Array([0, 1, 2, 2, 1, 3]), count: 6 };
})();

const CAR_MESH = buildCarMesh();
const CAR_VERTICES = new Float32Array([...FLAT_QUAD.data, ...CAR_MESH.data]);
// Indices address vertices, so the car's list shifts past the flat quad's four.
const CAR_INDICES = new Uint16Array([
  ...FLAT_QUAD.index,
  ...CAR_MESH.index.map((i) => i + FLAT_QUAD.data.length / 9),
]);
// Byte offset of the car's indices inside CAR_INDICES.
const CAR_INDEX_OFFSET = FLAT_QUAD.count * 2;

const vertexShader = (maxStops) => `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aHullNormal;
layout(location = 3) in vec4 aTrip;  // poolId, start, duration, profileRow
layout(location = 4) in vec4 aTrip2; // stopCount, r, g, b
layout(location = 5) in float aHandover; // 1 continues from, 2 continues into

uniform mat3 uProjection;
uniform vec2 uCenter;
uniform vec2 uViewport;
uniform float uUnitsPerPixel;
uniform float uScale;
uniform float uSinPitch;
uniform float uHull;
uniform float uTime;
uniform float uFade;
uniform float uRamp;
uniform float uRampShare;
uniform float uRampFrom;
uniform float uRampShareFrom;
uniform float uRampSwitchAt;
uniform float uAtlasWidth;
uniform float uSolid;
uniform float uReveal;
uniform sampler2D uAtlas;
uniform sampler2D uPathMeta;
uniform sampler2D uProfiles;

out vec3 vLocal;
out vec3 vNormal;
out vec3 vColor;
out float vAlpha;
const float OUTLINE = ${CAR_OUTLINE.toFixed(1)};

const float SPACING = ${SPACING.toFixed(1)};
const int MAX_STOPS = ${maxStops};
const int PROFILE_W = ${PROFILE_WIDTH};

// Fraction of the way along one stop-to-stop leg at t seconds into it.
// Velocity ramps up, cruises, then ramps down over the same span, so trains
// ease out of and into platforms instead of snapping between full speed and a
// standstill. The ramp is scaled to playback but the cap keeps it inside the
// leg, so short hops become triangular; the ease always starts and ends at zero
// speed and hits k = 1.
float legProgress(float t, float span, float ramp, float share) {
  float a = max(min(ramp, span * share), 0.001);
  float cruise = max(span - a, 0.001);
  if (t <= a) return (t * t) / (2.0 * a * cruise);
  if (t >= span - a) {
    float remaining = span - t;
    return 1.0 - (remaining * remaining) / (2.0 * a * cruise);
  }
  return (t - a * 0.5) / cruise;
}

vec4 atlasAt(int index) {
  int x = int(mod(float(index), uAtlasWidth));
  int y = int(floor(float(index) / uAtlasWidth));
  return texelFetch(uAtlas, ivec2(x, y), 0);
}

vec4 profileAt(int row, int stop) {
  int index = row * MAX_STOPS + stop;
  return texelFetch(uProfiles, ivec2(index % PROFILE_W, index / PROFILE_W), 0);
}

// True when a projected anchor is behind the camera or so far outside the
// viewport that its quad cannot be visible. Far outside also covers a quad
// hovering just in front of the horizon, whose tiny positive w lets a corner
// cross w = 0.
bool offscreen(vec3 anchor) {
  if (anchor.z <= 0.0) return true;
  vec2 css = anchor.xy / anchor.z;
  return css.x < -uViewport.x || css.x > uViewport.x * 2.0 ||
         css.y < -uViewport.y || css.y > uViewport.y * 2.0;
}

void main() {
  float elapsed = uTime - aTrip.y;
  float enter = clamp(elapsed / uFade, 0.0, 1.0);
  float leave = clamp((elapsed - aTrip.z) / uFade, 0.0, 1.0);
  // At a terminus the same train turns back into the next trip: hold it at the
  // platform at full size and let the successor carry on from that point, with
  // no fade out here and no fade in there. The successor is only prefetched a
  // little early, so it still stays invisible until its own departure.
  int handover = int(aHandover + 0.5);
  if ((handover & 1) != 0 && elapsed >= 0.0) enter = 1.0;
  if ((handover & 2) != 0) leave = 0.0;
  float alpha = smoothstep(0.0, 1.0, enter) * (1.0 - smoothstep(0.0, 1.0, leave));
  alpha *= smoothstep(0.0, 1.0, uReveal);

  vLocal = vec3(0.0);
  vNormal = aNormal;
  vColor = aTrip2.yzw;
  vAlpha = 0.0;
  if (uSolid > 0.5) {
    alpha = 1.0;
  }
  if (alpha <= 0.001) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float grow = (0.85 + 0.15 * smoothstep(0.0, 1.0, enter)) *
               (0.85 + 0.15 * (1.0 - smoothstep(0.0, 1.0, leave)));
  if (uSolid > 0.5) grow = 6.0;

  // Time -> distance along the track: walk the stop profile, then interpolate
  // between the two surrounding stops. No search, no CPU.
  float t = clamp(elapsed, 0.0, aTrip.z);
  int row = int(aTrip.w);
  int stops = int(aTrip2.x);

  vec4 prev = profileAt(row, 0);
  float prevDeparture = prev.y;
  float prevDistance = prev.z;
  float distance = prev.z;

  for (int i = 1; i < MAX_STOPS; i++) {
    if (i >= stops) break;
    vec4 stop = profileAt(row, i);
    if (t < stop.x) {
      float span = max(stop.x - prevDeparture, 0.001);
      float leg = clamp(t - prevDeparture, 0.0, span);
      // Use the ramp that was in force when this leg started, so changing
      // playback speed never moves a train that is already under way; it only
      // affects the legs that start afterwards.
      bool switched = aTrip.y + prevDeparture < uRampSwitchAt;
      float legRamp = switched ? uRampFrom : uRamp;
      float legShare = switched ? uRampShareFrom : uRampShare;
      float k = clamp(legProgress(leg, span, legRamp, legShare), 0.0, 1.0);
      distance = mix(prevDistance, stop.z, k);
      break;
    }
    if (t <= stop.y) {
      distance = stop.z;
      break;
    }
    prevDeparture = stop.y;
    prevDistance = stop.z;
    distance = stop.z;
  }

  // Distance -> position + heading. The final segment is shorter than
  // SPACING when the path length is not a multiple of 10 m.
  vec4 meta = texelFetch(uPathMeta, ivec2(int(aTrip.x), 0), 0);
  float offset = meta.x;
  float count = max(meta.y, 2.0);
  float lastDistance = meta.z;

  distance = clamp(distance, 0.0, lastDistance);
  float f = min(distance / SPACING, count - 1.0);
  int i0 = min(int(floor(f)), int(count) - 2);
  float spanStart = float(i0) * SPACING;
  float span = (i0 == int(count) - 2) ? max(lastDistance - spanStart, 0.001) : SPACING;
  float k = clamp((distance - spanStart) / span, 0.0, 1.0);

  vec4 va = atlasAt(int(offset) + i0);
  vec4 vb = atlasAt(int(offset) + i0 + 1);
  vec2 pos = mix(va.xy, vb.xy, k);
  vec2 dir = normalize(mix(va.zw, vb.zw, k) + vec2(1e-5, 0.0));

  // A pitched camera tilts the ground plane, so everything beyond the horizon
  // is behind the viewer and its homography w turns negative. Dividing by a
  // near-zero w mirrors the quad across the screen and stretches it into a
  // viewport-filling bar; dividing by a negative one flips it. Every corner of
  // an instance shares the same anchor position, so one test culls all four,
  // the way MapLibre culls symbols past the horizon. At low pitch or low zoom
  // the horizon is beyond the network and this never triggers.
  if (offscreen(uProjection * vec3(pos - uCenter, 1.0))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vLocal = vec3(0.0);
    vAlpha = 0.0;
    return;
  }

  // The mesh is authored in icon pixels. uProjection is a homography from
  // local Mercator offsets (relative to uCenter) to CSS pixels, so the XY of
  // every vertex lands exactly where the ground under it lands. Height needs
  // its own term: with no camera roll a raised point moves straight up the
  // screen, and it foreshortens by sin(pitch) — 0 when looking straight down,
  // where the car's roof is all you see. Dividing by the homography's w grades
  // that lift with distance the same way the ground is graded.
  vec3 local = aPosition + aHullNormal * (uHull * OUTLINE);
  vec2 planar = local.xy * uScale * grow;
  vec2 rotated = vec2(planar.x * dir.x - planar.y * dir.y, planar.x * dir.y + planar.y * dir.x);
  vec2 world = pos + rotated * uUnitsPerPixel;
  vec3 screen = uProjection * vec3(world - uCenter, 1.0);
  vec2 css = screen.xy / screen.z;
  css.y -= local.z * uScale * grow * uSinPitch / screen.z;
  // The homography's w is proportional to camera depth, so it doubles as the
  // depth value that keeps the car's own faces in the right order. The ground
  // point alone is not enough: every vertex of a car shares the same w, so the
  // roof and the walls would test equal and paint in index order. For a ground
  // point at horizontal distance r the camera depth is r*cos(pitch)+H*sin(pitch),
  // so d(w)/dr is gradW (the homography's third row), and raising by h changes
  // depth by -h*sin(pitch), giving d(w)/dh = -gradW * tan(pitch). This is exact,
  // not a tuned fudge, and is zero at pitch 0 where height has no depth.
  float sinPitch = uSinPitch;
  float cosPitch = sqrt(max(1.0 - sinPitch * sinPitch, 1e-8));
  float height = local.z * uScale * grow * uUnitsPerPixel;
  float gradW = length(vec2(uProjection[0][2], uProjection[1][2]));
  float w = screen.z - height * gradW * sinPitch / cosPitch;
  // Map w monotonically into clip depth without the plateau a hard clamp gives:
  // smaller w (nearer) maps smaller and so wins the LESS test.
  float depth = clamp(1.0 - 2.0 / (max(w, 0.0) + 1.0), -1.0, 1.0);
  gl_Position = vec4(
    css.x / uViewport.x * 2.0 - 1.0,
    1.0 - css.y / uViewport.y * 2.0,
    depth,
    1.0
  );

  vLocal = aPosition;
  vAlpha = alpha;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vLocal;
in vec3 vNormal;
in vec3 vColor;
in float vAlpha;
uniform float uHull;
uniform float uFlat;
uniform float uSolid;
out vec4 outColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

const float LENGTH = 38.0;
const float WIDTH = 16.0;
const float HEIGHT = 11.0;
// The roof is the car's lightest plane; the flat icon paints its body with the
// same lift so the 2D/3D switch at 5 deg does not recolour every train.
const float ROOF_LIFT = 1.18;

// The flat icon drawn while the camera is level. Its body is exactly the car's
// top-down footprint, and its dark bar at the nose is the model's front window.
vec4 flatIcon(vec2 p) {
  const float R = 5.0;
  const float STROKE = 2.0;
  const float WIN_FROM_NOSE = 4.0;
  const float WIN_LEN = 6.0;
  const float WIN_THICK = 8.0;
  const float WIN_R = 2.0;

  float aa = max(fwidth(p.x), 0.0001);

  float dOuter = sdRoundBox(p, vec2(LENGTH, WIDTH) * 0.5, R + STROKE * 0.5);
  float dInner = sdRoundBox(
    p,
    vec2(LENGTH - STROKE * 2.0, WIDTH - STROKE * 2.0) * 0.5,
    max(R - STROKE * 0.5, 0.5)
  );
  float outer = 1.0 - smoothstep(-aa, aa, dOuter);
  float inner = 1.0 - smoothstep(-aa, aa, dInner);

  vec2 winCenter = vec2(LENGTH * 0.5 - WIN_FROM_NOSE - WIN_LEN * 0.5, 0.0);
  float dWin = sdRoundBox(p - winCenter, vec2(WIN_LEN, WIN_THICK) * 0.5, WIN_R);
  float win = 1.0 - smoothstep(-aa, aa, dWin);

  vec3 color = mix(vec3(0.0667), vColor * ROOF_LIFT, inner);
  color = mix(color, vec3(0.0), win * inner);
  float alpha = outer * vAlpha;
  return vec4(color * alpha, alpha);
}

void main() {
  if (uFlat > 0.5) {
    outColor = flatIcon(vLocal.xy);
    return;
  }

  // Outline pass: the car mesh expanded along its vertex normals, filled black
  // behind the body, so only a black rim outside the silhouette survives.
  if (uHull > 0.5) {
    outColor = vec4(vec3(0.045) * vAlpha, vAlpha);
    return;
  }
  if (uSolid > 0.5) {
    outColor = vec4(vColor, 1.0);
    return;
  }

  // Three flat tones fixed to the car's own frame instead of a sun: the roof
  // is always the lightest plane, the flanks sit at the line colour and the
  // nose and tail a shade darker. Any camera angle then shows at least two of
  // them, so a tilted car never flattens into one tone.
  vec3 n = normalize(vNormal);
  float roof = clamp(n.z, 0.0, 1.0);
  float end = abs(n.x);
  vec3 paint = mix(vColor * mix(1.0, 0.8, end), vColor * ROOF_LIFT, roof);

  // The dark bar of the flat icon becomes this windscreen: it covers the nose
  // face only, leaving the roof a single clean colour.
  vec2 q = vLocal.xy;
  float glass =
    step(LENGTH * 0.5 - 5.0, q.x) *
    step(3.0, vLocal.z) *
    step(vLocal.z, HEIGHT - 1.5);

  float aa = max(fwidth(q.y), fwidth(vLocal.z));
  float dGlint = sdRoundBox(vec2(q.y + 1.2, vLocal.z - 7.4), vec2(2.4, 1.2), 0.7);
  float glint = (1.0 - smoothstep(-aa, aa, dGlint)) * glass;

  paint = mix(paint, vec3(0.035), glass);
  paint = mix(paint, vec3(0.68), glint * 0.45);
  outColor = vec4(paint * vAlpha, vAlpha);
}
`;

function latFromMercatorY(y) {
  return (Math.atan(Math.sinh(2 * Math.PI * (0.5 - y))) * 180) / Math.PI;
}

// Solves for the 3x3 homography (h33 = 1) mapping four source points to four
// destination points. For a flat Mercator plane under MapLibre's camera a
// homography is exact, so this handles bearing and pitch without touching
// MapLibre's internals.
function solveHomography(src, dst, out) {
  const a = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (pivot !== col) {
      const swap = a[col];
      a[col] = a[pivot];
      a[pivot] = swap;
    }
    const scale = a[col][col] || 1e-12;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = a[row][col] / scale;
      if (!factor) continue;
      for (let c = col; c <= 8; c++) a[row][c] -= factor * a[col][c];
    }
  }
  const v = new Array(8);
  for (let i = 0; i < 8; i++) v[i] = a[i][8] / (a[i][i] || 1e-12);
  // Store column-major for uniformMatrix3fv. Row-major coefficients are
  // [h11 h12 h13; h21 h22 h23; h31 h32 1].
  out[0] = v[0];
  out[1] = v[3];
  out[2] = v[6];
  out[3] = v[1];
  out[4] = v[4];
  out[5] = v[7];
  out[6] = v[2];
  out[7] = v[5];
  out[8] = 1;
  return out;
}

const CONTEXT_OPTIONS = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: true,
  stencil: false,
  powerPreference: 'high-performance',
};

// Draws the trains on their own transparent WebGL2 canvas laid over the map.
// Unlike a MapLibre custom layer this leaves the basemap alone: the map only
// repaints for camera changes, while the overlay repaints each animation frame.
export function createTrainOverlay(map, prepared) {
  const container = map.getContainer();
  const canvas = document.createElement('canvas');
  canvas.className = 'gpu-trains-overlay';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '1';
  container.appendChild(canvas);

  let gl = canvas.getContext('webgl2', CONTEXT_OPTIONS);
  if (!gl) throw new Error('WebGL2 is not available for the train overlay');

  let program = null;
  let vao = null;
  let meshBuffer = null;
  let indexBuffer = null;
  let instanceBuffer = null;
  let capacity = 0;
  let count = 0;
  let data = null;
  let dirty = false;
  let uniforms = null;
  let atlasTexture = null;
  let metaTexture = null;
  let profileTexture = null;
  let seconds = 0;
  let fadeSeconds = FADE;
  let rampSeconds = RAMP;
  let rampShare = RAMP_SHARE;
  let rampFrom = RAMP;
  let rampShareFrom = RAMP_SHARE;
  let rampSwitchAt = 0;
  let reveal = 1;
  let uploadMs = 0;

  const homography = new Float32Array(9);
  let centerX = 0;
  let centerY = 0;
  let cssWidth = 1;
  let cssHeight = 1;
  const mapCanvas = map.getCanvas();
  // clientWidth/clientHeight are layout reads, and asking for them every frame
  // makes the browser flush pending layout work. The container only changes
  // size on a resize, so sample them here and refresh on that event instead.
  const measure = () => {
    cssWidth = mapCanvas.clientWidth || 1;
    cssHeight = mapCanvas.clientHeight || 1;
  };
  measure();
  // Camera state of the last homography, compared field by field: this runs on
  // every move event, and formatting a key string allocated one per call.
  let camLng = NaN;
  let camLat = NaN;
  let camZoom = NaN;
  let camBearing = NaN;
  let camPitch = NaN;
  let camCssWidth = 0;
  let camCssHeight = 0;
  // Derived from the camera once per change rather than once per frame.
  let unitsPerPixel = 1 / (512 * Math.pow(2, 10));
  let zoomScale = 0.34;
  let sinPitchNow = 0;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`GPU train shader failed: ${log}`);
    }
    return shader;
  };

  const uploadTexture = (width, height, array) => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, array);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  };

  const grow = (needed) => {
    if (needed <= capacity) return;
    capacity = Math.max(needed, Math.max(256, capacity * 2));
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * INSTANCE_STRIDE * 4, gl.DYNAMIC_DRAW);
  };

  const initGL = () => {
    const vertex = compile(gl.VERTEX_SHADER, vertexShader(prepared.maxStops));
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`GPU train program failed: ${gl.getProgramInfoLog(program)}`);
    }

    uniforms = {
      projection: gl.getUniformLocation(program, 'uProjection'),
      center: gl.getUniformLocation(program, 'uCenter'),
      viewport: gl.getUniformLocation(program, 'uViewport'),
      unitsPerPixel: gl.getUniformLocation(program, 'uUnitsPerPixel'),
      scale: gl.getUniformLocation(program, 'uScale'),
      sinPitch: gl.getUniformLocation(program, 'uSinPitch'),
      hull: gl.getUniformLocation(program, 'uHull'),
      flat: gl.getUniformLocation(program, 'uFlat'),
      time: gl.getUniformLocation(program, 'uTime'),
      fade: gl.getUniformLocation(program, 'uFade'),
      ramp: gl.getUniformLocation(program, 'uRamp'),
      rampShare: gl.getUniformLocation(program, 'uRampShare'),
      rampFrom: gl.getUniformLocation(program, 'uRampFrom'),
      rampShareFrom: gl.getUniformLocation(program, 'uRampShareFrom'),
      rampSwitchAt: gl.getUniformLocation(program, 'uRampSwitchAt'),
      solid: gl.getUniformLocation(program, 'uSolid'),
      reveal: gl.getUniformLocation(program, 'uReveal'),
      atlasWidth: gl.getUniformLocation(program, 'uAtlasWidth'),
      atlas: gl.getUniformLocation(program, 'uAtlas'),
      pathMeta: gl.getUniformLocation(program, 'uPathMeta'),
      profiles: gl.getUniformLocation(program, 'uProfiles'),
    };

    const started = performance.now();
    atlasTexture = uploadTexture(prepared.atlasWidth, prepared.atlasRows, prepared.atlas);
    metaTexture = uploadTexture(prepared.poolCount, 1, prepared.pools);
    profileTexture = uploadTexture(prepared.profileWidth, prepared.profileHeight, prepared.profiles);
    uploadMs = performance.now() - started;

    meshBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, CAR_VERTICES, gl.STATIC_DRAW);

    instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    capacity = 1024;
    gl.bufferData(gl.ARRAY_BUFFER, capacity * INSTANCE_STRIDE * 4, gl.DYNAMIC_DRAW);

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    // Bound while the VAO is bound so the element buffer is part of its state.
    indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, CAR_INDICES, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
    const meshStride = 9 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, meshStride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, meshStride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, meshStride, 24);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const stride = INSTANCE_STRIDE * 4;
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(5, 1);

    gl.bindVertexArray(null);

    // Samplers, and the uniforms that never change, are set once. Nothing else
    // draws into this context, so their state survives every frame.
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.uniform1i(uniforms.atlas, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, metaTexture);
    gl.uniform1i(uniforms.pathMeta, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, profileTexture);
    gl.uniform1i(uniforms.profiles, 2);
    gl.uniform1f(uniforms.atlasWidth, prepared.atlasWidth);
    gl.uniform1f(uniforms.solid, SOLID ? 1 : 0);

    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // The cars are real solids, so the depth buffer does the hidden-surface work
    // and no face culling is needed.
    gl.disable(gl.CULL_FACE);
    // Flat cel tones have no gradient to dither; skipping it saves fill rate.
    gl.disable(gl.DITHER);

    dirty = true;
  };

  // The overlay must track the map's camera exactly: read the four corners of
  // a 400 px square around the map centre from the public project(), then fit
  // the homography. Only recomputed when the camera or canvas size changes.
  const updateCamera = () => {
    let resized = false;
    if (canvas.width !== mapCanvas.width || canvas.height !== mapCanvas.height) {
      canvas.width = mapCanvas.width;
      canvas.height = mapCanvas.height;
      measure();
      resized = true;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);

    const center = map.getCenter();
    const zoom = map.getZoom();
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    if (
      !resized &&
      center.lng === camLng &&
      center.lat === camLat &&
      zoom === camZoom &&
      bearing === camBearing &&
      pitch === camPitch &&
      cssWidth === camCssWidth &&
      cssHeight === camCssHeight
    ) {
      return;
    }
    camLng = center.lng;
    camLat = center.lat;
    camZoom = zoom;
    camBearing = bearing;
    camPitch = pitch;
    camCssWidth = cssWidth;
    camCssHeight = cssHeight;

    unitsPerPixel = 1 / (512 * Math.pow(2, zoom));
    const t = Math.min(1, Math.max(0, (zoom - 10) / 7.5));
    zoomScale = 0.34 + t * 0.76;
    sinPitchNow = Math.sin((pitch * Math.PI) / 180);

    centerX = (center.lng + 180) / 360 - ORIGIN_X;
    centerY = localY(center.lat);
    const step = 200 * unitsPerPixel;
    const src = [
      [-step, -step],
      [step, -step],
      [-step, step],
      [step, step],
    ];
    const dst = src.map(([ox, oy]) => {
      const lng = (centerX + ox + ORIGIN_X) * 360 - 180;
      const lat = latFromMercatorY(centerY + oy + ORIGIN_Y);
      const point = map.project([lng, lat]);
      return [point.x, point.y];
    });
    solveHomography(src, dst, homography);
  };

  const draw = () => {
    if (!gl || !program || gl.isContextLost()) return;
    updateCamera();
    // A masked depth buffer (depthMask left false by a flat or SOLID frame) makes
    // the depth clear a no-op, so a tilted frame would then test against stale
    // depth. Unmask just for the clear; the outline pass re-masks below.
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!count || !data) return;

    grow(count);
    gl.useProgram(program);
    if (dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * INSTANCE_STRIDE));
      dirty = false;
    }

    gl.uniformMatrix3fv(uniforms.projection, false, homography);
    gl.uniform2f(uniforms.center, centerX, centerY);
    gl.uniform2f(uniforms.viewport, cssWidth, cssHeight);
    gl.uniform1f(uniforms.scale, zoomScale);
    gl.uniform1f(uniforms.unitsPerPixel, unitsPerPixel);
    gl.uniform1f(uniforms.sinPitch, sinPitchNow);
    gl.uniform1f(uniforms.time, seconds);
    gl.uniform1f(uniforms.fade, fadeSeconds);
    gl.uniform1f(uniforms.ramp, rampSeconds);
    gl.uniform1f(uniforms.rampShare, rampShare);
    gl.uniform1f(uniforms.rampFrom, rampFrom);
    gl.uniform1f(uniforms.rampShareFrom, rampShareFrom);
    gl.uniform1f(uniforms.rampSwitchAt, rampSwitchAt);
    gl.uniform1f(uniforms.reveal, reveal);

    // The outline shell is drawn against the body's depth: only the rim that
    // the body did not cover survives.
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.bindVertexArray(vao);
    // The model only earns its keep once the camera is tilted. Level, the flat
    // icon is the same drawing for a fraction of the fragments and lines up
    // exactly with the model's footprint, so the switch at 5 deg is invisible.
    const tilted = camPitch > 5;
    if (SOLID) {
      gl.uniform1f(uniforms.flat, 0);
      gl.uniform1f(uniforms.hull, 0);
      gl.drawElementsInstanced(gl.TRIANGLES, CAR_MESH.count, gl.UNSIGNED_SHORT, CAR_INDEX_OFFSET, count);
    } else if (!tilted) {
      gl.uniform1f(uniforms.flat, 1);
      gl.uniform1f(uniforms.hull, 0);
      gl.drawElementsInstanced(gl.TRIANGLES, FLAT_QUAD.count, gl.UNSIGNED_SHORT, 0, count);
    } else {
      // The black shell first, then the solid: the body paints over all of the
      // shell except its thin rim, and depth settles which of the car's own
      // faces are visible. Below roughly zoom 11.5 that rim is thinner than a
      // pixel, so the whole second pass would draw nothing new.
      if (zoomScale * CAR_OUTLINE >= 0.9) {
        gl.uniform1f(uniforms.flat, 0);
        gl.uniform1f(uniforms.hull, 1);
        gl.drawElementsInstanced(
          gl.TRIANGLES,
          CAR_MESH.count,
          gl.UNSIGNED_SHORT,
          CAR_INDEX_OFFSET,
          count,
        );
      }

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.uniform1f(uniforms.flat, 0);
      gl.uniform1f(uniforms.hull, 0);
      gl.drawElementsInstanced(
        gl.TRIANGLES,
        CAR_MESH.count,
        gl.UNSIGNED_SHORT,
        CAR_INDEX_OFFSET,
        count,
      );
      gl.disable(gl.DEPTH_TEST);
    }
    gl.bindVertexArray(null);
  };

  // Draw straight from the event, never deferred to a later frame. MapLibre
  // updates the transform and paints inside its own animation frame, so a draw
  // queued from these listeners lands a frame late: the basemap shows the new
  // bearing while the trains still show the old one, which reads as the cars
  // sliding off their lines while the map rotates. A second draw in the same
  // frame only costs the clear plus the (already resident) instance draw.
  const redraw = () => draw();
  for (const event of ['move', 'resize']) map.on(event, redraw);

  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  if (resizeObserver) resizeObserver.observe(mapCanvas);
  else window.addEventListener('resize', measure);

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    program = vao = meshBuffer = indexBuffer = instanceBuffer = null;
    atlasTexture = metaTexture = profileTexture = null;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    gl = canvas.getContext('webgl2', CONTEXT_OPTIONS);
    initGL();
    draw();
  });

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    for (const event of ['move', 'resize']) map.off(event, redraw);
    if (resizeObserver) resizeObserver.disconnect();
    else window.removeEventListener('resize', measure);
    canvas.remove();
    if (gl && !gl.isContextLost()) {
      if (program) gl.deleteProgram(program);
      if (meshBuffer) gl.deleteBuffer(meshBuffer);
      if (indexBuffer) gl.deleteBuffer(indexBuffer);
      if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
      if (atlasTexture) gl.deleteTexture(atlasTexture);
      if (metaTexture) gl.deleteTexture(metaTexture);
      if (profileTexture) gl.deleteTexture(profileTexture);
      if (vao) gl.deleteVertexArray(vao);
    }
    program = vao = meshBuffer = indexBuffer = instanceBuffer = null;
    atlasTexture = metaTexture = profileTexture = null;
  };
  map.once('remove', remove);

  initGL();

  return {
    canvas,
    draw,
    remove,
    get gl() {
      return gl;
    },
    setInstances(nextData, nextCount) {
      data = nextData;
      count = nextCount;
      dirty = true;
    },
    setTime(nextSeconds, nextFade = FADE, ease = null) {
      seconds = nextSeconds;
      fadeSeconds = nextFade;
      if (!ease) return;
      rampSeconds = ease.ramp;
      rampShare = ease.share;
      rampFrom = ease.fromRamp;
      rampShareFrom = ease.fromShare;
      rampSwitchAt = ease.switchAt;
    },
    setReveal(nextReveal) {
      reveal = nextReveal;
    },
    getDebug() {
      return {
        count,
        seconds,
        fadeSeconds,
        rampSeconds,
        rampShare,
        rampFrom,
        rampShareFrom,
        rampSwitchAt,
        uploadMs,
        canvas: { width: canvas.width, height: canvas.height, cssWidth, cssHeight },
        camera: { lng: camLng, lat: camLat, zoom: camZoom, bearing: camBearing, pitch: camPitch },
        homography: Array.from(homography),
        center: [centerX, centerY],
        atlas: { width: prepared.atlasWidth, height: prepared.atlasRows, vertices: prepared.vertexCount },
        pools: prepared.poolCount,
        profiles: {
          width: prepared.profileWidth,
          height: prepared.profileHeight,
          rows: prepared.profileRows,
          maxStops: prepared.maxStops,
        },
        maxInstances: capacity,
        handovers: prepared.handovers,
      };
    },
  };
}
