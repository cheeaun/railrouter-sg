// https://github.com/parcel-bundler/parcel/issues/3375#issuecomment-599160200
import 'regenerator-runtime/runtime';

const $ = (id) => document.getElementById(id);
const $home = $('home');
const $btnCloseHome = $('btn-close-home');
const $station = $('station');
const $search = $('search');
const $searchField = $('search-field');
const $searchCancel = $('search-cancel');
const $searchResults = $('search-results');

$btnCloseHome.onclick = (e) => {
  e.preventDefault();
  localStorage['railrouter-sg:about'] = 1;
  $home.classList.remove('open');
};
if (!localStorage['railrouter-sg:about']) {
  $home.classList.add('open');
}
$('logo').onclick = () => {
  $home.classList.toggle('open');
};

import Fuse from 'fuse.js';
let fuse, stationsData;
const geojsonFetch = fetch(require('./sg-rail.geo.json'));

import mapboxgl from 'mapbox-gl';
import MapboxLanguage from '@mapbox/mapbox-gl-language';
import stationsSprite from './stations.json';
mapboxgl.accessToken =
  'pk.eyJ1IjoiY2hlZWF1biIsImEiOiJja2NydG83cWMwaGJsMnBqdjR5aHc3MzdlIn0.YGTZpi7JQMquEOv9E8K_bg';

const center = [103.8475, 1.3011];
const lowerLat = 1.23,
  upperLat = 1.475,
  lowerLong = 103.59,
  upperLong = 104.05;
const bounds = [lowerLong, lowerLat, upperLong, upperLat];

const map = (window.$map = new mapboxgl.Map({
  container: 'map',
  // style: 'mapbox://styles/cheeaun/ckco69aw60l811irt3iwr7vvg/draft',
  style: 'mapbox://styles/cheeaun/ckco69aw60l811irt3iwr7vvg',
  center,
  bounds,
  renderWorldCopies: false,
  boxZoom: false,
  dragRotate: false,
  localIdeographFontFamily:
    '"InaiMathi", "Tamil Sangam MN", "Nirmala UI", Latha, Bamini ,Roboto, Noto, "Noto Sans Tamil", sans-serif',
}));
const mapCanvas = map.getCanvas();
map.touchZoomRotate.disableRotation();

const supportedLanguages = [
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'it',
  'ja',
  'ko',
  'mul',
  'pt',
  'ru',
  'vi',
  'zh-Hans',
  'zh-Hant',
];
function browserLanguage() {
  const language = navigator.languages
    ? navigator.languages[0]
    : navigator.language || navigator.userLanguage;
  const parts = language && language.split('-');
  let languageCode = language;
  if (parts.length > 1) {
    languageCode = parts[0];
  }
  if (supportedLanguages.indexOf(languageCode) > -1) {
    return languageCode;
  }
  const closestLanguageCode = supportedLanguages.find((l) => {
    return l.startsWith(languageCode);
  });
  if (closestLanguageCode) return closestLanguageCode;
  return null;
}

map.addControl(
  new MapboxLanguage({
    defaultLanguage: browserLanguage(),
  }),
);

map.addControl(
  new mapboxgl.GeolocateControl({
    positionOptions: {
      enableHighAccuracy: true,
    },
    trackUserLocation: true,
  }),
  'bottom-right',
);

const mapLoaded = new Promise((res) => {
  map.once('load', () => {
    console.timeStamp('Map load');
    res();
  });
});

const lineColors = {
  orangered: '#d42e12',
  mediumseagreen: '#009645',
  orange: '#fa9e0d',
  saddlebrown: '#9D5B25',
  darkmagenta: '#9900aa',
  darkslateblue: '#005ec4',
  gray: '#748477',
};
const lineColorsExpression = [
  'match',
  ['get', 'line_color'],
  ...Object.keys(lineColors)
    .map((c) => [c, lineColors[c]])
    .flat(),
  '#748477',
];

function formatArriveTime(str) {
  if (/\d/.test(str)) {
    return str + ' min' + (str == '1' ? '' : 's');
  }
  return str;
}

