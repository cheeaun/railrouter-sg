// Track graph shared by the GTFS builder and its tests.

const toRad = Math.PI / 180;

export function distance(a, b) {
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat = ((a[1] + b[1]) / 2) * toRad;
  return Math.hypot(dLat, dLon * Math.cos(lat)) * 6371000;
}

// A stop-to-stop leg longer than this multiple of the straight-line distance
// (and by at least MIN_LEG_EXCESS metres) means the router took a detour, such
// as going the long way round an unclosed loop. The most curved legitimate leg
// in the current data is the Changi Skytrain at 2.73x, so leave headroom.
export const MAX_LEG_DETOUR = 3.5;
export const MIN_LEG_EXCESS = 1000;

export function implausibleLeg(leg, straight) {
  return leg > straight * MAX_LEG_DETOUR && leg - straight > MIN_LEG_EXCESS;
}

// Part ends this close are the same point drawn twice (a loop or a branch
// meeting its parent line).
const JOIN_DISTANCE = 40;

export function buildGraph(feature) {
  const parts =
    feature.geometry.type === 'MultiLineString'
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates];
  const ids = new Map();
  const coords = [];
  const adjacency = [];
  const nodeId = (coord) => {
    const key = `${coord[0].toFixed(7)},${coord[1].toFixed(7)}`;
    if (!ids.has(key)) {
      ids.set(key, coords.length);
      coords.push(coord);
      adjacency.push([]);
    }
    return ids.get(key);
  };
  const connect = (a, b) => {
    if (a === b || adjacency[a].some(([other]) => other === b)) return;
    const weight = distance(coords[a], coords[b]);
    adjacency[a].push([b, weight]);
    adjacency[b].push([a, weight]);
  };
  for (const part of parts) {
    for (let i = 1; i < part.length; i++) connect(nodeId(part[i - 1]), nodeId(part[i]));
  }

  // Loop lines are drawn as open polylines whose ends meet on the ground
  // (and separate loops are drawn as disconnected parts). Join part ends that
  // sit on top of each other so routing can go right round the loop. Use every
  // part end rather than only degree-1 nodes: a loop end can also be where a
  // branch starts, which leaves that node with two edges and would otherwise
  // keep the loop open (e.g. the Circle Line at Promenade).
  const ends = [];
  for (const part of parts) {
    if (part.length < 2) continue;
    ends.push(nodeId(part[0]), nodeId(part[part.length - 1]));
  }
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (distance(coords[ends[i]], coords[ends[j]]) < JOIN_DISTANCE) {
        connect(ends[i], ends[j]);
      }
    }
  }
  return { coords, adjacency };
}
