import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildLinks,
  extractLtgSlugs,
  extractSbsStations,
  extractSmrtStations,
  sbsUrl,
  sgtrainsUrl,
  slugForName,
  smrtUrl,
} from './build-station-links.mjs';

test('slugForName builds the Land Transport Guru page slug', () => {
  assert.equal(slugForName('Ang Mo Kio'), 'ang-mo-kio-station');
  assert.equal(slugForName('Dhoby Ghaut'), 'dhoby-ghaut-station');
  assert.equal(slugForName('  Bras Basah '), 'bras-basah-station');
});

test('sgtrainsUrl maps each line prefix to its line page and appends the code', () => {
  assert.equal(sgtrainsUrl('NS10'), 'https://www.sgtrains.com/network-nsl.html#NS10');
  assert.equal(sgtrainsUrl('EW4'), 'https://www.sgtrains.com/network-ewl.html#EW4');
  assert.equal(sgtrainsUrl('CG2'), 'https://www.sgtrains.com/network-ewl.html#CG2');
  assert.equal(sgtrainsUrl('DT35'), 'https://www.sgtrains.com/network-dtl.html#DT35');
  assert.equal(sgtrainsUrl('BP6'), 'https://www.sgtrains.com/network-bplrt.html#BP6');
  assert.equal(sgtrainsUrl('SE3'), 'https://www.sgtrains.com/network-sklrt.html#SE3');
  assert.equal(sgtrainsUrl('PE1'), 'https://www.sgtrains.com/network-pglrt.html#PE1');
  assert.equal(sgtrainsUrl('STC'), undefined);
});

test('sbsUrl encodes the line as a form value and the station code', () => {
  assert.equal(
    sbsUrl('DTL', 'BKP'),
    'https://www.sbstransit.com.sg/Service/TrainInformation?TrainLine=DTL&Station=BKP',
  );
  assert.equal(
    sbsUrl('SKG LRT', 'SE1'),
    'https://www.sbstransit.com.sg/Service/TrainInformation?TrainLine=SKG+LRT&Station=SE1',
  );
});

test('smrtUrl lowercases and encodes the station name', () => {
  assert.equal(
    smrtUrl('Ang Mo Kio'),
    'https://journey.smrt.com.sg/journey/station_info/ang%20mo%20kio/map/',
  );
});

test('extractLtgSlugs reads station links from a line page', () => {
  const html = `
    <a href="https://landtransportguru.net/admiralty-station/">A</a>
    <a href="http://landtransportguru.net/cheng-lim-station">B</a>
    <a href="https://landtransportguru.net/train/nsl/">Not a station</a>`;
  assert.deepEqual([...extractLtgSlugs(html)].sort(), ['admiralty-station', 'cheng-lim-station']);
});

test('extractSmrtStations reads and normalises journey links', () => {
  const html = `
    <a href="http://journey.smrt.com.sg/journey/station_info/admiralty/map/"></a>
    <a href="http://journey.smrt.com.sg/journey/station_info/ang mo kio/map/"></a>
    <a href="http://journey.smrt.com.sg/journey/station_info/kaki bukit /map/"></a>`;
  assert.deepEqual([...extractSmrtStations(html)].sort(), [
    'admiralty',
    'ang mo kio',
    'kaki bukit',
  ]);
});

test('extractSbsStations skips the placeholder and loop section rows', () => {
  const html = `
    <option value="">Select a station</option>
    <option value="STCE">Sengkang LRT East Loop</option>
    <option value="SE1">Compassvale</option>
    <option value="PTCW">Punggol LRT West Loop</option>
    <option value="PW1">Sam Kee</option>`;
  const stations = extractSbsStations(html);
  assert.equal(stations.get('compassvale'), 'SE1');
  assert.equal(stations.get('sam kee'), 'PW1');
  assert.equal(stations.size, 2);
});

test('buildLinks picks the first line that has a page and omits missing sources', () => {
  const stations = [
    { name: 'Newton', station_codes: 'NS21-DT11' },
    { name: 'Rochor', station_codes: 'DT13' },
  ];
  const sources = {
    ltg: new Set(['newton-station', 'rochor-station']),
    smrt: new Set(['newton']),
    sbs: new Map([['DTL', new Map([['newton', 'NEW'], ['rochor', 'RCR']])]]),
  };
  const links = buildLinks(stations, sources);
  assert.deepEqual(links['NS21-DT11'], {
    ltg: 'https://landtransportguru.net/newton-station/',
    sgtrains: 'https://www.sgtrains.com/network-nsl.html#NS21',
    sbs: 'https://www.sbstransit.com.sg/Service/TrainInformation?TrainLine=DTL&Station=NEW',
    smrt: 'https://journey.smrt.com.sg/journey/station_info/newton/map/',
  });
  assert.deepEqual(links['DT13'], {
    ltg: 'https://landtransportguru.net/rochor-station/',
    sgtrains: 'https://www.sgtrains.com/network-dtl.html#DT13',
    sbs: 'https://www.sbstransit.com.sg/Service/TrainInformation?TrainLine=DTL&Station=RCR',
  });
});
