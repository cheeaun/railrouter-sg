var map, infowindow;
var mapBounds = {
  // Calculated from list of stops
  south: 1.2513146,
  west: 103.6366651,
  north: 1.4490928,
  east: 103.99178865,
};
var $ = function(id){ return document.getElementById(id); };

var $about = $('about');
var $aboutOkay = $('about-okay');

var $header = $('heading');
var toggleAbout = function(){
  $about.classList.toggle('show');
};
$header.addEventListener('click', toggleAbout, false);
$aboutOkay.addEventListener('click', toggleAbout, false);
if (window.localStorage && !localStorage['railrouter-sg:about']){
  $about.classList.add('show');
  localStorage['railrouter-sg:about'] = 1;
}

$('legend').innerHTML = Object.keys(data.routes).reverse().map(function(routeCode){
  var route = data.routes[routeCode];
  return '<li onclick="zoomBoundsFromRoute(\'' + routeCode + '\')"><span style="background-color: ' + route.color + '"></span> ' + route.name + '</li>';
}).join('');

function initMap(){
  map = new google.maps.Map($('map'), {
    backgroundColor: '#B3D1FF',
    disableDefaultUI: true,
    keyboardShortcuts: true,
    styles: [
      {
        featureType: 'road.highway',
        elementType: 'geometry.fill',
        stylers: [
          { color: '#ffffff' }
        ]
      },{
        featureType: 'road.highway',
        elementType: 'geometry.stroke',
        stylers: [
          { color: '#cccccc' },
        ]
      },{
        featureType: 'road.arterial',
        stylers: [
          { visibility: 'simplified' }
        ]
      },{
        featureType: 'transit.station.rail',
        stylers: [
          { visibility: 'off' }
        ]
      },{
        featureType: 'road',
        elementType: 'labels.icon',
        stylers: [
          { visibility: 'off' }
        ]
      }
    ]
  });

  var onlineStatus = null;
  var setMapType = function(){
    if (navigator.onLine){
      map.setMapTypeId(google.maps.MapTypeId.ROADMAP);
      onlineStatus = 'online';
    } else {
      map.setMapTypeId(null);
      onlineStatus = 'offline';
    }
  };
  setMapType();
  window.addEventListener('online', function(){
    if (onlineStatus == 'offline') setMapType();
  });

  map.fitBounds(mapBounds);
  var $boundsWarning = $('bounds-warning');
  map.addListener('bounds_changed', function(){
    var bounds = map.getBounds();
    if (bounds.intersects(mapBounds)){
      $boundsWarning.classList.remove('visible');
    } else {
      $boundsWarning.classList.add('visible');
    }
  });
  $('back-sg').addEventListener('click', function(){
    $boundsWarning.classList.remove('visible');
		map.fitBounds(mapBounds);
  }, false);

  var transitLayer = new google.maps.TransitLayer();
  var $transitCheckbox = $('checkbox-transit');
  transitLayer.setMap($transitCheckbox.checked ? map : null);
  $transitCheckbox.addEventListener('change', function(){
    transitLayer.setMap($transitCheckbox.checked ? map : null);
  }, false);
  var $transitToggle = $('toggle-transit');

  if (navigator.geolocation){
    var LocationMarker = _LocationMarker(google);
    var locationMarker = new LocationMarker({
      visible: false,
      map: map,
    });

    var $nearestStation = $('nearest-station');
    var $location = $('location');
    $location.style.display = 'block';

    var watching = false;
    var watch;

    var unwatch = function(){
      navigator.geolocation.clearWatch(watch);
      watching = false;
      locationMarker.setVisible(false);
      $location.classList.remove('active');
      $nearestStation.classList.remove('show');
    };

    $location.addEventListener('click', function(){
      $location.classList.add('active');
      if (watching){
        var markerLocation = locationMarker.getPosition();
        if (markerLocation.equals(map.getCenter())){
          if (map.getZoom() < 16) map.setZoom(16);
        } else {
          map.panTo(markerLocation);
        }
      } else {
        watch = navigator.geolocation.watchPosition(function(position){
          var coords = position.coords;
          var pos = new google.maps.LatLng(coords.latitude, coords.longitude);
          locationMarker.setPosition(pos);
          locationMarker.setRadius(coords.accuracy);
          locationMarker.setVisible(true);
          if (!watching) map.panTo(pos);
          watching = true;
          sessionStorage['railrouter-sg:watch-location'] = 1;

          // Make sure current location is in Singapore first
          var bounds = new google.maps.LatLngBounds(
            new google.maps.LatLng(mapBounds.south, mapBounds.west),
            new google.maps.LatLng(mapBounds.north, mapBounds.east)
          );
          if (!bounds.contains(pos)){
            $nearestStation.classList.remove('show');
            return;
          }

          // Show nearest station
          var nearestStop;
          var shortestDistance = Infinity;
          data.stops.forEach(function(stop){
            var distance = google.maps.geometry.spherical.computeDistanceBetween(pos, new google.maps.LatLng(stop.coord[0], stop.coord[1]));
            if (distance < shortestDistance){
              shortestDistance = distance;
              nearestStop = stop;
            }
          });
          $nearestStation.innerHTML = 'Nearest station: <b>' + nearestStop.name + '</b>';
          $nearestStation.onclick = function(){ // probably memory leak here
            if (map.getZoom() < 16) map.setZoom(16);
            map.panTo({
              lat: nearestStop.coord[0],
              lng: nearestStop.coord[1],
            });
          };
          $nearestStation.classList.add('show');
        }, function(e){
          unwatch();
          alert('Unable to get your location. Please try again.');
        }, {
          enableHighAccuracy: true,
          timeout: 60*1000, // 1 min timeout
          maximumAge: 5*1000 // 5-second cache
        });
      }
    }, false);

    // Always show current location
    if (sessionStorage['railrouter-sg:watch-location']) setTimeout(function(){
      $location.click();
    }, 1000);

    map.addListener('dragstart', function(){
      $location.classList.remove('active');
    });

    if (window.DeviceOrientationEvent){
      window.addEventListener('deviceorientation', function(e){
        if (!watching) return;
        if (!e || e.alpha === null) return;
        locationMarker.drawCompass();
        locationMarker.setCompassHeading(e.webkitCompassHeading || e.alpha);
      }, false);
    }
  }

  init();
}

