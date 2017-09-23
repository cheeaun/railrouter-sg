var got = require('got');
var parseString = require('xml2js').parseString;
var fs = require('fs');

var API = 'http://api.openstreetmap.org/api/0.6/';
var LINES = [ // Refer to http://wiki.openstreetmap.org/wiki/Mass_Rapid_Transit_%28Singapore%29
  // MRT
  {code: 'm-ew', id: 445764},
  {code: 'm-ns', id: 445768},
  {code: 'm-ne', id: 2293545},
  {code: 'm-cc', id: 2076291},
  {code: 'm-dt', id: 2313458},
  // LRT
  {code: 'l-bp', id: 1159434},
  {code: 'l-sw', id: 1146941},
  {code: 'l-se', id: 2312985},
  {code: 'l-pw', id: 2312984},
  {code: 'l-pe', id: 1146942},
  {code: 'l-cg', id: 2313372},
  // Sentosa (assume it's LRT for now)
  {code: 'l-s', id: 2353581},
];

var get = function(url, callback){
  console.log('Request: ' + url);
  got(url).then(({body}) => {
    parseString(body, function(e, result){
      if (e) throw e;
      callback(result);
    });
  }).catch((e) => {
    throw e;
  });
};

var expandTag = function(tags){
  var tag = {};
  tags.forEach(function(t){
    tag[t.$.k] = t.$.v;
  });
  return tag;
};

LINES.forEach(function(line){
  get(API + 'relation/' + line.id + '/full', function(result){
    var osm = result.osm;
    var relation = osm.relation[0];
    var ways = osm.way;
    var mapWays = (function(){
      var way = {};
      ways.forEach(function(w){
        way[w.$.id] = w;
      });
      return way;
    })();
    var nodes = (function(){
      var node = {};
      osm.node.forEach(function(n){
        node[n.$.id] = n;
      });
      return node;
    })();

    var data = {
      meta: expandTag(relation.tag),
      ways: ways.filter(function(way){
        var meta = expandTag(way.tag);
        return !meta.building; // No need buildings
      }).map(function(way){
        return {
          id: way.$.id,
          visible: way.$.visible,
          meta: expandTag(way.tag),
          coords: way.nd.map(function(nd){
            var ref = nd.$.ref;
            var node = nodes[ref];
            return [parseFloat(node.$.lat, 10), parseFloat(node.$.lon, 10)];
          }),
        };
      }),
      stops: relation.member.filter(function(m){
        var ref = m.$.ref;
        var isStop = m.$.role == 'stop';
        if (m.$.type == 'node' && isStop){
          var node = nodes[ref];
          var hasTag = node && node.tag;
          var meta = hasTag ? expandTag(node.tag) : {};
          return hasTag;
        } else if (m.$.type == 'way' && isStop){
          // Changi Group line has this. Few notes:
          // - This is a "way", but it's a polygon, not a polyline
          // - The "way" contains coordinates of the station/stop building perimeter itself, NOT the center position
          // - There's no "ref" key
          var way = mapWays[ref];
          var hasTag = way && way.tag;
          return hasTag;
        }
        return;
      }).map(function(stop){
        var ref = stop.$.ref;
        if (stop.$.type == 'way'){
          var way = mapWays[ref];
          var bounds = {north: -90, south: 90, east: -180, west: 180};
          way.nd.forEach(function(nd){
            var ref = nd.$.ref;
            var node = nodes[ref];
            var lat = parseFloat(node.$.lat, 10);
            var lon = parseFloat(node.$.lon, 10);
            bounds.north = Math.max(bounds.north, lat);
            bounds.south = Math.min(bounds.south, lat);
            bounds.east = Math.max(bounds.east, lon);
            bounds.west = Math.min(bounds.west, lon);
          });
          // Super simple way of calculating center of polygon
          var center = [(bounds.north + bounds.south)/2, (bounds.east + bounds.west)/2];
          return {
            meta: expandTag(way.tag),
            coord: center,
          };
        }
        var node = nodes[ref];
        return {
          meta: expandTag(node.tag),
          coord: [parseFloat(node.$.lat, 10), parseFloat(node.$.lon, 10)],
        };
      })
    };

    var filePath = 'data/' + line.code + '.json';
    fs.writeFile(filePath, JSON.stringify(data, null, '\t'), function(e){
      if (e) throw e;
      console.log('JSON file generated: ' + filePath);
    });
  });
});
