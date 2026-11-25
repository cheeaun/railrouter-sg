// Pure timetable queries, kept free of JSON imports and fetch so Node tests can
// import this module directly. src/timetable.mjs loads the data and re-exports
// these.
//
// The packed timetable has no station names per stop. The builder writes a
// `stations` table (combined station_codes keys) and a per-path `st` list of
// station indices, which is all this module needs to answer "what leaves this
// station next?".
//
// Direction copy follows LTA's Circle Line wayfinding, the only full-loop line
// in Singapore. Its platform display names a direction one of two ways:
//   "via <next interchange>"  for a through (loop) service, and
//   "ends at <terminus>"      for a service that terminates.
// The direction itself is Clockwise / Anticlockwise, which only the geometry
// can tell: a loop trip's GTFS headsign is sometimes the compass direction and
// sometimes the terminus it happens to end at.

import { decodeInts, decodeProfile, decodeCoords } from './gtfs-codec.mjs';

// Decoded per-path data, cached so repeated station lookups do not re-run the
// varint and profile decoders.
const decodedPaths = new WeakMap();

function decodePath(path) {
  let decoded = decodedPaths.get(path);
  if (!decoded) {
    const starts = [];
    let start = 0;
    for (const delta of decodeInts(path.t)) {
      start += delta;
      starts.push(start);
    }
    // Station indices are delta-coded along the path.
    const stops = [];
    let stop = 0;
    for (const delta of decodeInts(path.st)) {
      stop += delta;
      stops.push(stop);
    }
    decoded = {
      starts,
      stops,
      codes: decodeInts(path.tp),
      profiles: path.p.map(decodeProfile),
    };
    decodedPaths.set(path, decoded);
  }
  return decoded;
}

