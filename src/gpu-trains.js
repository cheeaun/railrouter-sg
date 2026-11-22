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
// Texels per atlas row. 4096 keeps every mobile GPU comfortably inside
// MAX_TEXTURE_SIZE while still giving us ~74 rows for the whole network.
const ATLAS_WIDTH = 4096;
// Profile rows are flattened into a 1024-wide texture so the height stays well
// under even the smallest MAX_TEXTURE_SIZE.
const PROFILE_WIDTH = 1024;
// floats per active trip: poolId, start, duration, profileRow,
// stopCount, r, g, b
export const INSTANCE_STRIDE = 8;
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
  let row = 0;
  let vertexCount = 0;
  let firstStart = Infinity;
  let lastEnd = -Infinity;

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
      const pool = resample(decodeCoords(encoded));
      const offset = vertexCount;
      for (let i = 0; i < pool.count; i++) {
        atlas.push(pool.x[i], pool.y[i], pool.cx[i], pool.cy[i]);
      }
      vertexCount += pool.count;
      pools.push(offset, pool.count, pool.length, 0);
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
      }

      paths.push({
        key,
        poolId: poolBase + path.c,
        stopCount,
        starts,
        trips,
        maxDuration,
        rgb,
      });
    }
  }

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
    // Round inwards to whole minutes so both ends have a train on the move.
    window: {
      start: Math.ceil(firstStart / 60) * 60,
      end: Math.floor(lastEnd / 60) * 60,
    },
  };
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
      if (elapsed > trip.duration + fadeSeconds) continue;
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
      count++;
      if (counts && elapsed >= 0 && elapsed <= trip.duration) {
        counts[path.key] = (counts[path.key] || 0) + 1;
      }
    }
  }
  return count;
}

