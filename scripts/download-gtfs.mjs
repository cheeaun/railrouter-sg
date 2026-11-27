#!/usr/bin/env node
/**
 * Downloads the LTA DataMall GTFS Schedule (Train) feed, stores the raw ZIP in
 * data/, and builds src/gtfs-trains.json: the compact, browser-ready timetable
 * the app uses to animate scheduled trains on the rail lines.
 *
 * Usage:
 *   LTA_ACCOUNT_KEY=xxxx node scripts/download-gtfs.mjs
 *   GTFS_OFFLINE=1 node scripts/download-gtfs.mjs   # rebuild from data/gtfs-schedule.zip
 *
 * The account key can also live in scripts/config.json (git-ignored) as
 * { "accountKey": "xxxx" }. In CI, set the LTA_ACCOUNT_KEY secret.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { encodeCoords, encodeDeltas, encodeInts, encodeProfile } from '../src/gtfs-codec.mjs';
import { buildGraph, distance, implausibleLeg } from './rail-graph.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW_DIR = path.join(ROOT, 'data');
const RAW_ZIP = path.join(RAW_DIR, 'gtfs-schedule.zip');
const META_FILE = path.join(RAW_DIR, 'gtfs-meta.json');
const GEOJSON_FILE = path.join(ROOT, 'src', 'sg-rail.geo.json');
const OUT_FILE = path.join(ROOT, 'src', 'gtfs-trains.json');
const API_URL = 'https://datamall2.mytransport.sg/ltaodataservice/GTFSScheduleTrain';

const lineColors = {
  orangered: '#d42e12',
  mediumseagreen: '#009645',
  orange: '#fa9e0d',
  saddlebrown: '#9d5b25',
  darkmagenta: '#9900aa',
  darkslateblue: '#005ec4',
  gray: '#748477',
};

const lineNames = {
  NS: 'North South Line',
  EW: 'East West Line',
  CG: 'East West Line',
  NE: 'North East Line',
  CC: 'Circle Line',
  DT: 'Downtown Line',
  TE: 'Thomson-East Coast Line',
  BP: 'Bukit Panjang LRT',
};

async function accountKey() {
  if (process.env.LTA_ACCOUNT_KEY) return process.env.LTA_ACCOUNT_KEY.trim();
  try {
    const config = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts', 'config.json'), 'utf8'));
    if (config.accountKey) return config.accountKey;
  } catch {}
  throw new Error('Missing LTA account key. Set LTA_ACCOUNT_KEY or scripts/config.json {"accountKey": "..."}');
}

// ---------------------------------------------------------------- zip format
function readZip(buffer) {
  const eocd = (() => {
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new Error('Not a ZIP file');
  })();
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    files[name] = method === 0 ? data : zlib.inflateRawSync(data);
  }
  return files;
}

function parseCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  return rows.map((values) => Object.fromEntries(header.map((key, i) => [key, values[i] ?? ''])));
}

// ------------------------------------------------------------------ geometry

// A station can sit next to more than one arm of the track (loop junctions,
// parallel tracks). Consider every projection this far past the nearest one as
// a possible boarding point.
const CANDIDATE_MARGIN = 60;
// How far from the station we look for a place to stop when walking a leg.
const TARGET_MARGIN = 150;
// Let the route continue past the first candidate that comes within range, so
// it stops at the closest point on the arm it approached from instead of
// undershooting it. Must stay below the distance between separate arms of a
// loop.
const STOP_SLACK = 300;

// Project a point onto a single graph edge. Stations rarely sit exactly on a
// track vertex, so every station is represented by its projection onto an edge.
function projectOntoEdge(graph, a, b, point) {
  const p = graph.coords[a];
  const q = graph.coords[b];
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((point[0] - p[0]) * dx + (point[1] - p[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const projected = [p[0] + dx * t, p[1] + dy * t];
  return { distance: distance(projected, point), from: a, to: b, t, point: projected };
}

// Nearest point on the polyline.
function snap(graph, point, within = Infinity) {
  let best = null;
  for (let a = 0; a < graph.adjacency.length; a++) {
    for (const [b] of graph.adjacency[a]) {
      if (b < a) continue;
      const candidate = projectOntoEdge(graph, a, b, point);
      if (candidate.distance > within) continue;
      if (!best || candidate.distance < best.distance) best = candidate;
    }
  }
  return best;
}

// Every place along the track a train could board this station. A loop
// junction (or a station between parallel tracks) can put the same station
// next to two different arms, and the globally nearest arm is not always the
// one the service actually uses.
function snapCandidates(graph, point) {
  const nearest = snap(graph, point);
  if (!nearest) return [];
  const limit = nearest.distance + CANDIDATE_MARGIN;
  const candidates = [];
  for (let a = 0; a < graph.adjacency.length; a++) {
    for (const [b] of graph.adjacency[a]) {
      if (b < a) continue;
      const candidate = projectOntoEdge(graph, a, b, point);
      if (candidate.distance <= limit) candidates.push(candidate);
    }
  }
  return candidates.sort((x, y) => x.distance - y.distance);
}

// Dijkstra seeded from several nodes at once, remembering which seed each
// route came from so the leg can be drawn from the right boarding point.
function shortestPathsFromSeeds(graph, seeds) {
  const dist = new Array(graph.adjacency.length).fill(Infinity);
  const prev = new Array(graph.adjacency.length).fill(-1);
  const root = new Array(graph.adjacency.length).fill(-1);
  const queue = [];
  const done = new Array(graph.adjacency.length).fill(false);
  for (let i = 0; i < seeds.length; i++) {
    const { node, cost } = seeds[i];
    if (cost < dist[node]) {
      dist[node] = cost;
      prev[node] = -1;
      root[node] = i;
      queue.push([cost, node]);
    }
  }
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, u] = queue.shift();
    if (done[u]) continue;
    done[u] = true;
    for (const [v, w] of graph.adjacency[u]) {
      if (d + w < dist[v]) {
        dist[v] = d + w;
        prev[v] = u;
        root[v] = root[u];
        queue.push([dist[v], v]);
      }
    }
  }
  return { dist, prev, root };
}

const round = (value) => Math.round(value * 1e5) / 1e5;

// Train polylines are simplified to this perpendicular tolerance before
// encoding. The drawn track is the curated sg-rail.geo.json geometry, so this
// only affects train positions. 1m keeps trains within a pixel or two of the
// drawn line even at deep zoom (3m was visibly off at max zoom) for only ~2.5 KB
// more gzipped, since the added vertices compress well.
const SIMPLIFY_TOLERANCE = 1;

// The encoders live in src/gtfs-codec.mjs, shared with the runtime decoders.

// Walk from a station to the next one. Try boarding the current station from
// every nearby arm and keep the cheapest result; this is what lets a loop
// train leave Bukit Panjang towards Senja instead of going the long way round
// the whole loop. Of the equally plausible places to stop, pick the one
// closest to the station so the next leg does not start by doubling back.
function advance(graph, cursor, sourceCandidates, target) {
  const seeds = [];
  for (const source of sourceCandidates) {
    const transfer = distance(cursor.point, source.point);
    const length = distance(graph.coords[source.from], graph.coords[source.to]);
    seeds.push({ node: source.from, cost: transfer + source.t * length, source });
    seeds.push({ node: source.to, cost: transfer + (1 - source.t) * length, source });
  }
  const { dist, prev, root } = shortestPathsFromSeeds(graph, seeds);

  const nearest = snap(graph, target);
  if (!nearest) return { points: [cursor.point], snap: cursor, cost: 0 };
  const limit = nearest.distance + TARGET_MARGIN;

  const candidates = [];
  for (let a = 0; a < graph.adjacency.length; a++) {
    for (const [b] of graph.adjacency[a]) {
      if (b < a) continue;
      const projection = projectOntoEdge(graph, a, b, target);
      if (projection.distance > limit) continue;
      const length = distance(graph.coords[a], graph.coords[b]);
      let chosen = null;
      for (const [node, rest] of [
        [a, projection.t],
        [b, 1 - projection.t],
      ]) {
        const cost = dist[node] + rest * length;
        if (Number.isFinite(cost) && (!chosen || cost < chosen.cost)) chosen = { node, cost };
      }
      if (!chosen) continue;

      // Source and target on one edge: walking straight along it is shorter
      // than looping all the way round the graph and back.
      for (const source of sourceCandidates) {
        if (source.from !== a || source.to !== b) continue;
        const direct =
          distance(cursor.point, source.point) + Math.abs(projection.t - source.t) * length;
        if (direct < chosen.cost) chosen = { node: source.from, cost: direct, direct: source };
      }
      candidates.push({ ...projection, ...chosen });
    }
  }
  if (!candidates.length) {
    return { points: [cursor.point, nearest.point], snap: nearest, cost: nearest.distance };
  }

  const minCost = Math.min(...candidates.map((candidate) => candidate.cost));
  let best = null;
  for (const candidate of candidates) {
    if (candidate.cost > minCost + STOP_SLACK) continue;
    if (
      !best ||
      candidate.distance < best.distance - 1e-6 ||
      (Math.abs(candidate.distance - best.distance) <= 1e-6 && candidate.cost < best.cost)
    ) {
      best = candidate;
    }
  }

  if (best.direct) {
    return { points: [cursor.point, best.direct.point, best.point], snap: best, cost: best.cost };
  }

  const nodes = [];
  for (let u = best.node; u !== -1; u = prev[u]) nodes.push(u);
  nodes.reverse();
  const seed = seeds[root[nodes[0]]];
  const points = [
    cursor.point,
    seed.source.point,
    ...nodes.map((id) => graph.coords[id]),
    best.point,
  ];
  return { points, snap: best, cost: best.cost };
}

function buildPath(graph, stationPoints) {
  const points = [];
  const stopIndices = [];
  const push = (point) => {
    const last = points[points.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 1e-7 && Math.abs(last[1] - point[1]) < 1e-7) return;
    points.push(point);
  };

  const boarding = stationPoints.map((point) => snapCandidates(graph, point));
  let cursor = boarding[0][0];
  push(cursor.point);
  stopIndices.push(points.length - 1);

  for (let i = 1; i < stationPoints.length; i++) {
    const step = advance(graph, cursor, boarding[i - 1], stationPoints[i]);
    cursor = step.snap;
    for (const point of step.points) push(point);
    stopIndices.push(points.length - 1);
  }

  const shortest = stationPoints.reduce(
    (sum, point, i) => (i ? sum + distance(stationPoints[i - 1], point) : 0),
    0,
  );
  return { points, stopIndices, shortest };
}

// Perpendicular distance in metres from point p to segment a-b.
function perpendicular(p, a, b) {
  const lat = ((p[1] + a[1] + b[1]) / 3) * (Math.PI / 180);
  const k = Math.cos(lat);
  const ax = a[0] * k;
  const ay = a[1];
  const bx = b[0] * k;
  const by = b[1];
  const px = p[0] * k;
  const py = p[1];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy) * 6371000 * (Math.PI / 180);
}

// Douglas-Peucker, keeping every vertex whose index is in `keep` so stop
// positions are never moved. The train polyline only carries train positions
// (the drawn track comes from sg-rail.geo.json), so a sub-metre-simplified
// line is indistinguishable on screen while compressing far better.
function simplify(points, tolerance, keep) {
  const retained = new Uint8Array(points.length);
  retained[0] = retained[points.length - 1] = 1;
  for (const index of keep) retained[index] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end <= start + 1) continue;
    let worst = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicular(points[i], points[start], points[end]);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (worst > tolerance) {
      retained[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }

  const kept = [];
  const keptIndices = [];
  for (let i = 0; i < points.length; i++) {
    if (!retained[i]) continue;
    kept.push(points[i]);
    keptIndices.push(i);
  }
  return { kept, keptIndices };
}

// ----------------------------------------------------------------------- main
// GTFS_OFFLINE=1 rebuilds from the feed already cached in data/, which is
// handy when iterating on the builder without hitting DataMall.
let zipBuffer;
if (process.env.GTFS_OFFLINE === '1') {
  console.log(`Reading cached feed ${path.relative(ROOT, RAW_ZIP)}…`);
  zipBuffer = await fs.readFile(RAW_ZIP);
} else {
  const key = await accountKey();

  console.log('Fetching GTFS Schedule link…');
  const response = await fetch(API_URL, {
    headers: { AccountKey: key, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`GTFS Schedule link request failed: ${response.status}`);
  const payload = await response.json();
  const entry = payload.value && payload.value[0];
  if (!entry || !entry.link) throw new Error('No download link in GTFS Schedule response');

  console.log('Downloading feed…');
  const zipResponse = await fetch(entry.link);
  if (!zipResponse.ok) throw new Error(`Feed download failed: ${zipResponse.status}`);
  zipBuffer = Buffer.from(await zipResponse.arrayBuffer());

  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.writeFile(RAW_ZIP, zipBuffer);
  console.log(
    `Stored ${path.relative(ROOT, RAW_ZIP)} (${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB)`,
  );
}

const files = readZip(zipBuffer);
const csv = (name) => {
  const file = files[`gtfs/${name}`] || files[name] || files[Object.keys(files).find((f) => f.endsWith(`/${name}`))];
  if (!file) throw new Error(`Missing ${name} in feed`);
  return parseCsv(file);
};

const agencyRows = csv('agency.txt');
const routes = csv('routes.txt');
const trips = csv('trips.txt');
const stopTimes = csv('stop_times.txt');
const stops = csv('stops.txt');
const calendar = csv('calendar.txt');
const calendarDates = csv('calendar_dates.txt');
const feedInfo = csv('feed_info.txt')[0] || {};

console.log(
  `Feed: ${trips.length} trips, ${stopTimes.length} stop times, ${routes.length} routes, ${stops.length} stops`,
);

const geo = JSON.parse(await fs.readFile(GEOJSON_FILE, 'utf8'));
const stations = geo.features.filter((f) => f.properties.stop_type === 'station');
const lineFeatures = {};
for (const feature of geo.features) {
  if (feature.properties.name && !feature.properties.stop_type) {
    lineFeatures[feature.properties.name] = feature;
  }
}

const stationByCode = {};
for (const station of stations) {
  for (const code of station.properties.station_codes.split('-')) stationByCode[code] = station;
}

const stopById = Object.fromEntries(stops.map((stop) => [stop.stop_id, stop]));
const stationForStop = (stopId) => {
  const stop = stopById[stopId];
  if (!stop) return null;
  const candidates = [stop.stop_code, stop.parent_station, stopId.replace(/_[A-Z]$/, '')];
  for (const code of candidates) {
    if (code && stationByCode[code]) return stationByCode[code];
  }
  return null;
};

// Group trips into unique stop patterns, then into timing profiles.
const timesByTrip = new Map();
for (const row of stopTimes) {
  const list = timesByTrip.get(row.trip_id) || [];
  list.push(row);
  timesByTrip.set(row.trip_id, list);
}

const toSeconds = (value) => {
  const [h, m, s] = value.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

// Short code and display order for each line, used by the train-count pills.
const lineMeta = {
  'North South Line': { code: 'NS', order: 1 },
  'East West Line': { code: 'EW', order: 2 },
  'North East Line': { code: 'NE', order: 3 },
  'Circle Line': { code: 'CC', order: 4 },
  'Downtown Line': { code: 'DT', order: 5 },
  'Thomson-East Coast Line': { code: 'TE', order: 6 },
  'Bukit Panjang LRT': { code: 'BP', order: 7 },
  'Sengkang LRT (East Loop)': { code: 'SE', order: 8 },
  'Sengkang LRT (West Loop)': { code: 'SW', order: 9 },
  'Punggol LRT (East Loop)': { code: 'PE', order: 10 },
  'Punggol LRT (West Loop)': { code: 'PW', order: 11 },
};

const lineFor = (shortName, stopIds) => {
  if (lineNames[shortName]) return lineNames[shortName];
  const codes = stopIds.map((id) => (stopById[id]?.stop_code || id).replace(/_.*$/, ''));
  const east = codes.some((code) => /^(SE|PE)\d/.test(code));
  if (shortName === 'SK') return east ? 'Sengkang LRT (East Loop)' : 'Sengkang LRT (West Loop)';
  if (shortName === 'PG') return east ? 'Punggol LRT (East Loop)' : 'Punggol LRT (West Loop)';
  return null;
};

const routeById = Object.fromEntries(routes.map((route) => [route.route_id, route]));
const graphs = {};
const graphFor = (name) => {
  if (!graphs[name]) {
    if (!lineFeatures[name]) throw new Error(`No rail geometry for ${name}`);
    graphs[name] = buildGraph(lineFeatures[name]);
  }
  return graphs[name];
};

// Service ids are assigned a fixed numeric index, sorted so the assignment
// never depends on feed ordering. The index is written into each service and
// the runtime reads it back, so JSON key reordering can never silently remap
// trips onto the wrong calendar.
// Every trip's service_id must be declared in calendar.txt or
// calendar_dates.txt; one that is not is a feed error caught below.
const serviceIds = [
  ...new Set([...calendar.map((row) => row.service_id), ...calendarDates.map((row) => row.service_id)]),
]
  .filter(Boolean)
  .sort();
const serviceIndex = new Map(serviceIds.map((id, index) => [id, index]));
const services = {};
for (const id of serviceIds) {
  const cal = calendar.find((c) => c.service_id === id);
  services[id] = cal
    ? {
        i: serviceIndex.get(id),
        days: [
          Number(cal.sunday),
          Number(cal.monday),
          Number(cal.tuesday),
          Number(cal.wednesday),
          Number(cal.thursday),
          Number(cal.friday),
          Number(cal.saturday),
        ],
        start: cal.start_date,
        end: cal.end_date,
        exceptions: {},
      }
    : { i: serviceIndex.get(id), days: [0, 0, 0, 0, 0, 0, 0], start: '19700101', end: '19700101', exceptions: {} };
}
for (const row of calendarDates) {
  services[row.service_id].exceptions[row.date] = Number(row.exception_type);
}

const patterns = new Map();
for (const trip of trips) {
  const rows = timesByTrip.get(trip.trip_id);
  if (!rows || !rows.length) continue;
  rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  const stopIds = rows.map((row) => row.stop_id);
  const key = `${trip.route_id}|${stopIds.join('>')}`;
  let pattern = patterns.get(key);
  if (!pattern) {
    pattern = { routeId: trip.route_id, stopIds, profiles: new Map(), trips: [], headsigns: new Map() };
    patterns.set(key, pattern);
  }
  // One stop pattern can carry more than one headsign in the feed (the Circle
  // Line loop mixes "Clockwise" with a terminus name). Tally them and keep the
  // most common, so the label is stable and deterministic.
  pattern.headsigns.set(trip.trip_headsign, (pattern.headsigns.get(trip.trip_headsign) || 0) + 1);
  const start = toSeconds(rows[0].departure_time);
  const profile = rows.map((row) => [toSeconds(row.arrival_time) - start, toSeconds(row.departure_time) - start]);
  const profileKey = profile.map((p) => p.join(':')).join(',');
  if (!pattern.profiles.has(profileKey)) pattern.profiles.set(profileKey, pattern.profiles.size);
  const service = serviceIndex.get(trip.service_id);
  if (service === undefined) {
    throw new Error(`Trip ${trip.trip_id} uses unknown service ${trip.service_id}`);
  }
  pattern.trips.push([start, pattern.profiles.get(profileKey), service]);
}

// A trip's headsign names the direction a rider actually cares about, which the
// terminus stop alone does not: northbound Thomson-East Coast trains terminate
// at several stations along the way (Woodlands South, Gardens by the Bay, …),
// yet they all head for Woodlands North. Grouping by headsign keeps one row per
// real direction instead of one per terminus.
const headsignFor = (pattern) =>
  [...pattern.headsigns.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

// Station identity for the sidebar's departure board. Paths only carry stop
// distances, which say nothing about which station a stop is, so the builder
// also emits a sorted station table (combined station_codes keys) and, per
// path, the station index at every stop. Sorted order keeps the output stable
// for an unchanged feed.
const stationKeys = [...new Set(stations.map((station) => station.properties.station_codes))].sort();
const stationIndex = new Map(stationKeys.map((key, index) => [key, index]));

// The distinct headsigns, sorted, as a table the per-path index points into.
// Sorted so an unchanged feed produces a byte-identical file.
const headsignKeys = [...new Set([...patterns.values()].map(headsignFor))].sort();
const headsignIndex = new Map(headsignKeys.map((key, index) => [key, index]));

const output = {
  // Deliberately no build timestamp: it changed on every run, so the CI job's
  // "commit only if something changed" guard never fired and each refresh
  // rewrote the whole 590 KB blob for a 24-character diff. Provenance lives in
  // data/gtfs-meta.json instead (git-ignored), and the commit date records when
  // the timetable last actually changed.
  agency: agencyRows.map((row) => row.agency_name).join(' / '),
  feed: { version: feedInfo.feed_version || '', start: feedInfo.feed_start_date || '', end: feedInfo.feed_end_date || '' },
  stations: stationKeys,
  headsigns: headsignKeys,
  services,
  lines: {},
};

let pathCount = 0;
let tripCount = 0;
// Per line, the distinct vertices every path on that line is built from. Paths
// store index runs into this table instead of repeating the coordinates, so the
// many Circle Line patterns (and both directions of every line) share one copy.
const vertexTablesByLine = {};
const serviceCount = serviceIndex.size;
for (const pattern of patterns.values()) {
  const route = routeById[pattern.routeId];
  if (!route) continue;
  const lineName = lineFor(route.route_short_name, pattern.stopIds);
  if (!lineName) continue;
  // Key lines by their display name, not the route short name: CG and EW are
  // both the East West Line and should share one entry, one colour and one
  // train count rather than appearing as two separate lines.
  const meta = lineMeta[lineName] || { code: '', order: 99 };
  const line = (output.lines[lineName] ??= {
    name: lineName,
    code: meta.code,
    order: meta.order,
    color: lineColors[lineFeatures[lineName].properties.line_color] || lineColors.gray,
    // Filled after every path on the line has been walked, so the table is
    // deterministic and contains each vertex once.
    verts: '',
    paths: [],
  });
  const vertices = (vertexTablesByLine[lineName] ??= { coords: [], indices: new Map() });

  const graph = graphFor(lineName);
  const stationPoints = [];
  const pathStations = [];
  const missing = [];
  for (const stopId of pattern.stopIds) {
    const station = stationForStop(stopId);
    if (!station) {
      missing.push(stopId);
      continue;
    }
    // Prefer the stop's own coordinates. An interchange like Tampines is one
    // merged station in sg-rail.geo.json, but its East West and Downtown
    // platforms are in separate buildings ~200m apart; snapping both lines to
    // the merged point drags the Downtown train away from its track.
    const stop = stopById[stopId];
    const lat = stop && Number(stop.stop_lat);
    const lng = stop && Number(stop.stop_lon);
    stationPoints.push(lat && lng ? [lng, lat] : station.geometry.coordinates);
    pathStations.push(stationIndex.get(station.properties.station_codes));
  }
  // A profile has one entry per stop in the trip, so it only lines up with the
  // track if every stop resolved. Skipping the pattern beats animating a train
  // whose positions drift off the end of its stop list.
  if (missing.length) {
    console.warn(`Skipping ${pattern.stopIds.join('>')}: unknown stops ${missing.join(', ')}`);
    continue;
  }
  if (stationPoints.length < 2) continue;

  const { points, stopIndices, shortest } = buildPath(graph, stationPoints);
  const { kept, keptIndices } = simplify(points, SIMPLIFY_TOLERANCE, stopIndices);
  const coords = kept.map(([lng, lat]) => [round(lng), round(lat)]);

  // Stop distances along the simplified polyline, so timed positions land on
  // the same vertices the train rides.
  const keptIndexAt = new Map(keptIndices.map((original, index) => [original, index]));
  let length = 0;
  const stopDistances = new Array(kept.length).fill(0);
  for (let i = 1; i < coords.length; i++) {
    length += distance(coords[i - 1], coords[i]);
    stopDistances[i] = length;
  }
  const stops = stopIndices.map((original) => Math.round(stopDistances[keptIndexAt.get(original)]));

  // A leg that wanders far beyond the straight line between its two stations
  // means the router took a detour: most often a loop whose geometry was not
  // joined, so it went the long way round. Fail instead of committing trains
  // that visibly run the wrong direction.
  for (let i = 1; i < stops.length; i++) {
    const leg = stops[i] - stops[i - 1];
    const straight = distance(stationPoints[i - 1], stationPoints[i]);
    if (implausibleLeg(leg, straight)) {
      throw new Error(
        `${lineName} ${pattern.stopIds[i - 1]}>${pattern.stopIds[i]} routed ${(leg / 1000).toFixed(1)}km for ${(straight / 1000).toFixed(1)}km between stops; check the line geometry closes its loop in sg-rail.geo.json`,
      );
    }
  }

  if (length > 2.5 * shortest) {
    console.warn(
      `  ${pattern.stopIds.join('>')}: ${(length / 1000).toFixed(1)}km of track for ${(shortest / 1000).toFixed(1)}km between stops`,
    );
  }
  const profiles = [...pattern.profiles.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([profile]) => profile.split(',').map((pair) => pair.split(':').map(Number)));

  const trips = pattern.trips.sort((a, b) => a[0] - b[0]);
  const starts = [];
  let previousStart = 0;
  for (const [start] of trips) {
    starts.push(start - previousStart);
    previousStart = start;
  }
  const coordIndices = coords.map(([lng, lat]) => {
    const key = `${lng},${lat}`;
    let index = vertices.indices.get(key);
    if (index === undefined) {
      index = vertices.coords.length;
      vertices.indices.set(key, index);
      vertices.coords.push([lng, lat]);
    }
    return index;
  });

  // Profile and service index share one varint: profile * serviceCount + service.
  const tripCodes = trips.map((trip) => trip[1] * serviceCount + trip[2]);

  // Stop distances grow monotonically, so store them as deltas.
  const stopDeltas = stops.map((stop, i) => (i ? stop - stops[i - 1] : stop));

  line.paths.push({
    // Index run into the line's shared vertex table.
    ci: encodeDeltas(coordIndices),
    s: encodeInts(stopDeltas),
    // Station index per stop, for the sidebar's departure board. Delta-coded
    // like the stop distances: adjacent stops are often neighbours in the
    // sorted table, so the deltas stay small.
    st: encodeInts(pathStations.map((value, i) => (i ? value - pathStations[i - 1] : value))),
    // The direction this pattern runs in, as an index into `headsigns`.
    h: headsignIndex.get(headsignFor(pattern)),
    p: profiles.map(encodeProfile),
    t: encodeInts(starts),
    tp: encodeInts(tripCodes),
  });
  pathCount++;
  tripCount += pattern.trips.length;
}

const feedEnd = output.feed.end;
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
if (feedEnd && feedEnd < today) {
  console.warn(`Feed expired on ${feedEnd}; the timetable no longer covers today (${today}).`);
}

// Encode each line's shared vertex table once every path has contributed to it.
for (const [lineName, line] of Object.entries(output.lines)) {
  line.verts = encodeCoords(vertexTablesByLine[lineName].coords);
}

// Emit lines in their display order so both the JSON and the pill row are
// stable without the runtime re-sorting.
output.lines = Object.fromEntries(
  Object.entries(output.lines).sort((a, b) => a[1].order - b[1].order),
);

const json = JSON.stringify(output, null, 2) + '\n';
await fs.writeFile(OUT_FILE, json);
await fs.writeFile(
  META_FILE,
  JSON.stringify(
    { fetchedAt: new Date().toISOString(), feed: output.feed, agency: output.agency },
    null,
    2,
  ) + '\n',
);

console.log(`Built ${path.relative(ROOT, OUT_FILE)}`);
console.log(
  `  ${Object.keys(output.lines).length} lines, ${pathCount} paths, ${tripCount} trips, ${(json.length / 1024 / 1024).toFixed(2)} MB`,
);
