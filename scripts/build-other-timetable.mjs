#!/usr/bin/env node
/**
 * Appends the Changi Airport Skytrain and Sentosa Express schedules to the
 * LTA-built timetable.
 *
 * These operators do not publish GTFS or trip-level timetables. Only their
 * service hours and frequency bands are published, so the trips are generated
 * at a fixed headway inside those bands. Everything else (line colour, route
 * geometry, station order, terminus names, travel distance) is derived from
 * src/sg-rail-other.geo.json.
 *
 * Run after scripts/download-gtfs.mjs; `npm run gtfs` chains both.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  decodeInts,
  encodeCoords,
  encodeDeltas,
  encodeInts,
  encodeProfile,
} from '../src/gtfs-codec.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TIMETABLE_FILE = path.join(ROOT, 'src', 'gtfs-trains.json');
const OTHER_GEOJSON_FILE = path.join(ROOT, 'src', 'sg-rail-other.geo.json');

// Published operating data. Each entry names the page the numbers come from;
// keep it that way rather than scattering timings through the builder.
//
// Changi: the official transfer page lists 05:00–02:00. Land Transport Guru
// lists 05:00–02:30 and a 1–4 minute interval; the official page wins on the
// closing time, and 4 minutes sits inside the published frequency range.
//
// Sentosa: the official Sentosa page and SGTrains both list first/last trains
// at 07:00/00:00. Published frequencies vary between 3 and 8 minutes; 4
// minutes for the day and 6 minutes late evening stay inside that range.
const SCHEDULES = {
  'changi-skytrain': {
    sources: [
      'https://www.changiairport.com/en/at-changi/transport-and-directions/transferring-between-terminals-jewel.html',
      'https://landtransportguru.net/train/changi-airport-skytrain',
      'https://www.sgtrains.com/network-cga.html',
    ],
    windows: [[5 * 3600, 24 * 3600 + 2 * 3600, 4 * 60]],
    endToEndSeconds: 4 * 60,
    includeEnd: false,
  },
  'sentosa-express': {
    sources: [
      'https://www.sentosa.com.sg/en/getting-around',
      'https://www.sgtrains.com/network-se.html',
      'https://www.sgtrains.com/guide-traintiming?station=VivoCity',
      'https://www.sgtrains.com/guide-traintiming?station=Resorts%2BWorld',
      'https://www.sgtrains.com/guide-traintiming?station=Imbiah',
      'https://www.sgtrains.com/guide-traintiming?station=Beach',
      'https://landtransportguru.net/vivocity-station',
      'https://landtransportguru.net/beach-station',
    ],
    windows: [
      [7 * 3600, 22 * 3600, 4 * 60],
      [22 * 3600, 24 * 3600, 6 * 60],
    ],
    // Station departure offsets from the first train at each terminus, taken
    // from the per-station SGTrains pages above (VivoCity 07:00, Resorts World
    // 07:03, Imbiah 07:06, Beach 07:08; reverse Beach 07:00, Imbiah 07:02,
    // Resorts World 07:05, VivoCity 07:08). This gives the published 8-minute
    // end-to-end run instead of spreading 8 minutes evenly over the geometry.
    offsets: {
      forward: [0, 3 * 60, 6 * 60, 8 * 60],
      reverse: [0, 2 * 60, 5 * 60, 8 * 60],
    },
    includeEnd: true,
  },
};

// The GeoJSON names its line colours with CSS colour keywords; the packed
// timetable and the renderer need hex.
const COLOR_HEX = {
  deeppink: '#ff1493',
  gray: '#748477',
};

// Keep in sync with the map layers in src/index.js: these networks only appear
// once the MRT/LRT Chinese/Tamil station labels do. The train overlay reads this
// value to hide their trains at lower zooms too.
const OTHER_MIN_ZOOM = 13;

// A station farther than this from a route's track is not served by it. The
// curated station points sit within ~20 m of their line, so this only filters
// out stations from other guideways.
const SNAP_METERS = 80;

const RAD = Math.PI / 180;
const round = (value) => Math.round(value * 1e5) / 1e5;
const distance = (a, b) => {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const lat = ((a[1] + b[1]) / 2) * RAD;
  return Math.hypot(dLat, dLon * Math.cos(lat)) * 6371000;
};

// Nearest point on a polyline, plus the distance along the line to it.
function projectOnLine(coords, point) {
  let along = 0;
  let best = null;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    let t = length2 ? ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2 : 0;
    t = Math.max(0, Math.min(1, t));
    const projected = [a[0] + dx * t, a[1] + dy * t];
    const d = distance(projected, point);
    const segment = distance(a, b);
    if (!best || d < best.distance) {
      best = { distance: d, along: along + segment * t, point: projected, segment: i - 1, t };
    }
    along += segment;
  }
  return best;
}

// Insert the station projections into the track so every stop lands on a
// vertex of the encoded polyline.
function insertStops(coords, stops) {
  const bySegment = Array.from({ length: coords.length - 1 }, () => []);
  for (const stop of stops) bySegment[stop.segment].push(stop);
  for (const list of bySegment) list.sort((a, b) => a.t - b.t);

  const out = [];
  const stopIndices = [];
  const push = (point) => {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 1e-9 && Math.abs(last[1] - point[1]) < 1e-9) return;
    out.push(point);
  };

  push(coords[0]);
  for (let i = 0; i < coords.length - 1; i++) {
    for (const stop of bySegment[i]) {
      push(stop.point);
      stopIndices.push(out.length - 1);
    }
    push(coords[i + 1]);
  }
  return { coords: out, stopIndices };
}

function stopDistances(coords, stopIndices) {
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) {
    cumulative.push(cumulative[i - 1] + distance(coords[i - 1], coords[i]));
  }
  return stopIndices.map((index) => Math.round(cumulative[index]));
}

function startsFor(schedule) {
  const starts = [];
  for (const [from, to, headway] of schedule.windows) {
    for (let t = from; t < to; t += headway) starts.push(t);
    if (schedule.includeEnd && starts[starts.length - 1] < to) starts.push(to);
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

function displayName(network) {
  return network
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Short label for shared-colour count pills, taken from the common prefix of
// the route names in the GeoJSON. Changi's routes all start with "Skytrain".
function routeCode(routes) {
  const words = routes.map((route) => route.properties.name.split(/\s+/));
  const prefix = [];
  for (let i = 0; ; i++) {
    const word = words[0][i];
    if (!word || words.some((other) => other[i] !== word)) break;
    prefix.push(word);
  }
  return prefix.join(' ');
}

function clockLabel(seconds) {
  const total = Math.round(seconds) % (24 * 60 * 60);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const suffix = hours < 12 ? 'am' : 'pm';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return minutes
    ? `${hour12}:${String(minutes).padStart(2, '0')}${suffix}`
    : `${hour12}${suffix}`;
}

function scheduleNote(schedule) {
  const first = Math.min(...schedule.windows.map(([from]) => from));
  const last = Math.max(...schedule.windows.map(([, to]) => to));
  const minutes = [
    ...new Set(schedule.windows.map(([, , headway]) => headway / 60)),
  ].sort((a, b) => a - b);
  const frequency =
    minutes.length > 1 ? `${minutes[0]}–${minutes[minutes.length - 1]} min` : `${minutes[0]} min`;
  return (
    `* Simulated timetable: operating hours ` +
    `${clockLabel(first)}–${clockLabel(last)}, every ${frequency}.`
  );
}

const timetable = JSON.parse(await fs.readFile(TIMETABLE_FILE, 'utf8'));
const geo = JSON.parse(await fs.readFile(OTHER_GEOJSON_FILE, 'utf8'));

const stations = geo.features.filter((feature) => feature.properties.stop_type === 'station');
const routes = geo.features.filter((feature) => feature.geometry.type === 'LineString');

const networks = new Map();
for (const feature of routes) {
  const network = feature.properties.network;
  if (!networks.has(network)) networks.set(network, { network, routes: [], stations: [] });
  networks.get(network).routes.push(feature);
}
for (const station of stations) {
  const network = station.properties.network;
  if (networks.has(network)) networks.get(network).stations.push(station);
}

const networkNames = [...networks.keys()].sort();
for (const network of networkNames) {
  if (timetable.lines[displayName(network)]) {
    throw new Error(
      `${displayName(network)} is already in ${path.basename(TIMETABLE_FILE)}. ` +
        'Run scripts/download-gtfs.mjs first, then this script.',
    );
  }
}

const oldServiceCount = Object.keys(timetable.services).length;
const serviceIndex = new Map(
  networkNames.map((network, index) => [network, oldServiceCount + index]),
);
const serviceNames = networkNames.map((network) => `${network}-daily`);
for (const [index, id] of serviceNames.entries()) {
  timetable.services[id] = {
    i: oldServiceCount + index,
    days: [1, 1, 1, 1, 1, 1, 1],
    start: '19700101',
    end: '20991231',
    exceptions: {},
  };
}
const newServiceCount = oldServiceCount + networkNames.length;

// Existing trip codes pack profileIndex * serviceCount + serviceIndex, so
// adding services invalidates every old code. Re-encode them once.
for (const line of Object.values(timetable.lines)) {
  for (const packed of line.paths) {
    const codes = decodeInts(packed.tp);
    packed.tp = encodeInts(
      codes.map(
        (code) =>
          Math.floor(code / oldServiceCount) * newServiceCount + (code % oldServiceCount),
      ),
    );
  }
}

const otherStations = [...stations].sort((a, b) =>
  a.properties.station_codes.localeCompare(b.properties.station_codes),
);
for (const station of otherStations) {
  const code = station.properties.station_codes;
  if (!timetable.stations.includes(code)) timetable.stations.push(code);
}
const stationIndex = new Map(timetable.stations.map((code, index) => [code, index]));

const headsigns = new Set();
const prepared = [];
for (const network of networkNames) {
  const group = networks.get(network);
  const schedule = SCHEDULES[network];
  if (!schedule) throw new Error(`Missing published schedule for ${network}`);

  const paths = [];
  for (const route of group.routes) {
    const stops = group.stations
      .map((station) => ({
        station,
        ...projectOnLine(route.geometry.coordinates, station.geometry.coordinates),
      }))
      .filter((stop) => stop.distance <= SNAP_METERS)
      .sort((a, b) => a.along - b.along);

    const unique = [];
    for (const stop of stops) {
      if (!unique.some((other) => other.station === stop.station)) unique.push(stop);
    }
    if (unique.length < 2) continue;

    const forward = insertStops(route.geometry.coordinates, unique);
    const forwardCoords = forward.coords.map(([lng, lat]) => [round(lng), round(lat)]);
    const forwardStops = stopDistances(forwardCoords, forward.stopIndices);

    const reverseStops = [...unique].reverse();
    const reverseCoords = [...forwardCoords].reverse();
    const reverseIndices = forward.stopIndices
      .map((index) => forwardCoords.length - 1 - index)
      .reverse();
    const reverseDistances = stopDistances(reverseCoords, reverseIndices);

    paths.push(
      {
        direction: 'forward',
        servicePattern: route.properties.service_pattern,
        stops: unique,
        coords: forwardCoords,
        distances: forwardStops,
      },
      {
        direction: 'reverse',
        servicePattern: route.properties.service_pattern,
        stops: reverseStops,
        coords: reverseCoords,
        distances: reverseDistances,
      },
    );
  }

  const reference = Math.max(...paths.map((entry) => entry.distances.at(-1)));
  const allStarts = startsFor(schedule);

  for (const entry of paths) {
    // A single-lane shuttle cannot run both directions at once. Alternate
    // them on consecutive slots: forward at 0, reverse at one headway later,
    // forward at two headways, and so on. A bypass shuttle has a passing loop,
    // so both directions keep the published interval.
    const starts =
      entry.servicePattern === 'single_lane_shuttle'
        ? allStarts.filter((_, i) => i % 2 === (entry.direction === 'forward' ? 0 : 1))
        : allStarts;
    const length = entry.distances.at(-1);
    const offsets = schedule.offsets?.[entry.direction];
    let legSeconds;
    if (offsets && offsets.length === entry.distances.length) {
      legSeconds = offsets.slice(1).map((value, i) => value - offsets[i]);
    } else {
      const totalSeconds = Math.max(
        1,
        Math.round((schedule.endToEndSeconds * length) / reference),
      );
      const legs = entry.distances.slice(1).map((value, i) => value - entry.distances[i]);
      const totalDistance = legs.reduce((sum, value) => sum + value, 0) || 1;
      legSeconds = legs.map((leg) => Math.max(1, Math.round((totalSeconds * leg) / totalDistance)));
      // Absorb rounding into the final leg so the profile lasts exactly as long
      // as the published end-to-end time.
      legSeconds[legSeconds.length - 1] +=
        totalSeconds - legSeconds.reduce((sum, value) => sum + value, 0);
    }

    const profile = [[0, 0]];
    let time = 0;
    for (const seconds of legSeconds) {
      time += seconds;
      profile.push([time, time]);
    }

    const stopDeltas = entry.distances.map((value, i) => (i ? value - entry.distances[i - 1] : value));
    const stationCodes = entry.stops.map((stop) => stop.station.properties.station_codes);
    const terminus = entry.stops[entry.stops.length - 1].station.properties.name;
    headsigns.add(terminus);

    prepared.push({
      network,
      coords: entry.coords,
      path: {
        s: encodeInts(stopDeltas),
        st: encodeInts(
          stationCodes.map((code, i) =>
            i ? stationIndex.get(code) - stationIndex.get(stationCodes[i - 1]) : stationIndex.get(code),
          ),
        ),
        h: terminus,
        p: [encodeProfile(profile)],
        t: encodeInts(starts.map((start, i) => (i ? start - starts[i - 1] : start))),
        tp: encodeInts(starts.map(() => serviceIndex.get(network))),
      },
    });
  }
}

for (const terminus of [...headsigns].sort()) {
  if (!timetable.headsigns.includes(terminus)) timetable.headsigns.push(terminus);
}
const headsignIndex = new Map(timetable.headsigns.map((name, index) => [name, index]));

let order = Math.max(0, ...Object.values(timetable.lines).map((line) => line.order ?? 0));
const lines = new Map();
for (const network of networkNames) {
  const group = networks.get(network);
  const colorName =
    group.routes[0].properties.line_color || group.stations[0].properties.station_colors;
  const name = displayName(network);
  const line = {
    name,
    code: routeCode(group.routes),
    order: ++order,
    color: COLOR_HEX[colorName] || COLOR_HEX.gray,
    minzoom: OTHER_MIN_ZOOM,
    // The sidebar swaps its "based on timetable" note for this copy because
    // these trips are generated from hours and frequency, not a GTFS feed.
    simulated: true,
    note: scheduleNote(SCHEDULES[network]),
    verts: '',
    paths: [],
  };
  timetable.lines[name] = line;
  lines.set(network, line);
}

const vertexTables = new Map(
  networkNames.map((network) => [network, { coords: [], indices: new Map() }]),
);
for (const entry of prepared) {
  const line = lines.get(entry.network);
  const vertices = vertexTables.get(entry.network);
  const coordIndices = entry.coords.map(([lng, lat]) => {
    const key = `${lng},${lat}`;
    let index = vertices.indices.get(key);
    if (index === undefined) {
      index = vertices.coords.length;
      vertices.indices.set(key, index);
      vertices.coords.push([lng, lat]);
    }
    return index;
  });
  line.paths.push({
    ci: encodeDeltas(coordIndices),
    ...entry.path,
    h: headsignIndex.get(entry.path.h),
  });
}
for (const [network, vertices] of vertexTables) {
  lines.get(network).verts = encodeCoords(vertices.coords);
}

// Keep the emitted line order stable.
timetable.lines = Object.fromEntries(
  Object.entries(timetable.lines).sort((a, b) => (a[1].order ?? 99) - (b[1].order ?? 99)),
);

const json = JSON.stringify(timetable, null, 2) + '\n';
await fs.writeFile(TIMETABLE_FILE, json);
console.log(
  `Appended ${prepared.length} paths for ${networkNames.map(displayName).join(', ')} to ${path.basename(TIMETABLE_FILE)}`,
);