// Signed area of a closed polyline. Treating longitude as x and latitude as y
// (a y-up frame), an anticlockwise loop encloses positive area and a clockwise
// one negative, so the sign reads the direction directly.
function signedArea(coords) {
  let area = 0;
  for (let i = 0; i < coords.length; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[(i + 1) % coords.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

// First index whose value is >= target in an ascending array.
function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

// How far ahead a departure can be and still count as "next". Rows whose
// soonest train is further out than this are dropped: they are rare short-turn
// patterns, not a useful answer to "what leaves next".
const MAX_WAIT = 30 * 60;

// At most this many rows per line and direction. LTA's platform display shows
// the next two trains per direction, and they can carry different copy.
const ROWS_PER_DIRECTION = 2;

const indexes = new WeakMap();

// Work out which way round a loop line runs, from the stop order of the paths
// that close on themselves. Those give a canonical station sequence; any other
// path on the line (a short-turn or a spur) is then classified by whether its
// stop order advances through that sequence or runs against it.
//
// This replaces reading the sign of the path's own enclosed area, which is
// meaningless for a short arc: Promenade → Nicoll Highway → Stadium is almost a
// straight line, so its "area" is a sliver and the sign is noise.
function loopOrderFor(line) {
  const paths = line.paths.map((path) => decodePath(path).stops);
  const closedIndex = paths.findIndex((stops) => stops.length > 1 && stops[0] === stops[stops.length - 1]);
  if (closedIndex < 0) return null;

  // The canonical sequence, without the duplicated closing stop.
  const ring = paths[closedIndex];
  const order = new Map();
  ring.slice(0, -1).forEach((station, index) => order.set(station, index));
  const size = order.size;
  if (size < 3) return null;

  // Which way the closed path itself runs. Its area *is* meaningful: a full lap
  // encloses the whole loop, so the sign is reliable. Everything else is then
  // measured against this ring.
  const ringSign = signedArea(decodeCoords(line.coords[line.paths[closedIndex].c])) > 0 ? 1 : -1;

  const step = (a, b) => {
    const from = order.get(a);
    const to = order.get(b);
    if (from === undefined || to === undefined) return null;
    const forward = (to - from + size) % size;
    if (forward === 0) return 0;
    // A short jump forward, or a long jump that is really a step backwards.
    return forward <= size / 2 ? 1 : -1;
  };

  return {
    directionOf(stops) {
      // Sum each consecutive step the ring knows about; the majority direction
      // decides which way the train is going round.
      let score = 0;
      for (let i = 1; i < stops.length; i++) {
        const direction = step(stops[i - 1], stops[i]);
        if (direction) score += direction;
      }
      return score * ringSign >= 0 ? 'Anticlockwise' : 'Clockwise';
    },
  };
}

// Build (once per parsed timetable) a station -> boarding points index. A
// boarding point is a path plus the stop index where the station sits. The
// final stop of a path is excluded: a train arriving at its terminus does not
// depart from there on the same trip.
//
// `stationNames` maps a station key to its display name. It is kept on the
// returned timetable and consulted when rows are built, not baked into the
// cached index: the names come from a separate fetch that may not have landed
// yet, and caching them here would freeze the codes for the whole session.
export function timetableFor(data, stationNames = new Map()) {
  let timetable = indexes.get(data);
  if (timetable) {
    // A later call may have the names this one lacks.
    if (stationNames.size > timetable.stationNames.size) timetable.stationNames = stationNames;
    return timetable;
  }

  const stationCodes = data.stations || [];
  const headsigns = data.headsigns || [];
  const serviceCount = Object.keys(data.services).length;
  const serviceOrder = new Array(serviceCount);
  for (const [id, service] of Object.entries(data.services)) serviceOrder[service.i] = id;

  // An interchange is a station whose key combines several line codes
  // (`NS17-CC15`). LTA uses the next one as the "via" cue.
  const isInterchange = (key) => typeof key === 'string' && key.includes('-');

  const byStation = new Map();
  for (const [lineKey, line] of Object.entries(data.lines)) {
    // Only a loop line gets LTA's Clockwise/Anticlockwise copy. Every other
    // line just names the terminus it is heading for.
    const loop = loopOrderFor(line);

    for (const path of line.paths) {
      if (!path.st) continue;
      const { stops, starts } = decodePath(path);
      const terminus = stationCodes[stops[stops.length - 1]];
      const closed = stops.length > 1 && stops[0] === stops[stops.length - 1];
      const headsign = headsigns[path.h] || terminus;
      const trips = starts.length;

      // The direction on the platform display. On a loop it is the way round.
      // That is read from the stop order along the loop, not from this path's
      // own geometry: a short arc (Promenade → Nicoll Highway → Stadium) is
      // nearly straight, so the area it encloses is a sliver whose sign says
      // nothing about which way round the train is going.
      const direction = loop ? loop.directionOf(stops) : headsign;

      // The final stop is excluded: a train that ends its run here has no
      // onward direction to label it with, and a rider at a terminus wants the
      // trains leaving it, which the reverse paths already provide.
      for (let stopIndex = 0; stopIndex < stops.length - 1; stopIndex++) {
        const key = stationCodes[stops[stopIndex]];
        if (!key) continue;

        let qualifier = null;
        let qualifierStation = null;
        if (loop) {
          if (closed) {
            // A closed loop has no terminus, so it is always "via" the next
            // interchange ahead. The search wraps past the end of the path,
            // because the last station before the hub has no interchange ahead
            // of it until the loop comes round again; without the wrap those
            // stations fell through to the plain-line branch and lost their
            // direction entirely.
            const count = stops.length - 1; // the last stop duplicates the first
            for (let step = 2; step < count; step++) {
              const ahead = stationCodes[stops[(stopIndex + step) % count]];
              if (isInterchange(ahead)) {
                qualifier = 'via';
                qualifierStation = ahead;
                break;
              }
            }
          } else {
            qualifier = 'ends at';
            qualifierStation = terminus;
          }
        }

        let entries = byStation.get(key);
        if (!entries) byStation.set(key, (entries = []));
        entries.push({
          lineKey,
          path,
          stopIndex,
          direction,
          // Whether this entry is a loop line's, which decides how rows are
          // grouped and labelled. Keyed on the line rather than on the qualifier
          // being present: a loop stop with no interchange ahead still belongs
          // to the loop and must not fall back to plain-line labelling.
          isLoop: Boolean(loop),
          // The copy is stored as a keyword plus the station *code*; the name
          // is resolved when the rows are built. Names come from a separate
          // fetch that may not have landed when this index is first built, and
          // the index is cached, so baking names in here would freeze whatever
          // was available at that moment.
          qualifier,
          qualifierStation,
          // On a plain line the direction is the next station (several trains
          // can run the same way yet terminate at different stations), and the
          // terminus of the dominant pattern is only the label.
          nextStation: stationCodes[stops[stopIndex + 1]],
          labelStation: terminus,
          trips,
        });
      }
    }
  }

  timetable = { data, byStation, serviceCount, serviceOrder, stationNames };
  indexes.set(data, timetable);
  return timetable;
}

// Next scheduled arrivals at a station, one row per line and direction.
// `seconds` is service-day seconds (see clock()), `services` the set of service
// ids running that day, and `limit` the number of times per row.
//
// LTA's platform display lists the next two trains per direction, and on a loop
// line those two can carry different copy ("via Serangoon" for a through
// service, "ends at Dhoby Ghaut" for a terminating one). So rows are built from
// individual trains: take the next `limit` arrivals in a direction and keep each
// one's own copy.
export function arrivalsAt(timetable, stationKey, { services, seconds, limit = 2 }) {
  const entries = timetable.byStation.get(stationKey);
  if (!entries) return [];

  const nameOf = (key) => timetable.stationNames.get(key) || key;

  // Collect the next arrivals per line+direction. Each carries its own copy.
  const directions = new Map();
  for (const entry of entries) {
    const { path, stopIndex, lineKey, direction, isLoop, qualifier, qualifierStation, nextStation, labelStation, trips } = entry;
    const { starts, codes, profiles } = decodePath(path);
    const label = nameOf(labelStation);

    // On a plain line the direction is the next station: several trains can run
    // the same way yet terminate at different stations, and grouping by
    // terminus would split one direction into a row per terminus. On a loop the
    // direction is Clockwise/Anticlockwise.
    const dirKey = isLoop ? `${lineKey}|${direction}` : `${lineKey}|next|${nextStation}`;
    let group = directions.get(dirKey);
    if (!group) {
      directions.set(
        dirKey,
        (group = { lineKey, direction, label, trips: 0, arrivals: [] }),
      );
    }
    // A plain line is labelled by the terminus of the pattern with the most
    // trips, so a handful of short-turns cannot rename the direction.
    if (!isLoop) {
      if (trips > group.trips) {
        group.label = label;
        group.trips = trips;
      }
      group.direction = group.label;
    }

    // How far before now the scan must start. A profile pair is
    // [arrival, departure]; a train is still on the board until it leaves, so
    // the look-back has to cover the *departure* offset. Using the arrival
    // offset would drop a train that has just pulled in.
    let maxOffset = 0;
    for (const profile of profiles) {
      const pair = profile[Math.min(stopIndex, profile.length - 1)];
      if (pair && pair[1] > maxOffset) maxOffset = pair[1];
    }

    for (let i = lowerBound(starts, seconds - maxOffset); i < starts.length; i++) {
      const start = starts[i];
      // Trip starts are ascending, so once a trip starts after the horizon no
      // later trip can arrive before it either.
      if (start > seconds + MAX_WAIT) break;
      const code = codes[i];
      const profileIndex = Math.floor(code / timetable.serviceCount);
      const serviceIndex = code % timetable.serviceCount;
      if (!services.has(timetable.serviceOrder[serviceIndex])) continue;
      const profile = profiles[profileIndex];
      const pair = profile[Math.min(stopIndex, profile.length - 1)];
      if (!pair) continue;
      // The board is "Arrival times", so the time shown is when the train
      // reaches this station, not when it leaves. The two differ by the dwell.
      const arrival = start + pair[0];
      const departure = start + pair[1];
      // A train that has already left is gone; one that has arrived but not
      // left is still standing at the platform, shown as "Arrived". The
      // comparison is strict so a stop with no dwell (arrival == departure)
      // still appears on the tick it arrives instead of vanishing instantly.
      if (departure < seconds) continue;
      if (arrival > seconds + MAX_WAIT) continue;

      group.arrivals.push({
        at: arrival,
        arrived: arrival <= seconds,
        qualifier: qualifier && `${qualifier} ${nameOf(qualifierStation)}`,
      });
    }
  }

  const lines = timetable.data.lines;
  const rows = [];
  for (const group of directions.values()) {
    const line = lines[group.lineKey];
    if (!line) continue;

    // Rows are grouped by their copy, so two trains heading the same way but
    // with different copy get their own row, exactly as LTA displays them.
    // Two *different* direction groups can resolve to the same copy (a line
    // whose trains reach the same terminus from two next stations), so the
    // times are collected first and capped afterwards.
    const byCopy = new Map();
    for (const arrival of group.arrivals) {
      let row = byCopy.get(arrival.qualifier);
      if (!row) {
        byCopy.set(
          arrival.qualifier,
          (row = { line, direction: group.direction, qualifier: arrival.qualifier, times: [] }),
        );
      }
      row.times.push({ at: arrival.at, arrived: arrival.arrived });
    }

    for (const row of byCopy.values()) {
      // Earliest first, deduplicated, and capped per row. Doing this after the
      // merge is what keeps a shared copy from showing more than `limit` times
      // out of order.
      const seen = new Set();
      row.times = row.times
        .sort((a, b) => a.at - b.at)
        .filter((time) => {
          if (seen.has(time.at)) return false;
          seen.add(time.at);
          return true;
        })
        .slice(0, limit);
      if (row.times.length) rows.push(row);
    }
  }

  // Sort on static attributes only. Using the next arrival as a tie-break made
  // rows swap places every few minutes as trains overtook each other: at
  // MacPherson the two Circle Line rows per direction alternate between "via"
  // and "ends at", so their soonest times cross constantly. The order must not
  // depend on the clock.
  rows.sort((a, b) => {
    const orderA = a.line.order ?? 99;
    const orderB = b.line.order ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    if (a.line.name !== b.line.name) return a.line.name.localeCompare(b.line.name);
    if (a.direction !== b.direction) return a.direction.localeCompare(b.direction);
    // Within one direction, the through service ("via …") leads and the
    // terminating one ("ends at …") follows. Then the label itself, so the
    // order is total and never ties.
    const kindA = a.qualifier?.startsWith('via ') ? 0 : 1;
    const kindB = b.qualifier?.startsWith('via ') ? 0 : 1;
    if (kindA !== kindB) return kindA - kindB;
    return (a.qualifier ?? '').localeCompare(b.qualifier ?? '');
  });
  return rows;
}
