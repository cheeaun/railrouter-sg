// Regenerate src/basemap-style.json from OpenFreeMap's Bright style.
// The result mimics the old custom Mapbox "SG Rail V2" style. Run: npm run gen-style
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRIGHT = 'https://tiles.openfreemap.org/styles/bright';
const LIBERTY = 'https://tiles.openfreemap.org/styles/liberty';

const fetchStyle = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'railrouter-sg-style-generator' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

const [style, liberty] = await Promise.all([fetchStyle(BRIGHT), fetchStyle(LIBERTY)]);
const s = style;
const byId = () => Object.fromEntries(s.layers.map((l) => [l.id, l]));

const BG = '#faf8f5';
const WATER = 'hsl(192, 96%, 88%)';
const WATER_LABEL = 'hsl(192, 64%, 57%)';
const PARK = 'hsl(128, 68%, 92%)';
const WOOD = 'hsla(133, 95%, 77%, 0.8)';
const ROAD = '#ffffff';
const CASE = 'rgb(245, 241, 235)';
const STRUCT = 'rgb(245, 241, 235)';
const LABEL = 'rgb(62, 77, 119)';
const MUTED = 'rgb(139, 139, 139)';
const ROAD_LABEL = '#aaa';
const TRANSIT = [
  'bus', 'bus_stop', 'bus_station', 'railway', 'rail', 'railway_station',
  'train_station', 'subway', 'subway_entrance', 'station', 'ferry',
  'ferry_terminal', 'tram', 'tram_stop', 'platform', 'halt',
  'metro_station', 'taxi',
];

// OpenFreeMap icons are bitmaps (not SDF), so `icon-color` can't tint them;
// the POI layers use a small icon-size and reduced icon-opacity instead.
s.sprite = 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm';

const drop = (id) => {
  const low = id.toLowerCase();
  return (
    low.includes('railway')
    || ['landuse-railway', 'poi_transit', 'cablecar', 'cablecar-dash', 'ferry'].includes(low)
    || low.startsWith('aeroway')
    || ['landuse-suburb', 'landuse-commercial', 'landuse-school'].includes(low)
    || low.startsWith('boundary_')
    || low.startsWith('highway-shield')
    || low.startsWith('label_country_')
    || low === 'label_city_capital'
    // Old style had no casings on regular roads — only bridge-case-simple.
    || (low.startsWith('highway-') && low.endsWith('-casing'))
    || low === 'road_shield_us'
    || ['road_oneway', 'road_oneway_opposite'].includes(low)
  );
};

s.layers = s.layers.filter((l) => !drop(l.id));
let layers = byId();

const labelOther = layers.label_other;
if (labelOther?.filter?.[0] === 'match' && Array.isArray(labelOther.filter[2])) {
  // Remove country/capital-like places from the catch-all place label layer.
  labelOther.filter[2] = labelOther.filter[2].filter((value) => value !== 'country');
}

// Base colours
for (const layer of s.layers) {
  const { id: lid, type: kind, paint, layout } = {
    ...layer,
    paint: layer.paint ?? {},
    layout: layer.layout ?? {},
  };
  const low = lid.toLowerCase();
  layer.paint = paint;
  layer.layout = layout;
  if (lid === 'background') paint['background-color'] = BG;
  else if (low.startsWith('waterway') && kind === 'line') paint['line-color'] = WATER;
  else if (low.startsWith('water') && kind === 'fill') paint['fill-color'] = WATER;
  else if (['park', 'landcover-grass', 'landcover-grass-park'].includes(lid)) paint['fill-color'] = PARK;
  else if (lid === 'landcover-wood') paint['fill-color'] = WOOD;
  else if (['building', 'building-top'].includes(lid)) paint['fill-color'] = STRUCT;
  else if (lid === 'road_area_pier') paint['fill-color'] = BG;
  else if (lid === 'road_pier') paint['line-color'] = BG;
  else if (low === 'highway-area') paint['fill-color'] = 'rgb(251, 250, 248)';
  else if (low.includes('casing') && kind === 'line') paint['line-color'] = BG;
  else if ((low.startsWith('highway-') || low.startsWith('bridge-') || low.startsWith('tunnel-')) && kind === 'line') paint['line-color'] = ROAD;
  else if (low.startsWith('water_name') || low === 'waterway_line_label') paint['text-color'] = WATER_LABEL;
  else if (low.startsWith('poi_') || low === 'airport') paint['text-color'] = MUTED;
  else if (low.startsWith('highway-name')) paint['text-color'] = ROAD_LABEL;
  else if (low.startsWith('label_')) paint['text-color'] = LABEL;

  if (['poi_r20', 'poi_r7', 'poi_r1'].includes(lid)) {
    layer.filter = [
      'all', layer.filter,
      ['!', ['match', ['get', 'class'], TRANSIT, true, false]],
    ];
  }
}