var exitCanvasCache = {};
var exitCanvas = function(name){
  if (exitCanvasCache[name]) return exitCanvasCache[name];
  var canvas = document.createElement('canvas');
  var context = canvas.getContext('2d');
  var font = context.font = '24px Sans-serif';
  var nameWidth = Math.ceil(context.measureText(name).width);
  var width = canvas.width = Math.max(32, nameWidth + 8);
  var height = canvas.height = 32;
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#00454d';
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(width, 0);
  context.lineTo(width, height);
  context.lineTo(0, height);
  context.closePath();
  context.fill();
  context.font = font;
  context.textBaseline = 'middle';
  context.textAlign = 'center';
  context.fillStyle = '#fff';
  context.fillText(name, width/2, height/2);
  return exitCanvasCache[name] = {
    image: canvas.toDataURL(),
    width: width,
    height: height,
  };
};

var stationCanvas = function(codes, name){
  var minBlockWidth = 32;
  var blockHeight = 32;
  var padding = 6;
  var textOutline = 6;
  var canvas = document.createElement('canvas');
  canvas._blockHeight = blockHeight;
  var context = canvas.getContext('2d');
  var font = context.font = '24px Sans-serif';
  var nameWidth = Math.ceil(context.measureText(name).width) + textOutline;
  var nameHeight = 28;
  var blocksWidth = 0;
  codes.forEach(function(code){
    var codeWidth = code.code ? Math.ceil(context.measureText(code.code).width) : 0;
    var blockWidth = Math.max(padding + codeWidth, minBlockWidth);
    code._width = blockWidth;
    blocksWidth += blockWidth;
  });
  canvas._blocksWidth = blocksWidth;
  var width = canvas.width = Math.max(blocksWidth, nameWidth);
  var height = canvas.height = blockHeight + padding + nameHeight + textOutline;
  context.clearRect(0, 0, width, height);
  context.font = font;
  context.textBaseline = 'top';
  var offset = 0;
  codes.forEach(function(code){
    var color = code.color;
    var width = code._width;
    context.beginPath();
    context.moveTo(offset, 0);
    context.lineTo(width + offset, 0);
    context.lineTo(width + offset, blockHeight);
    context.lineTo(offset, blockHeight);
    context.closePath();
    context.fillStyle = color;
    context.fill();
    if (code.code){
      context.fillStyle = '#fff';
      context.textAlign = 'center';
      context.fillText(code.code, offset + width/2, padding/2, width);
    }
    offset += width;
  });
  context.strokeStyle = '#fff';
  context.textAlign = 'start';
  context.lineWidth = textOutline;
  context.strokeText(name, textOutline/2, blockHeight + padding);
  context.fillStyle = '#000';
  context.fillText(name, textOutline/2, blockHeight + padding);
  return canvas;
};