let currentStation;
const stationView = {
  mount: (feature) => {
    const { properties, geometry } = feature;
    const {
      name,
      'name_zh-Hans': name_zh_Hans,
      name_ta,
      station_codes,
      station_colors,
      wikipedia_slug,
    } = properties;

    $station.classList.remove('min');

    const zoom = map.getZoom();
    const isScreenLarge = window.innerWidth >= 640;
    const padding = isScreenLarge
      ? { left: 320 }
      : { bottom: window.innerHeight / 2 };
    if (zoom <= 13) {
      map.jumpTo({
        center: geometry.coordinates,
        zoom: 16.5,
        pitch: 70,
        padding,
      });
    } else {
      map.easeTo({
        center: geometry.coordinates,
        zoom: 16.5,
        pitch: 70,
        padding,
        duration: 500,
      });
    }
    map.touchZoomRotate.enableRotation();

    if (station_codes === currentStation) return;

    currentStation = station_codes;
    $station.innerHTML = `
      <header>
        <span class="pill">
          ${station_codes
            .split('-')
            .map(
              (c, i) =>
                `<span class="${station_colors.split('-')[i]}">${c.replace(
                  /^([a-z]+)/i,
                  '$1 ',
                )}</span>`,
            )
            .join('')}
        </span>
        <h2>
          ${name}<br>
          <small lang="zh" class="ib">${name_zh_Hans}</small>&nbsp;&nbsp;&nbsp;
          <small lang="ta" class="ib">${name_ta}</small>
        </h2>
      </header>
      <div class="scrollable">
        <div class="arrivals"><h3>Arrival times</h3><p>Loading&hellip;</p></div>
        <div class="wikipedia"></div>
      </div>
      `;
    $station.classList.add('open');
    arrivalTimes.mount(name);
    wikipedia.mount(wikipedia_slug);
  },
  unmount: () => {
    currentStation = null;
    $station.classList.remove('open');
    $station.classList.remove('min');

    const zoom = map.getZoom();
    const isScreenLarge = window.innerWidth >= 800;
    map.easeTo({
      zoom: zoom - 1,
      pitch: 0,
      bearing: 0,
      padding: isScreenLarge ? { left: 0 } : { bottom: 0 },
      duration: 500,
    });
    map.touchZoomRotate.disableRotation();
  },
};

let arrivalTimeout;
const arrivalTimes = {
  render: (name) => {
    const $arrivals = $station.querySelector('.arrivals');
    fetch(
      `https://connectv3.smrt.wwprojects.com/smrt/api/train_arrival_time_by_id/?station=${encodeURIComponent(
        name,
      )}`,
    )
      .then((res) => res.json())
      .then(({ results }) => {
        if (!results.length) {
          throw new Error('No results');
        }
        const html = results
          .filter((result, pos, arr) => {
            // Filter weird destination names
            if (/do not board/i.test(result.next_train_destination))
              return false;
            return (
              arr.findIndex(
                (r) =>
                  r.next_train_destination == result.next_train_destination,
              ) == pos
            );
          })
          .map((result) => {
            let arrow = '⇢';
            const isWeirdName = /do not board/i.test(
              result.next_train_destination,
            );
            if (result.next_train_destination == result.mrt) {
              arrow = '⇠';
            }
            let dest = result.next_train_destination;
            if (isWeirdName) {
              if (/do not board/i.test(result.subseq_train_destination)) {
                // Weird name again
                dest = result.mrt;
                arrow = '⇠';
              } else {
                dest = result.subseq_train_destination;
              }
            }
            return `<tr>
              <td>${arrow} ${dest}</td>
              <td>${result.next_train_arr}</td>
              <td>${formatArriveTime(result.subseq_train_arr)}</td>
            </tr>`;
          })
          .join('');

        $arrivals.innerHTML = `<h3>Arrival times</h3>
        <table>
          <tbody>
            ${html}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3">
                <small>Arrival times powered by <a href="https://www.smrttrains.com.sg/" target="_blank">SMRT Trains Ltd.</a></small>
              </td>
            </tr>
          </tfoot>
        </table>`;
      })
      .catch((e) => {
        $arrivals.innerHTML = `<h3>Arrival times</h3>
          <p>No arrival times available</p>`;
      });
  },
  mount: (name) => {
    clearTimeout(arrivalTimeout);
    arrivalTimes.render(name);
    arrivalTimeout = setTimeout(() => {
      requestAnimationFrame(() => {
        arrivalTimes.render(name);
      });
    }, 30 * 1000); // every 30 seconds
  },
  unmount: () => {
    clearTimeout(arrivalTimeout);
  },
};