const vertexShader = (maxStops) => `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aTrip;  // poolId, start, duration, profileRow
layout(location = 2) in vec4 aTrip2; // stopCount, r, g, b

uniform mat3 uProjection;
uniform vec2 uCenter;
uniform vec2 uViewport;
uniform float uUnitsPerPixel;
uniform float uScale;
uniform vec2 uBaseSize;
uniform float uTime;
uniform float uFade;
uniform float uAtlasWidth;
uniform float uSolid;
uniform float uReveal;
uniform sampler2D uAtlas;
uniform sampler2D uPathMeta;
uniform sampler2D uProfiles;

out vec2 vLocal;
out vec3 vColor;
out float vAlpha;

const float SPACING = ${SPACING.toFixed(1)};
const int MAX_STOPS = ${maxStops};
const int PROFILE_W = ${PROFILE_WIDTH};

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
  float alpha = smoothstep(0.0, 1.0, enter) * (1.0 - smoothstep(0.0, 1.0, leave));
  alpha *= smoothstep(0.0, 1.0, uReveal);

  vLocal = vec2(0.0);
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
      float k = clamp((t - prevDeparture) / span, 0.0, 1.0);
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
    vLocal = vec2(0.0);
    vAlpha = 0.0;
    return;
  }

  vec2 local = aCorner * uBaseSize;
  vec2 rotated = vec2(local.x * dir.x - local.y * dir.y,
                      local.x * dir.y + local.y * dir.x);
  vec2 world = pos + rotated * uScale * grow * uUnitsPerPixel;
  // uProjection is a homography from local Mercator offsets (relative to
  // uCenter) to CSS pixels. Dividing by w handles pitch; the viewport size
  // converts CSS pixels to clip space.
  vec3 screen = uProjection * vec3(world - uCenter, 1.0);
  vec2 css = screen.xy / screen.z;
  gl_Position = vec4(css.x / uViewport.x * 2.0 - 1.0, 1.0 - css.y / uViewport.y * 2.0, 0.0, 1.0);

  vLocal = local;
  vAlpha = alpha;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vLocal;
in vec3 vColor;
in float vAlpha;
uniform float uSolid;
out vec4 outColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

void main() {
  const float W = 38.0;
  const float H = 16.0;
  const float R = 5.0;
  const float STROKE = 2.0;
  const float WIN_FROM_NOSE = 4.0;
  const float WIN_LEN = 6.0;
  const float WIN_THICK = 8.0;
  const float WIN_R = 2.0;

  vec2 p = vLocal;
  float aa = max(fwidth(p.x), 0.0001);

  float dOuter = sdRoundBox(p, vec2(W, H) * 0.5, R + STROKE * 0.5);
  float dInner = sdRoundBox(
    p,
    vec2(W - STROKE * 2.0, H - STROKE * 2.0) * 0.5,
    max(R - STROKE * 0.5, 0.5)
  );
  float outer = 1.0 - smoothstep(-aa, aa, dOuter);
  float inner = 1.0 - smoothstep(-aa, aa, dInner);

  vec2 winCenter = vec2(W * 0.5 - WIN_FROM_NOSE - WIN_LEN * 0.5, 0.0);
  float dWin = sdRoundBox(p - winCenter, vec2(WIN_LEN, WIN_THICK) * 0.5, WIN_R);
  float win = 1.0 - smoothstep(-aa, aa, dWin);

  vec3 color = mix(vec3(0.0667), vColor, inner);
  color = mix(color, vec3(0.0), win * inner);
  float alpha = outer * vAlpha;
  if (uSolid > 0.5) {
    outColor = vec4(vColor, 1.0);
    return;
  }
  outColor = vec4(color * alpha, alpha);
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
  depth: false,
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
  let quadBuffer = null;
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
  let reveal = 1;
  let uploadMs = 0;

  const homography = new Float32Array(9);
  let centerX = 0;
  let centerY = 0;
  let cssWidth = 1;
  let cssHeight = 1;
  let cameraKey = '';

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
      baseSize: gl.getUniformLocation(program, 'uBaseSize'),
      time: gl.getUniformLocation(program, 'uTime'),
      fade: gl.getUniformLocation(program, 'uFade'),
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

    quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
      gl.STATIC_DRAW,
    );

    instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    capacity = 1024;
    gl.bufferData(gl.ARRAY_BUFFER, capacity * INSTANCE_STRIDE * 4, gl.DYNAMIC_DRAW);

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const stride = INSTANCE_STRIDE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    dirty = true;
    cameraKey = '';
  };

  // The overlay must track the map's camera exactly: read the four corners of
  // a 400 px square around the map centre from the public project(), then fit
  // the homography. Only recomputed when the camera or canvas size changes.
  const updateCamera = () => {
    const mapCanvas = map.getCanvas();
    if (canvas.width !== mapCanvas.width || canvas.height !== mapCanvas.height) {
      canvas.width = mapCanvas.width;
      canvas.height = mapCanvas.height;
      cameraKey = '';
    }
    cssWidth = mapCanvas.clientWidth || 1;
    cssHeight = mapCanvas.clientHeight || 1;
    gl.viewport(0, 0, canvas.width, canvas.height);

    const center = map.getCenter();
    const zoom = map.getZoom();
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    const key = `${center.lng},${center.lat},${zoom},${bearing},${pitch},${cssWidth},${cssHeight},${canvas.width}`;
    if (key === cameraKey) return;
    cameraKey = key;

    centerX = (center.lng + 180) / 360 - ORIGIN_X;
    centerY = localY(center.lat);
    const step = 200 / (512 * Math.pow(2, zoom));
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
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!count || !data) return;

    grow(count);
    gl.useProgram(program);
    if (dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * INSTANCE_STRIDE));
      dirty = false;
    }

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

    const zoom = map.getZoom();
    const t = Math.min(1, Math.max(0, (zoom - 10) / 7.5));
    const scale = 0.34 + t * 0.76;

    gl.uniformMatrix3fv(uniforms.projection, false, homography);
    gl.uniform2f(uniforms.center, centerX, centerY);
    gl.uniform2f(uniforms.viewport, cssWidth, cssHeight);
    gl.uniform1f(uniforms.scale, scale);
    gl.uniform1f(uniforms.unitsPerPixel, 1 / (512 * Math.pow(2, zoom)));
    gl.uniform2f(uniforms.baseSize, 38, 16);
    gl.uniform1f(uniforms.time, seconds);
    gl.uniform1f(uniforms.fade, fadeSeconds);
    gl.uniform1f(uniforms.solid, SOLID ? 1 : 0);
    gl.uniform1f(uniforms.reveal, reveal);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  };

  const redraw = () => draw();
  for (const event of ['move', 'zoom', 'rotate', 'pitch', 'resize']) map.on(event, redraw);

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    program = vao = quadBuffer = instanceBuffer = null;
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
    for (const event of ['move', 'zoom', 'rotate', 'pitch', 'resize']) map.off(event, redraw);
    canvas.remove();
    if (gl && !gl.isContextLost()) {
      if (program) gl.deleteProgram(program);
      if (quadBuffer) gl.deleteBuffer(quadBuffer);
      if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
      if (atlasTexture) gl.deleteTexture(atlasTexture);
      if (metaTexture) gl.deleteTexture(metaTexture);
      if (profileTexture) gl.deleteTexture(profileTexture);
      if (vao) gl.deleteVertexArray(vao);
    }
    program = vao = quadBuffer = instanceBuffer = null;
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
    setTime(nextSeconds, nextFade = FADE) {
      seconds = nextSeconds;
      fadeSeconds = nextFade;
    },
    setReveal(nextReveal) {
      reveal = nextReveal;
    },
    getDebug() {
      return {
        count,
        seconds,
        fadeSeconds,
        uploadMs,
        canvas: { width: canvas.width, height: canvas.height, cssWidth, cssHeight },
        cameraKey,
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
      };
    },
  };
}