const width = (stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];

// Old road widths, split per class (OFM has one layer per class).
const FILL = {
  major: width([5, 0.6, 13, 3.2, 18, 25.6, 22, 256]),
  secondary: width([5, 0.08, 13, 2, 18, 20.8, 22, 208]),
  link: width([5, 0, 13, 0.8, 18, 14.4, 22, 144]),
  minor: width([5, 0, 13, 0.4, 18, 8, 22, 80]),
};
const CASE_WIDTH = {
  major: width([13, 4.8, 18, 28.8, 22, 288]),
  secondary: width([13, 3.2, 18, 24, 22, 240]),
  link: width([13, 2, 18, 17.6, 22, 176]),
  minor: width([13, 1, 18, 12.8, 22, 128]),
};
const CAP = ['step', ['zoom'], 'butt', 14, 'round'];
const JOIN = ['step', ['zoom'], 'miter', 14, 'round'];
const CLASS = {
  'highway-motorway': 'major', 'highway-trunk': 'major', 'highway-primary': 'major',
  'bridge-motorway': 'major', 'bridge-trunk-primary': 'major',
  'tunnel-motorway': 'major', 'tunnel-trunk-primary': 'major',
  'highway-motorway-link-casing': 'major', 'tunnel-motorway-link-casing': 'major',
  'bridge-motorway-casing': 'major', 'tunnel-motorway-casing': 'major',
  'highway-secondary-tertiary': 'secondary', 'bridge-secondary-tertiary': 'secondary',
  'tunnel-secondary-tertiary': 'secondary',
  'highway-secondary-tertiary-casing': 'secondary',
  'bridge-secondary-tertiary-casing': 'secondary',
  'tunnel-secondary-tertiary-casing': 'secondary',
  'highway-link': 'link', 'highway-motorway-link': 'link',
  'bridge-link': 'link', 'bridge-motorway-link': 'link',
  'tunnel-link': 'link', 'tunnel-motorway-link': 'link',
  'highway-link-casing': 'link', 'highway-motorway-link-casing': 'link',
  'bridge-link-casing': 'link', 'bridge-motorway-link-casing': 'link',
  'tunnel-link-casing': 'link', 'tunnel-motorway-link-casing': 'link',
  'highway-minor': 'minor', 'bridge-minor': 'minor', 'tunnel-minor': 'minor',
  'tunnel-service-track': 'minor',
  'highway-minor-casing': 'minor', 'bridge-minor-casing': 'minor',
  'tunnel-minor-casing': 'minor', 'tunnel-service-track-casing': 'minor',
  'highway-primary-casing': 'major', 'highway-trunk-casing': 'major',
  'highway-motorway-casing': 'major',
  'bridge-trunk-primary-casing': 'major', 'tunnel-trunk-primary-casing': 'major',
};
for (const [lid, cls] of Object.entries(CLASS)) {
  const layer = layers[lid];
  if (!layer) continue;
  const casing = lid.endsWith('-casing');
  layer.paint['line-width'] = (casing ? CASE_WIDTH : FILL)[cls];
  if (casing) layer.paint['line-color'] = CASE;
  else {
    layer.layout['line-cap'] = CAP;
    layer.layout['line-join'] = JOIN;
  }
}

// road-simple from z5; bridge-simple and bridge-case-simple from z13.
for (const layer of s.layers) {
  if (layer.type !== 'line') continue;
  if (layer.id.startsWith('bridge-') && !layer.id.toLowerCase().includes('path')) layer.minzoom = 13;
  else if (layer.id.startsWith('highway-') && !layer.id.includes('name') && !layer.id.includes('area')) layer.minzoom = 5;
}

