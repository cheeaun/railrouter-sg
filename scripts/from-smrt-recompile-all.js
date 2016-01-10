var fs = require('fs');

var allFile = 'data/all.json';
var allData = JSON.parse(fs.readFileSync(allFile));
var stopPromises = Object.keys(allData.stops).map(function(key){
  return new Promise(function(resolve, reject){
    var stop = allData.stops[key];
  });
});
