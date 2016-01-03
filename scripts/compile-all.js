var fs = require('fs');
var polyline = require('polyline');

fs.readdir('data', function(e, files){
  var allData = {
    lines: [],
    stops: {},
  };

  files.filter(function(file){
    return /^[lm]\-/.test(file);
  }).forEach(function(file){
    var path = 'data/' + file;
    console.log('Reading ' + path);
    var f = fs.readFileSync(path);
    var data = JSON.parse(f);

    data.ways.forEach(function(way){
      var line = {
        colour: data.meta.colour,
        coords: polyline.encode(way.coords),
      };
      allData.lines.push(line);
    });

    var network = /^l\-/.test(file) ? 'lrt' : 'mrt';
    data.stops.forEach(function(stop){
      var s = allData.stops[stop.meta.ref] = stop.meta;
      s.coord = stop.coord;
      if (!s.network) s.network = network;
    });
  });

  var filePath = 'data/all.json';
  fs.writeFile(filePath, JSON.stringify(allData), function(e){
    if (e) throw e;
    console.log('JSON file generated: ' + filePath);
  });
});
