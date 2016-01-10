var config = require('./config.json');
var accessToken = config.onemap.access_token;
var got = require('got');
var convert = require('./svy21.js');
var fs = require('fs');

got('http://www.onemap.sg/API/services.svc/getToken?accessKEY=' + encodeURIComponent(accessToken), function(err, body, res){
  var tokenBody = JSON.parse(body);
  var token = tokenBody.GetToken[0].NewToken;
  console.log('Token: ', token);

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
      var searchVal = 'searchval like \'$' + stopName + ' mrt station exit$\'';
      var url = 'http://www.onemap.sg/API/services.svc/basicSearch?token=' + encodeURIComponent(token) + '&returnGeom=1&wc=' + encodeURIComponent(searchVal) + '&otptFlds=CATEGORY';
      console.log('Stop: ' + stopName + ' ' + url);
      got(url, function(e, body, r){
        if (e) throw (e);
        resolve();
        var results = JSON.parse(body).SearchResults;
        if (results[0].ErrorMessage){
          console.log('!! No exits for ' + stopName);
          return;
        }
        stop.exits = results.slice(1).filter(function(result){
          // If has a slash, ignore it
          // Only accept exits with alphabets (EXIT A, B, A1, etc)
          var val = result.SEARCHVAL;
          return !/\w\/\w/.test(val) && (results.length >= 3 ? /exit [a-z0-9]+/i.test(val) : true);
        }).map(function(result){
          // Here we use SVY21 format because onemap.sg API give biased results when using WGS84
          // For example, if use WGS84, some stations return less exits compared to default SVY21
          // That's why I need to manually convert them back to WGS84
          var latlng = convert(result.Y, result.X);
          return {
            exit: (result.SEARCHVAL.match(/exit ([a-z0-9]+)/i) || [, 'a'])[1].toUpperCase(),
            coord: latlng,
          };
        });
        console.log(stopName + ': ' + stop.exits.length);
      });
    });
  });

  Promise.all(stopPromises).then(function(){
    fs.writeFile(filePath, JSON.stringify(allData, null, '\t'), function(e){
      if (e) throw e;
      console.log('JSON file generated: ' + filePath);
    });
  });
});
