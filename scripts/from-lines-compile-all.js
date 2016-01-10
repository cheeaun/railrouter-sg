var fs = require('fs');
var polyline = require('polyline');

fs.readdir('data', function(e, files){
  var allData = {
    lines: [],
    stops: {},
    routes: {},
    // For some weird stations that have different code than the rest. OMGWHY
    // Here I just manually map them to the "correct" code
    routeMaps: {
      pt: 'pw',
      ce: 'cc',
      st: 'se',
    },
  };

  files.filter(function(file){
    return /^[lm]\-/.test(file);
  }).forEach(function(file){
    var path = 'data/' + file;
    console.log('Reading ' + path);
    var f = fs.readFileSync(path);
    var data = JSON.parse(f);

    var color = data.meta.colour || '#666';

    data.ways.forEach(function(way){
      var line = {
        colour: color,
        coords: polyline.encode(way.coords),
      };
      allData.lines.push(line);
    });

    // LatLngBoundsLiteral in Google Maps, all opposite values
    var bounds = {north: -90, south: 90, east: -180, west: 180};

    var network = /^l\-/.test(file) ? 'lrt' : 'mrt';
    data.stops.forEach(function(stop){
      var s = allData.stops[stop.meta.ref] = stop.meta;
      var coord = s.coord = stop.coord;
      var lat = coord[0], lng = coord[1];
      if (!s.network) s.network = network;
      bounds.north = Math.max(bounds.north, lat);
      bounds.south = Math.min(bounds.south, lat);
      bounds.east = Math.max(bounds.east, lng);
      bounds.west = Math.min(bounds.west, lng);
    });

    allData.routes[file.match(/\-([a-z]+)\./i)[1]] = {
      name: data.meta.ref || data.meta.name,
      color: color,
      bounds: bounds,
    };
  });

  var mrtCount = 0, lrtCount = 0;
  Object.keys(allData.stops).forEach(function(key){
    var stop = allData.stops[key];
    if (/mrt/i.test(stop.network)){
      mrtCount++;
    } else {
      lrtCount++;
    }
  });
  console.log('Total MRT stations: ' + mrtCount);
  console.log('Total LRT stations: ' + lrtCount);

  var filePath = 'data/all.json';
  fs.writeFile(filePath, JSON.stringify(allData, null, '\t'), function(e){
    if (e) throw e;
    console.log('JSON file generated: ' + filePath);
  });
});