var stationMiniCanvasCache = {};
var stationMiniCanvas = function(colors){
  var key = colors.map(function(color){ return color }).join('');
  if (stationMiniCanvasCache[key]) return stationMiniCanvasCache[key];
  var colorWidth = 16;
  var canvas = document.createElement('canvas');
  var width = canvas.width = colorWidth * colors.length;
  var height = canvas.height = colorWidth;
  var context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  colors.forEach(function(color, i){
    var offset = i * colorWidth;
    context.beginPath();
    context.moveTo(offset, 0);
    context.lineTo(colorWidth + offset, 0);
    context.lineTo(colorWidth + offset, colorWidth);
    context.lineTo(offset, colorWidth);
    context.closePath();
    context.fillStyle = color;
    context.fill();
  });
  return stationMiniCanvasCache[key] = {
    image: canvas.toDataURL(),
    width: width,
    height: height,
  };
};

function init(){
  var infoWidth = 250;
  var InfoBox = _InfoBox(google);
  infowindow = new InfoBox({
    closeBoxURL: '',
    alignBottom: true,
    pixelOffset: new google.maps.Size(-infoWidth/2, -5),
    infoBoxClearance: new google.maps.Size(10, 10),
  });
  map.addListener('click', function(){
    infowindow.close();
  });

  data.lines.forEach(function(line){
    var path = google.maps.geometry.encoding.decodePath(line.coords);
    new google.maps.Polyline({
      path: path,
      strokeColor: '#fff',
      strokeOpacity: .9,
      strokeWeight: 4,
      clickable: false,
      zIndex: 1,
      map: map,
    });
    if (line.construction){
      new google.maps.Polyline({
        path: path,
        icons: [{
          icon: {
            path: 'M 0,-1 0,1',
            strokeOpacity: .5,
          },
          offset: '0',
          repeat: '10px',
        }],
        strokeColor: line.colour,
        strokeOpacity: 0,
        strokeWeight: 2,
        clickable: false,
        zIndex: 2,
        map: map,
      });
    } else {
      new google.maps.Polyline({
        path: path,
        strokeColor: line.colour,
        strokeWeight: 2,
        clickable: false,
        zIndex: 2,
        map: map,
      });
    }
  });

  var exitMarkers = [];
  var exitLines = [];
  var zoom = map.getZoom();
  var visible = zoom >= 12;
  var markers = data.stops.map(function(stop){
    var codes = [];
    var ref = stop.ref || stop.asset_ref;
    if (ref){
      codes = ref.split(';').map(function(k){
        var code = k.match(/^[a-z]{1,2}/i)[0].toLowerCase();
        if (data.routeMaps[code]) code = data.routeMaps[code];
        var route = data.routes[code];
        if (route){
          return {
            code: k,
            color: route.color,
          };
        }
        return null;
      }).filter(function(code){
        return !!code;
      });
    } else {
      // Changi airport has "Station A" names
      var code = (stop.name.match(/station\s+([a-zA-Z0-9]+)/i) || [, null])[1];
      codes = [{
        code: code,
        color: '#666',
      }];
    }
    var colors = codes.map(function(code){
      return code.color;
    });
    var largeCanvas = stationCanvas(codes, stop.name);
    var smallCanvas = stationMiniCanvas(colors);
    var icons = {
      large: {
        url: largeCanvas.toDataURL(),
        scaledSize: new google.maps.Size(largeCanvas.width/2, largeCanvas.height/2),
        size: new google.maps.Size(largeCanvas.width/2, largeCanvas.height/2),
        anchor: new google.maps.Point(largeCanvas._blocksWidth/4, largeCanvas._blockHeight/4),
      },
      small: {
        url: smallCanvas.image,
        scaledSize: new google.maps.Size(smallCanvas.width/2, smallCanvas.height/2),
        size: new google.maps.Size(smallCanvas.width/2, smallCanvas.height/2),
        anchor: new google.maps.Point(smallCanvas.width/4, smallCanvas.height/4),
      }
    };
    var stopPosition = {lat: stop.coord[0], lng: stop.coord[1]};
    var marker = new google.maps.Marker({
      icon: zoom >= 14 ? icons.large : icons.small,
      _icons: icons,
      visible: visible,
      opacity: stop.construction ? .8 : 1,
      position: stopPosition,
      map: map,
    });

    marker.addListener('click', function() {
      var html = '<div class="infowindow">';
      if (stop.wikipedia_image_url){
        html += '<div class="infowindow-image" style="background-image: url(' + stop.wikipedia_image_url + ')"><a href="' + stop.wikipedia_url + '" target="_blank">Image from Wikipedia</a></div>'
      };
      html += '<div class="infowindow-content">';
      html += '<div class="infowindow-heading">'
        + '<a class="station-name" onclick="zoomTo(' + stop.coord.join(',') + ')">'
        + '<div><b>' + stop.name + '</b> ' + stop.network.split(';')[0].toUpperCase() + ' Station</div>'
        + (stop['name:zh'] ? stop['name:zh'] + '&nbsp;&nbsp;&nbsp;' : '')
        + (stop['name:hi'] ? stop['name:hi'] : '')
        + '</a>'
        + '</div>';
      if (stop.exits && stop.exits.length){
        var count = stop.exits.length;
        var s = (count != 1 ? 's' : '');
        html += '<div><span class="exit-info"><b>' + count + '</b> entrance' + s + '/exit' + s + '</span>&nbsp;&nbsp;';
        html += '<div class="inline-block">';
        stop.exits.forEach(function(exit){
          html += '<a class="exit-label" onclick="zoomTo(' + exit.coord.join(',') + ')">' + exit.exit + '</a> ';
        });
        html += '</div>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
      infowindow.setContent(html);
      infowindow.setPosition(marker.getPosition());
      infowindow.open(map);
    });

    var stopExits = [];
    var stopLines = [];
    (stop.exits || []).forEach(function(exit){
      var label = exit.exit;
      var eCanvas = exitCanvas(label);
      var exitPosition = {lat: exit.coord[0], lng: exit.coord[1]};
      stopExits.push(new google.maps.Marker({
        icon: {
          url: eCanvas.image,
          scaledSize: new google.maps.Size(eCanvas.width/2, eCanvas.height/2),
          size: new google.maps.Size(eCanvas.width/2, eCanvas.height/2),
          anchor: new google.maps.Point(eCanvas.width/4, eCanvas.height/4),
        },
        title: 'Exit ' + label + ' - ' + stop.name,
        visible: zoom >= 16,
        position: exitPosition,
        map: map,
      }));
      stopLines.push(new google.maps.Polyline({
        path: [ exitPosition, stopPosition ],
        strokeOpacity: 0,
        icons: [
          {
            icon: {
              path: 'M 0,-1 0,1',
              strokeOpacity: .3,
              strokeColor: '#00454d',
              scale: 3,
            },
            offset: '0',
            repeat: '15px',
          }
        ],
        clickable: false,
        visible: zoom >= 16,
        map: map,
      }));
    });
    exitMarkers = exitMarkers.concat(stopExits);
    exitLines = exitLines.concat(stopLines);

    return marker;
  });

  google.maps.event.addListener(map, 'zoom_changed', function(){
    var zoom = map.getZoom();
    var visible = zoom >= 12;
    markers.forEach(function(marker){
      marker.setOptions({
        visible: visible,
        icon: zoom >= 14 ? marker._icons.large : marker._icons.small,
      });
    });

    var exitVisible = zoom >= 16;
    exitMarkers.forEach(function(marker){
      marker.setOptions({
        visible: exitVisible,
      });
    });
    exitLines.forEach(function(line){
      line.setOptions({
        visible: exitVisible,
      });
    });
  });
}

function zoomTo(lat, lng){
  if (!map) return;
  if (infowindow) infowindow.close();
  if (map.getZoom() < 16) map.setZoom(16);
  map.panTo({ lat: lat, lng: lng });
};

function zoomBoundsFromRoute(route){
  if (!map) return;
  var bounds = data.routes[route].bounds;
  map.fitBounds(bounds);
  toggleAbout();
};