const wikipedia = {
  mount: (slug) => {
    const $wikipedia = $station.querySelector('.wikipedia');
    fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
        slug,
      )}`,
    )
      .then((res) => res.json())
      .then((res) => {
        const {
          content_urls: {
            desktop: { page },
          },
          extract_html,
          thumbnail: { source },
        } = res;
        const html = `<div>
          <img src="${source.replace(/\d{3,}px/i, '640px')}" alt="">
          <div class="extract">${extract_html}</div>
          <div class="more"><a href="${page}" target="_blank">Read more on Wikipedia</a></div>
        </div>`;
        $wikipedia.innerHTML = html;
      });
  },
};

(async () => {
  await mapLoaded;
  const layers = map.getStyle().layers;
  // console.log(layers);

  const labelLayerId = layers.find(
    (l) => l.type === 'symbol' && l.layout['text-field'],
  ).id;

  const data = await geojsonFetch.then((res) => res.json());
  map.addSource('rail', {
    type: 'geojson',
    data,
    buffer: 0,
  });

  // LINES
  map.addLayer(
    {
      id: 'lines-case',
      source: 'rail',
      filter: ['==', ['geometry-type'], 'LineString'],
      type: 'line',
      minzoom: 11,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 22, 30],
        'line-color': lineColorsExpression,
        'line-opacity': 0.25,
        'line-blur': ['interpolate', ['linear'], ['zoom'], 10, 0, 22, 14],
      },
    },
    'building-extrusion',
  );
  map.addLayer(
    {
      id: 'lines',
      source: 'rail',
      filter: ['==', ['geometry-type'], 'LineString'],
      type: 'line',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-width': ['interpolate', ['linear'], ['zoom'], 0, 1, 22, 2],
        'line-color': lineColorsExpression,
      },
    },
    labelLayerId,
  );
  map.addLayer({
    id: 'lines-label',
    source: 'rail',
    filter: ['==', ['geometry-type'], 'LineString'],
    type: 'symbol',
    minzoom: 13,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'name'],
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
      'text-letter-spacing': 0.1,
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 12, 22, 16],
      'text-pitch-alignment': 'viewport',
      'text-rotation-alignment': 'map',
      'text-max-angle': 30,
      'text-padding': 1,
    },
    paint: {
      'text-color': lineColorsExpression,
      'text-halo-blur': 1,
      'text-halo-color': '#fff',
      'text-halo-width': 2,
    },
  });

  // EXITS
  map.addLayer({
    id: 'exits',
    source: 'rail',
    filter: ['==', ['get', 'stop_type'], 'entrance'],
    type: 'symbol',
    minzoom: 14,
    layout: {
      'icon-image': 'exit',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.25, 17, 0.6],
      'icon-allow-overlap': true,
    },
  });
  map.addLayer({
    id: 'exits-label',
    source: 'rail',
    filter: ['==', ['get', 'stop_type'], 'entrance'],
    type: 'symbol',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 5, 17, 13],
      'text-ignore-placement': true,
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': '#000',
      'text-translate-anchor': 'viewport',
      'text-translate': [
        'interpolate',
        ['linear'],
        ['zoom'],
        14,
        ['literal', [0, 1]],
        16,
        ['literal', [0, 2]],
      ],
    },
  });

  // STATIONS
  map.addLayer({
    id: 'stations-point',
    source: 'rail',
    filter: ['==', ['get', 'stop_type'], 'station'],
    type: 'symbol',
    minzoom: 10,
    maxzoom: 14,
    layout: {
      'icon-image': ['get', 'station_colors'],
      'icon-size': [
        'interpolate',
        ['exponential', 2],
        ['zoom'],
        10,
        0.2,
        14,
        1,
      ],
      'icon-allow-overlap': true,
    },
  });
  map.addLayer({
    id: 'stations-point-label',
    source: 'rail',
    filter: [
      'all',
      ['==', ['get', 'stop_type'], 'station'],
      ['in', '-', ['get', 'station_codes']],
    ],
    type: 'symbol',
    minzoom: 10,
    maxzoom: 13,
    layout: {
      'symbol-avoid-edges': true,
      'text-field': ['get', 'name'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 13, 12],
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
      'text-variable-anchor': ['left', 'right'],
      'text-radial-offset': [
        'interpolate',
        ['linear'],
        ['zoom'],
        10,
        ['*', 0.25, ['get', 'network_count']],
        13,
        ['*', 0.5, ['get', 'network_count']],
      ],
      'text-max-width': 20,
      'text-optional': true,
    },
    paint: {
      'text-color': 'rgba(0,0,0,.5)',
      'text-halo-color': 'rgba(255,255,255,.5)',
      'text-halo-width': 1,
      'text-halo-blur': 1,
    },
  });
  map.addLayer({
    id: 'stations-label-non-en',
    source: 'rail',
    filter: ['==', ['get', 'stop_type'], 'station'],
    type: 'symbol',
    minzoom: 13,
    layout: {
      'text-field': [
        'format',
        ['get', 'name_zh-Hans'],
        {},
        '\n',
        {},
        ['get', 'name_ta'],
        {
          'text-font': ['literal', ['Noto Sans Tamil Medium']],
          // 'font-scale': 1.1, // Slightly larger text size for Tamil
        },
      ],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 12, 16, 16],
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
      'text-anchor': 'top',
      'text-offset': [0, 0.8],
      'text-max-width': 20,
      'text-optional': true,
    },
    paint: {
      'text-halo-color': '#fff',
      'text-halo-width': 2,
      'text-halo-blur': 1,
    },
  });
  map.addLayer({
    id: 'stations-label',
    source: 'rail',
    filter: ['==', ['get', 'stop_type'], 'station'],
    type: 'symbol',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'name'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 12, 16, 16],
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
      'text-anchor': 'bottom',
      'text-offset': [0, -0.8],
      'text-max-width': 20,
      // 'text-allow-overlap': true,
      'icon-image': ['get', 'station_codes'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.3, 15, 0.5],
      'icon-ignore-placement': true,
      'icon-allow-overlap': true,
    },
    paint: {
      'text-halo-color': '#fff',
      'text-halo-width': 2,
      'text-halo-blur': 1,
    },
  });

  // STATION BUILDINGS
  map.addLayer(
    {
      id: 'buildings-underground',
      source: 'rail',
      filter: [
        'all',
        ['==', ['get', 'type'], 'subway'],
        ['==', ['get', 'underground'], true],
      ],
      type: 'fill',
      minzoom: 14,
      paint: {
        'fill-antialias': false,
        'fill-color': 'hsla(6, 63%, 60%, 0.3)',
        'fill-outline-color': '#d96659',
      },
    },
    'building-extrusion',
  );
  map.addLayer(
    {
      id: 'buildings-aboveground',
      source: 'rail',
      filter: [
        'all',
        ['==', ['get', 'type'], 'subway'],
        ['==', ['get', 'underground'], false],
      ],
      type: 'fill-extrusion',
      minzoom: 14,
      paint: {
        'fill-extrusion-color': '#d96659',
        'fill-extrusion-height': 20,
        'fill-extrusion-opacity': 0.3,
      },
    },
    'building-extrusion',
  );

  // const handleSource = (e) => {
  //   if (e.sourceId !== 'rail' || e.sourceDataType === 'metadata') return;
  //   map.off('sourcedata', handleSource);

  //   const lineFeatures = map.querySourceFeatures('rail', {
  //     filter: ['==', ['geometry-type'], 'LineString'],
  //   });

  //   const linesBounds = {};
  //   lineFeatures.forEach((l) => {
  //     const {
  //       properties: { name },
  //       geometry: { type, coordinates },
  //     } = l;
  //     if (!linesBounds[name]) linesBounds[name] = new mapboxgl.LngLatBounds();
  //     coordinates.flat(type === 'LineString' ? 0 : 1).forEach((c) => {
  //       linesBounds[name].extend(c);
  //     });
  //   });
  //   console.log(lineFeatures, linesBounds);
  // };
  // map.on('sourcedata', handleSource);

  map.on('click', 'stations-label', (e) => {
    stationView.mount(e.features[0]);
  });

  document.querySelector('.sheet-close').onclick = (e) => {
    e.preventDefault();
    stationView.unmount();
  };

  map.on('movestart', (e) => {
    if (!e.originalEvent) return; // Not initiated by humans
    if (!currentStation) return;
    $station.classList.add('min');
  });

  $station.onclick = (e) => {
    if ($station.classList.contains('min')) {
      e.preventDefault();
      e.stopPropagation();
      $station.classList.remove('min');
    }
  };

  map.on('mouseenter', 'stations-label', () => {
    mapCanvas.style.cursor = 'pointer';
  });
  map.on('mouseleave', 'stations-label', () => {
    mapCanvas.style.cursor = '';
  });

  setTimeout(() => {
    map.loadImage(require('./exit.png'), (e, img) => {
      map.addImage('exit', img);
    });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    map.loadImage(require('./stations.png'), (e, img) => {
      if (!img) return;
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      stationsSprite.forEach((s) => {
        const [code, ...args] = s;
        const imageData = ctx.getImageData(...args);
        map.addImage(code, imageData);
      });
    });

    stationsData = data.features.filter((f) => {
      return f.properties.stop_type === 'station';
    });
    fuse = new Fuse(stationsData, {
      distance: 5,
      includeMatches: true,
      keys: [
        'properties.name',
        'properties.name_zh-Hans',
        'properties.name_ta',
        {
          name: 'properties.station_codes',
          weight: 0.5,
        },
      ],
    });

    map.addSource('walks', {
      type: 'geojson',
      data: require('./sg-rail-walks.geo.json'),
      buffer: 0,
    });
    map.addLayer(
      {
        id: 'walks-case',
        source: 'walks',
        filter: ['==', ['geometry-type'], 'LineString'],
        type: 'line',
        minzoom: 14,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 15, 3, 22, 15],
          'line-color': 'rgba(255, 255, 255, .75)',
        },
      },
      'building-extrusion',
    );
    map.addLayer(
      {
        id: 'walks',
        source: 'walks',
        filter: ['==', ['geometry-type'], 'LineString'],
        type: 'line',
        minzoom: 14,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1, 22, 5],
          'line-color': 'skyblue',
          'line-dasharray': [0.5, 2],
        },
      },
      'building-extrusion',
    );
    map.addLayer(
      {
        id: 'walks-label',
        source: 'walks',
        filter: ['==', ['geometry-type'], 'Point'],
        type: 'symbol',
        minzoom: 15.5,
        layout: {
          'text-field': ['concat', ['get', 'duration_min'], ' mins'],
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 12, 22, 16],
          'text-anchor': 'top',
          'text-offset': [0, 0.8],
          'icon-image': 'walk',
          'icon-size': 0.5,
        },
        paint: {
          'text-color': 'dodgerblue',
          'text-halo-color': 'rgba(255,255,255,.75)',
          'text-halo-width': 2,
          'icon-halo-color': 'rgba(255,255,255,.75)',
          'icon-halo-width': 2,
        },
      },
      'exits-label',
    );
    map.on('mouseenter', 'walks-label', () => {
      mapCanvas.style.cursor = 'pointer';
    });
    map.on('mouseleave', 'walks-label', () => {
      mapCanvas.style.cursor = '';
    });
    map.on('click', 'walks-label', (e) => {
      const f = e.features[0];
      const {
        duration_min,
        station_codes_1,
        station_codes_2,
        exit_name_1,
        exit_name_2,
      } = f.properties;
      const station1 = stationsData.find(
        (d) => d.properties.station_codes === station_codes_1,
      );
      const station2 = stationsData.find(
        (d) => d.properties.station_codes === station_codes_2,
      );
      alert(
        `${duration_min}-min walk between ${station1.properties.name} (Exit ${exit_name_1}) and ${station2.properties.name} (Exit ${exit_name_2})`,
      );
    });
    map.loadImage(require('./walk.png'), (e, img) => {
      map.addImage('walk', img);
    });
  }, 300);

  let markers = [];
  map.on('zoomend', () => {
    const zoom = map.getZoom();
    const large = zoom >= 12;
    const larger = zoom >= 15;
    markers.forEach((m) => {
      m.getElement().classList.toggle('large', large);
      m.getElement().classList.toggle('larger', larger);
    });
  });
  const renderCrowd = () => {
    markers.forEach((m) => {
      m.remove();
    });

    fetch('https://sg-rail-crowd.cheeaun.workers.dev/')
      .then((res) => res.json())
      .then((results) => {
        const zoom = map.getZoom();
        const large = zoom >= 12;
        const larger = zoom >= 15;
        const crowdedData = [];
        results.data.forEach((r) => {
          const { station, crowdLevel } = r;
          if (!crowdLevel || crowdLevel === 'l') return;
          const f = data.features.find((f) =>
            f.properties.station_codes.split('-').includes(station),
          );

          if (!f) return;

          crowdedData.push(r);

          // const markerCrowdLabel = Math.random() < 0.5 ? 'h' : 'm';
          const markerCrowdLabel = crowdLevel;

          const el = document.createElement('div');
          const width = 50;
          const height = 50;
          el.className = `crowd-marker crowd-marker-${markerCrowdLabel} ${
            large ? 'large' : ''
          } ${larger ? 'larger' : ''}`;
          el.style.width = `${width}px`;
          el.style.height = `${height}px`;

          // Add markers to the map.
          const marker = new mapboxgl.Marker(el)
            .setLngLat(f.geometry.coordinates)
            .addTo(map);
          markers.push(marker);
        });

        console.log({ crowdedData });

        setTimeout(() => {
          requestAnimationFrame(renderCrowd);
        }, 1000 * 60); // 1 minute
      });
  };
  renderCrowd();
})();

class SearchControl {
  options = {
    onClick: () => {},
  };

  constructor(options) {
    Object.assign(this.options, options);
  }

  onAdd(map) {
    this._map = map;
    const container = document.createElement('div');
    container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
    container.innerHTML = `
      <button class="mapboxgl-ctrl-emoji" type="button">
        <span>🔍</span>
      </button>
    `;
    container.querySelector('button').onclick = this.options.onClick;
    this._container = container;
    return this._container;
  }
  onRemove() {
    this._container.parentNode.removeChild(this._container);
    this._map = undefined;
  }
}
function focusSearchField() {
  $search.hidden = false;
  $searchField.focus();
  setTimeout(() => {
    $searchField.focus();
  }, 1500);
}
map.addControl(
  new SearchControl({
    onClick: focusSearchField,
  }),
  'bottom-right',
);
document.onkeydown = (e) => {
  if (/(input|textarea|select)/i.test(e.target.tagName)) return;
  if (
    e.code.toLowerCase() === 'slash' ||
    e.key === '/' ||
    e.keyCode === 191 ||
    e.which === 191
  ) {
    e.preventDefault();
    focusSearchField();
  }
};

$searchField.oninput = () => {
  if (!fuse) return;
  const value = $searchField.value.trim();
  const results = fuse.search(value);
  $searchResults.innerHTML = results
    .slice(0, 10)
    .map((r) => {
      const {
        item: { properties },
        matches,
      } = r;
      const firstNameMatch = matches.find((m) => /name/i.test(m.key));
      const { station_codes, station_colors } = properties;
      const name =
        properties[
          firstNameMatch ? firstNameMatch.key.replace(/.+\./, '') : 'name'
        ];
      const html = `<li data-codes="${station_codes}" tabindex="-1">
      <span class="pill mini">
        ${station_codes
          .split('-')
          .map(
            (c, i) =>
              `<span class="${station_colors.split('-')[i]}">${c.replace(
                /^([a-z]+)/i,
                '$1 ',
              )}</span>`,
          )
          .join('')}
      </span>
      ${name}
    </li>`;
      return html;
    })
    .join('');
};

$searchField.onkeydown = (e) => {
  // Enter
  if (e.code.toLowerCase() === 'enter' || e.keyCode === 13 || e.which === 13) {
    $searchField.blur();
    $searchResults.querySelector('li')?.click();
  }
};

$searchCancel.onclick = () => {
  $search.hidden = true;
  $searchField.value = '';
};

$searchResults.onclick = (e) => {
  const { target } = e;
  if (target.tagName.toLowerCase() !== 'li') return;
  const { codes } = target.dataset;
  const feature = stationsData.find(
    (d) => d.properties.station_codes === codes,
  );
  stationView.mount(feature);
  $search.hidden = true;
  $searchField.value = '';
  document.body.scrollTo(0, 0);
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), {
      type: 'module',
    });
  });
}