// Waterways fade in at z8 with the old class-based widths.
const waterWidth = [
  'interpolate', ['exponential', 1.3], ['zoom'],
  9, ['match', ['get', 'class'], ['canal', 'river'], 0.1, 0],
  20, ['match', ['get', 'class'], ['canal', 'river'], 8, 3],
];
const waterOpacity = ['interpolate', ['linear'], ['zoom'], 8, 0, 8.5, 1];
for (const layer of s.layers) {
  if (layer.id.startsWith('waterway') && layer.type === 'line') {
    layer.paint['line-width'] = waterWidth;
    layer.paint['line-opacity'] = waterOpacity;
    layer.minzoom = 8;
  }
}

// Paths: old widths/zoom/dash patterns.
const DASH = ['step', ['zoom'], ['literal', [4, 0.3]], 15, ['literal', [1.75, 0.3]],
  16, ['literal', [1, 0.3]], 17, ['literal', [1, 0.25]]];
const TDASH = ['step', ['zoom'], ['literal', [1, 0]], 15, ['literal', [1.75, 1]],
  16, ['literal', [1, 0.75]], 17, ['literal', [1, 0.5]]];
const setPath = (id, minzoom, color, lineWidth, dash) => {
  const layer = layers[id];
  layer.minzoom = minzoom;
  layer.paint['line-color'] = color;
  layer.paint['line-width'] = lineWidth;
  if (dash === null) delete layer.paint['line-dasharray'];
  else layer.paint['line-dasharray'] = dash;
};
setPath('highway-path', 12, ROAD, width([13, 0.5, 14, 1, 15, 1, 18, 4]), DASH);
setPath('bridge-path', 14, ROAD, width([15, 1, 18, 4]), DASH);
setPath('tunnel-path', 14, 'rgb(229, 218, 202)', width([15, 1, 18, 4]), TDASH);
layers['bridge-path-casing'].minzoom = 14;
layers['bridge-path-casing'].paint = {
  'line-color': 'rgb(235, 232, 225)',
  'line-width': width([15, 2, 18, 7]),
};

// Label zoom conditions from the old style.
const setLabel = (id, { minzoom, maxzoom, size, icon } = {}) => {
  const layer = layers[id];
  if (minzoom !== undefined) layer.minzoom = minzoom;
  if (maxzoom !== undefined) layer.maxzoom = maxzoom;
  else delete layer.maxzoom;
  if (size !== undefined) layer.layout['text-size'] = size;
  if (icon !== undefined) layer.layout['icon-image'] = icon;
};
setLabel('highway-name-major', { minzoom: 12, size: ['interpolate', ['linear'], ['zoom'], 10, 10, 18, 16] });
setLabel('highway-name-minor', { minzoom: 12, size: ['interpolate', ['linear'], ['zoom'], 10, 9, 18, 14] });
setLabel('highway-name-path', { minzoom: 12, size: ['interpolate', ['linear'], ['zoom'], 10, 6.5, 18, 13] });
setLabel('waterway_line_label', { minzoom: 13, size: ['interpolate', ['linear'], ['zoom'], 13, 12, 18, 18] });
// OFM has no `sizerank` on water_name, so use a plain zoom ramp.
const waterSize = ['interpolate', ['linear'], ['zoom'], 0, 12, 22, 18];
setLabel('water_name_line_label', { minzoom: 1, size: waterSize });
setLabel('water_name_point_label', { minzoom: 1, size: waterSize });
setLabel('label_other', {
  minzoom: 10, maxzoom: 15,
  size: ['interpolate', ['cubic-bezier', 0.5, 0, 1, 1], ['zoom'],
    11, ['match', ['get', 'type'], 'suburb', 11, 10.5],
    15, ['match', ['get', 'type'], 'suburb', 15, 14]],
});
const minorSize = ['interpolate', ['cubic-bezier', 0.2, 0, 0.9, 1], ['zoom'], 3, 10, 6, 12, 8, 12, 13, 12];
const majorSize = ['interpolate', ['cubic-bezier', 0.2, 0, 0.9, 1], ['zoom'], 3, 11, 6, 16, 8, 16, 15, 16];
setLabel('label_town', { minzoom: 2, maxzoom: 13, size: minorSize, icon: '' });
setLabel('label_village', { minzoom: 2, maxzoom: 13, size: minorSize, icon: '' });
setLabel('label_city', { minzoom: 2, maxzoom: 15, size: majorSize, icon: '' });
setLabel('label_state', {
  minzoom: 3, maxzoom: 9,
  size: ['interpolate', ['cubic-bezier', 0.85, 0.7, 0.65, 1], ['zoom'], 4, 8, 9, 14],
});

