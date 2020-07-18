var got = require('got');
var fs = require('fs');

var filePath = 'data/all.json';
var allData = JSON.parse(fs.readFileSync(filePath));
var mrtStops = Object.keys(allData.stops).filter(function(key){
  var stop = allData.stops[key];
  return /mrt/i.test(stop.network);
});

var stopPromises = mrtStops.map(function(key){
  return new Promise(function(resolve, reject){
    var stop = allData.stops[key];
    var stopName = stop.name.trim().replace(/\s+[a-zA-Z]{2}\d/, '');
    var searchVal = stopName + ' mrt station exit';
    var url = 'https://developers.onemap.sg/commonapi/search?searchVal=' + encodeURIComponent(searchVal) + '&returnGeom=Y&getAddrDetails=N';
    console.log('Stop: ' + stopName + ' ' + url);
    got(url, {json: true}).then(({body}) => {
      resolve();
      if (!body.found){
        console.log('!! No exits for ' + stopName);
        return;
      }

      const { results } = body;

      stop.exits = results.map(function(result){
        return {
          exit: (result.SEARCHVAL.match(/exit ([a-z0-9]+)/i) || [, 'a'])[1].toUpperCase(),
          coord: [parseFloat(result.LATITUDE, 10), parseFloat(result.LONGITUDE, 10)],
        };
      });
      stop.exits.sort(function(a, b){
        if (a.exit < b.exit) return -1;
        if (a.exit > b.exit) return 1;
        return 0;
      });
      console.log(stopName + ': ' + stop.exits.length);
    }).then(reject);
  });
});

Promise.all(stopPromises).then(function(){
  fs.writeFile(filePath, JSON.stringify(allData, null, '\t'), function(e){
    if (e) throw e;
    console.log('JSON file generated: ' + filePath);
  });
});
