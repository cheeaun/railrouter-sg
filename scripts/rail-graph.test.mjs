import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildGraph } from './rail-graph.mjs';

const loopStart = [103.861153, 1.292828];
const loopEnd = [103.861082, 1.292709];

const edgeBetween = (graph, a, b) =>
  graph.adjacency[a].some(([other]) => other === b) ||
  graph.adjacency[b].some(([other]) => other === a);

const indexOf = (graph, coord) =>
  graph.coords.findIndex((point) => point[0] === coord[0] && point[1] === coord[1]);

test('closes a loop whose start is shared with a branch', () => {
  // The Circle Line is drawn this way: the loop is an open polyline whose ends
  // meet at Promenade, and the Dhoby Ghaut branch starts at the same point.
  // Shared start makes that node degree 2, which a loose-end-only check skips.
  const graph = buildGraph({
    geometry: {
      type: 'MultiLineString',
      coordinates: [
        [loopStart, [103.8614, 1.2927], [103.8615, 1.2925], loopEnd],
        [loopStart, [103.8605, 1.2939], [103.845158, 1.299189]],
      ],
    },
  });

  const start = indexOf(graph, loopStart);
  const end = indexOf(graph, loopEnd);
  assert.ok(start >= 0 && end >= 0, 'both loop ends should be graph nodes');
  assert.ok(edgeBetween(graph, start, end), 'loop ends should be joined');
});

test('leaves a plain open line open', () => {
  const graph = buildGraph({
    geometry: {
      type: 'LineString',
      coordinates: [
        [103.8, 1.3],
        [103.81, 1.31],
        [103.82, 1.32],
      ],
    },
  });

  assert.equal(graph.coords.length, 3);
  assert.equal(
    graph.adjacency.reduce((sum, edges) => sum + edges.length, 0),
    4,
    'only the two drawn segments should exist',
  );
});
