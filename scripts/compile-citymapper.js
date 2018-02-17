const fs = require('fs');
const polyline = require('polyline');

const wikipedia = require('../data/v2/wikipedia.json');
const wikipediaHash = {};
wikipedia.forEach(d => wikipediaHash[d.name] = d);
const wikipediaKeys = Object.keys(wikipediaHash);

const matchStopWikipedia = (stopName) => {
  const name = stopName.toLowerCase().trim();
  const result = wikipediaKeys.filter(k => {
    const key = k.toLowerCase().trim();
    return name == key;
  })[0];
  if (!result) console.warn(`NO MATCH FOUND: ${name}`);
  const hash = wikipediaHash[result];
  return {
    ref: hash.codes.map(c => c.text).join(';'),
    codes: hash.codes,
    'name:zh': hash.name_chinese,
    'name:hi': hash.name_tamil,
    wikipedia_url: hash.url,
    wikipedia_image_url: hash.image,
  };
};

fs.readdir('data/v2', (e, files) => {
  const allStopsHash = {}; // Use hash to prevent duplicates
  const allLines = [];
  const allRoutes = {};

  files.map(f => {
    const data = JSON.parse(fs.readFileSync(`data/v2/${f}`));
    const network = /^l\-/.test(f) ? 'lrt' : 'mrt';
    // STOPS
    if (/^stops-/.test(f)) {
      const { stops } = data;
      stops.forEach(stop => {
        if (!stop.exits) console.info(`${stop.name} has NO EXITS!`);
        const wp = matchStopWikipedia(stop.name);
        allStopsHash[stop.name] = {
          name: stop.name,
          coord: stop.coords,
          network,
          exits: (stop.exits || []).map(exit => ({
            exit: exit.indicator,
            name: exit.name,
            coord: exit.coords,
          })).sort((a, b) => {
            if (a.exit < b.exit) return -1;
            if (a.exit > b.exit) return 1;
            return 0;
          }),
          ...wp,
        };
      });
    } else if (/^[lm]rt-/.test(f)) { // LINES
      const { routes, stops } = data;
      const stopPoints = Object.keys(stops);

      // To keep track of stop_points
      // Then only get the patterns that already cover all the stops
      const stopTracks = {};
      let stopCount = stopPoints.length;

      const { name, color, patterns } = routes[0];
      let i = 0;
      do {
        const { stop_points, path } = patterns[i++];
        allLines.push({
          colour: color,
          coords: polyline.encode(path),
        });
        stop_points.forEach(p => stopTracks[p.id] = 1);
      } while (Object.keys(stopTracks).length < stopCount);

      // LatLngBoundsLiteral in Google Maps, all opposite values
      const bounds = {north: -90, south: 90, east: -180, west: 180};
      stopPoints.forEach(stop => {
        const { coords } = stops[stop];
        const [lat, lng] = coords;
        bounds.north = Math.max(bounds.north, lat);
        bounds.south = Math.min(bounds.south, lat);
        bounds.east = Math.max(bounds.east, lng);
        bounds.west = Math.min(bounds.west, lng);
      });

      const routeKey = f.replace(/\.json$/, '');
      allRoutes[routeKey] = { color, name, bounds };
    }
  });

  const allStops = Object.keys(allStopsHash).map(name => allStopsHash[name]);

  console.info(`Total stops: ${allStops.length}`);
  console.info(`Total lines: ${allLines.length}`);
  console.info(`Total routes: ${Object.keys(allRoutes).length}`);

  const body = {
    stops: allStops,
    lines: allLines,
    routes: allRoutes,
  };
  const filePath = `data/v2/all.json`;
  fs.writeFile(filePath, JSON.stringify(body, null, '\t'), (e) => {
    if (e) throw e;
    console.log('JSON file generated: ' + filePath);
  });
});