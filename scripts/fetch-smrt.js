var got = require('got');
var fs = require('fs');

var headers = {
  // Fix for their "missing authorization header" error LOL
  Referer: 'http://journey.smrt.com.sg/journey/station_info/'
};

got('https://connect.smrt.wwprojects.com/smrt/api/stations/', {
  json: true,
  headers: headers,
}, function(err, body, res){
  if (err) throw err;
  var resultsPromises = body.results.map(function(result){
    return new Promise(function(resolve, reject){
      var name = result.name;
      var fileName = name.toLowerCase().replace(/\s+/, '_');
      console.log('name: ' + name);
      got('https://connect.smrt.wwprojects.com/smrt/api/station_info/?name=' + name.replace(/\s+/, '+'), {
        json: true,
        headers: headers,
      }, function(e, item, r){
        if (e){
          reject(e);
          return;
        }
        var meta = item.results[0];
        meta.exit.map(function(exit){
          exit._images = [
            'http://connect-cdn.smrt.wwprojects.com/public/img/exit/' + fileName + '_exit_a_1.jpg',
            'http://connect-cdn.smrt.wwprojects.com/public/img/exit/' + fileName + '_exit_a_2.jpg'
          ];
          return exit;
        });
        result._meta = meta;
        result._map = 'http://connect-cdn.smrt.wwprojects.com/autoupdate/images/locality/' + encodeURIComponent(name) + '.jpg';
        resolve(result);
      });
    });
  });

  Promise.all(resultsPromises).then(function(results){
    var filePath = 'data/smrt-data.json';
    fs.writeFile(filePath, JSON.stringify(results, null, '\t'), function(e){
      if (e) throw e;
      console.log('JSON file generated: ' + filePath);
    });
  }, function(e){
    console.log(e);
  });
});
