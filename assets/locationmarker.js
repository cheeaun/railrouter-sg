function _LocationMarker(google){ // START WRAPPER
function LocationMarker(opts){
  this.position = opts.position;
  this.radius = 0;
  var div = this.div = document.createElement('div');
  div.id = 'location-marker';
  div.style.position = 'absolute';
  div.style.display = opts.visible ? 'block' : 'none';
  this.setMap(opts.map);
};
LocationMarker.prototype = new google.maps.OverlayView();
LocationMarker.prototype.onAdd = function(){
  var panes = this.getPanes();
  panes.overlayImage.appendChild(this.div);
};
LocationMarker.prototype.draw = function(){
  this.setPosition(this.position);
  this.setRadius(this.radius);
};
LocationMarker.prototype.getPosition = function(){
  return this.position;
};
LocationMarker.prototype.setPosition = function(position){
  if (!position) return;
  this.position = position;
  var point = this.getProjection().fromLatLngToDivPixel(position);
  var div = this.div;
  if (point){
    div.style.left = point.x + 'px';
    div.style.top = point.y + 'px';
  }
};
LocationMarker.prototype.setRadius = function(radius){
  if (!radius) return;
  this.radius = radius; // meters
  var position = this.position;
  // 1. Get a new position for offset from original position
  var newPosition = google.maps.geometry.spherical.computeOffset(position, radius, 0);
  // 2. Convert both position in pixels
  var projection = this.getProjection();
  var point = projection.fromLatLngToDivPixel(position);
  var newPoint = projection.fromLatLngToDivPixel(newPosition);
  // 3. Diff the pixel values between positions
  var radiusInPx = Math.abs(point.y - newPoint.y);
  // 4. Minus back the radius of the marker itself
  radiusInPx -= this.div.clientWidth/2;
  this.div.style.borderWidth = Math.max(radiusInPx, 0) + 'px';
};
LocationMarker.prototype.setVisible = function(visible){
  this.div.style.display = visible ? 'block' : 'none';
};
LocationMarker.prototype.drawCompass = function(){
  this.div.classList.add('compass');
};
LocationMarker.prototype.setCompassHeading = function(heading){
  var transform = 'translate3d(-50%, -50%, 0) rotate(' + heading + 'deg)';
  if (this.div.style.webkitTransform) this.div.style.webkitTransform = transform;
  this.div.style.transform = transform;
};
return LocationMarker;} // END WRAPPER