// Parks and landuse fade like the old layers. OFM splits "residential" into
// "residential" and "neighbourhood"; both must fade out by z12.
layers.park.minzoom = 5;
layers.park.paint['fill-opacity'] = ['interpolate', ['linear'], ['zoom'], 5, 0, 6, 0.6, 12, 0.2];
const landuseOpacity = [
  'interpolate', ['linear'], ['zoom'],
  8, ['match', ['get', 'class'], ['residential', 'neighbourhood', 'airport'], 0.8, 0.2],
  12, ['match', ['get', 'class'], ['residential', 'neighbourhood'], 0, 1],
];
for (const id of ['landcover-grass', 'landcover-wood', 'landcover-grass-park']) {
  layers[id].paint['fill-opacity'] = landuseOpacity;
}
const LANDUSE_COLORS = {
  'landuse-residential': 'rgb(253, 253, 252)',
  'landuse-industrial': 'rgb(237, 230, 219)',
  'landuse-cemetery': 'hsl(128, 80%, 99%)',
  'landuse-hospital': 'hsla(0, 93%, 78%, 0.2)',
  'landcover-glacier': 'hsl(192, 66%, 89%)',
  'landcover-ice-shelf': 'hsl(192, 66%, 89%)',
  'landcover-sand': 'hsl(55, 100%, 89%)',
};
for (const [id, color] of Object.entries(LANDUSE_COLORS)) {
  const layer = layers[id];
  if (!layer) continue;
  layer.minzoom = 5;
  layer.paint['fill-color'] = color;
  layer.paint['fill-opacity'] = landuseOpacity;
}

// Old style had no 2D building fills, no aeroway layers, and hid tunnel roads.
for (const id of ['building', 'building-top']) {
  (layers[id].layout ??= {}).visibility = 'none';
}
for (const layer of s.layers) {
  if (layer.id.startsWith('tunnel-') && layer.type === 'line' && layer.id !== 'tunnel-path') {
    (layer.layout ??= {}).visibility = 'none';
  }
}

layers['road_area_pier'].minzoom = 13;
layers['road_area_pier'].paint = { 'fill-color': STRUCT };
layers['highway-area'].minzoom = 14;
layers.airport.minzoom = 16;
layers['waterway_line_label'].layout['symbol-spacing'] = ['interpolate', ['linear'], ['zoom'], 15, 250, 17, 400];

// POI zoom tiers: top-ranked from z6, next from z16, rest from z17.
const CLUTTER = [
  'bollard', 'waste_basket', 'gate', 'lift_gate', 'entrance', 'bench',
  'drinking_water', 'recycling', 'telephone', 'fire_hydrant', 'surveillance',
  'traffic_signal', 'stop_sign', 'speed_camera', 'litter_bin',
];
const POI_COLOR = [
  'match', ['get', 'class'],
  ['park', 'garden', 'pitch', 'playground'], 'hsl(103, 53%, 49%)',
  'rgb(139, 139, 139)',
];
for (const [id, minzoom] of [['poi_r1', 6], ['poi_r7', 16], ['poi_r20', 17]]) {
  const layer = layers[id];
  layer.minzoom = minzoom;
  layer.filter = ['all', layer.filter, ['!', ['match', ['get', 'class'], CLUTTER, true, false]]];
  layer.layout['icon-size'] = 0.6;
  layer.layout['text-size'] = ['step', ['zoom'], 5, 17, 13];
  layer.paint['icon-opacity'] = ['step', ['zoom'], 0.5, 17, 0.7];
  layer.paint['text-color'] = POI_COLOR;
}

// Borrow Liberty's 3D buildings, styled like the old extrusion, and place it
// after all roads/bridges but before labels (matching the old layer order).
const b3d = { ...liberty.layers.find((l) => l.id === 'building-3d') };
b3d.paint = {
  'fill-extrusion-color': 'rgb(208, 189, 161)',
  'fill-extrusion-height': ['get', 'render_height'],
  'fill-extrusion-base': ['get', 'render_min_height'],
  'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 16, 0.2],
};
b3d.minzoom = 13;
const pos = s.layers.findIndex((l) => l.type === 'symbol');
s.layers.splice(pos, 0, b3d);

s.name = 'RailRouter SG (OpenFreeMap Bright)';
const out = path.join(ROOT, 'src/basemap-style.json');
await fs.writeFile(out, JSON.stringify(s, null, 2) + '\n');
console.log(`wrote ${path.relative(ROOT, out)} (${s.layers.length} layers)`);
