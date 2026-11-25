#!/usr/bin/env node
/**
 * Builds src/station-links.json: for every station in src/sg-rail.geo.json, the
 * deep link to its page on each reputable external source. The station sidebar
 * renders these under the Wikipedia section as "External links".
 *
 * Sources:
 *   - Land Transport Guru: https://landtransportguru.net/<slug>-station/
 *   - SGTrains:            https://www.sgtrains.com/network-<line>.html#<code>
 *                          (SGTrains has no per-station pages; the line page's
 *                          station selector reads the URL hash, so #<code> opens
 *                          that station's details)
 *   - SBS Transit:         https://www.sbstransit.com.sg/Service/TrainInformation?TrainLine=<line>&Station=<code>
 *                          (only the lines SBS operates: DTL, NEL, SK LRT, PG LRT)
 *   - SMRT:                https://journey.smrt.com.sg/journey/station_info/<name>/map/
 *                          (only the stations SMRT operates)
 *
 * A source is omitted for a station when it has no page there, so the sidebar
 * never links to a page that does not exist.
 *
 * The output is deterministic (sorted station keys, fixed source order, no
 * timestamps) so rerunning with an unchanged set of pages produces the same
 * file.
 *
 * Usage:
 *   node scripts/build-station-links.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAIL_FILE = path.join(ROOT, 'src', 'sg-rail.geo.json');
const OUT_FILE = path.join(ROOT, 'src', 'station-links.json');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const LTG_BASE = 'https://landtransportguru.net';
const LTG_LINES = ['nsl', 'ewl', 'nel', 'ccl', 'dtl', 'tel', 'bplrt', 'sklrt', 'pglrt', 'jrl', 'crl'];

const SGTRAINS_BASE = 'https://www.sgtrains.com';
const SGTRAINS_LINE_BY_PREFIX = {
  NS: 'nsl',
  EW: 'ewl',
  CG: 'ewl',
  NE: 'nel',
  CC: 'ccl',
  DT: 'dtl',
  TE: 'tel',
  BP: 'bplrt',
  SE: 'sklrt',
  SW: 'sklrt',
  PE: 'pglrt',
  PW: 'pglrt',
};

const SBS_BASE = 'https://www.sbstransit.com.sg';
const SBS_LINES = ['DTL', 'NEL', 'SKG LRT', 'PGL LRT'];
const SBS_LINE_BY_PREFIX = {
  DT: 'DTL',
  NE: 'NEL',
  SE: 'SKG LRT',
  SW: 'SKG LRT',
  PE: 'PGL LRT',
  PW: 'PGL LRT',
};

const SMRT_BASE = 'https://www.smrt.com.sg';
const SMRT_STATION_PAGE = `${SMRT_BASE}/public-transport/train-information/station-info-facilities/`;

// Matches "<something>-station" links on a Land Transport Guru line page.
const LTG_STATION_RE = /href="(?:https?:)?\/\/landtransportguru\.net\/([a-z0-9-]+-station)\/?"/g;
// Matches the SMRT journey planner station links on the station-info page.
const SMRT_STATION_RE = /journey\/station_info\/([^/"']+)\/map\//g;
// Matches <option value="CODE">Name</option> in the SBS dropdown HTML.
const SBS_OPTION_RE = /<option value="([^"]+)">([^<]+)<\/option>/g;

export function slugForName(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug}-station`;
}

export function sgtrainsLineForCode(code) {
  const match = String(code).match(/^[A-Z]+/);
  return match ? SGTRAINS_LINE_BY_PREFIX[match[0]] : undefined;
}

export function sbsLineForCode(code) {
  const match = String(code).match(/^[A-Z]+/);
  return match ? SBS_LINE_BY_PREFIX[match[0]] : undefined;
}

export function sgtrainsUrl(code) {
  const line = sgtrainsLineForCode(code);
  return line ? `${SGTRAINS_BASE}/network-${line}.html#${code}` : undefined;
}

export function sbsUrl(line, code) {
  const trainLine = encodeURIComponent(line).replace(/%20/g, '+');
  return `${SBS_BASE}/Service/TrainInformation?TrainLine=${trainLine}&Station=${encodeURIComponent(code)}`;
}

export function smrtUrl(name) {
  return `https://journey.smrt.com.sg/journey/station_info/${encodeURIComponent(
    String(name).trim().toLowerCase(),
  )}/map/`;
}

// Normalises a station name for cross-source lookup.
export function normaliseName(name) {
  return String(name).trim().toLowerCase();
}

export function extractLtgSlugs(html) {
  return new Set([...String(html).matchAll(LTG_STATION_RE)].map((match) => match[1]));
}

export function extractSmrtStations(html) {
  const names = new Set();
  for (const match of String(html).matchAll(SMRT_STATION_RE)) {
    const name = normaliseName(decodeURIComponent(match[1]));
    if (name) names.add(name);
  }
  return names;
}

export function extractSbsStations(html) {
  const stations = new Map();
  for (const match of String(html).matchAll(SBS_OPTION_RE)) {
    const code = match[1].trim();
    const name = normaliseName(match[2]);
    // Skip the placeholder and the "Sengkang LRT East Loop" style section rows.
    if (!code || !name || /^[A-Z]{2,4}(CE|CW)$/.test(code)) continue;
    stations.set(name, code);
  }
  return stations;
}

// Builds the per-source link map for every station feature.
export function buildLinks(stations, sources) {
  const links = {};
  for (const properties of stations) {
    const { station_codes: stationCodes, name } = properties;
    const codes = stationCodes.split('-');
    const found = {};

    if (sources.ltg.has(slugForName(name))) {
      found.ltg = `${LTG_BASE}/${slugForName(name)}/`;
    }

    const sgtrainsCode = codes.find((code) => sgtrainsLineForCode(code));
    if (sgtrainsCode) {
      found.sgtrains = sgtrainsUrl(sgtrainsCode);
    }

    const sbsMatch = codes
      .map((code) => {
        const line = sbsLineForCode(code);
        if (!line) return undefined;
        const sbsCode = sources.sbs.get(line)?.get(normaliseName(name));
        return sbsCode ? sbsUrl(line, sbsCode) : undefined;
      })
      .find(Boolean);
    if (sbsMatch) {
      found.sbs = sbsMatch;
    }

    if (sources.smrt.has(normaliseName(name))) {
      found.smrt = smrtUrl(name);
    }

    if (Object.keys(found).length) {
      links[stationCodes] = found;
    }
  }
  return links;
}

export function serialise(links) {
  const ordered = {};
  for (const key of Object.keys(links).sort()) {
    ordered[key] = links[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'user-agent': USER_AGENT, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchLtgSlugs() {
  const slugs = new Set();
  for (const line of LTG_LINES) {
    try {
      const html = await fetchText(`${LTG_BASE}/train/${line}/`);
      for (const slug of extractLtgSlugs(html)) slugs.add(slug);
    } catch (error) {
      console.warn(`! Land Transport Guru ${line}: ${error.message}`);
    }
  }
  return slugs;
}

async function fetchSbsStations() {
  const byLine = new Map();
  for (const line of SBS_LINES) {
    const body = new URLSearchParams({ trainLine: line });
    try {
      const html = await fetchText(`${SBS_BASE}/Ajax/StationDropdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      byLine.set(line, extractSbsStations(html));
    } catch (error) {
      console.warn(`! SBS Transit ${line}: ${error.message}`);
    }
  }
  return byLine;
}

async function main() {
  const geojson = JSON.parse(await fs.readFile(RAIL_FILE, 'utf8'));
  const stations = geojson.features
    .map((feature) => feature.properties)
    .filter((properties) => properties.stop_type === 'station');

  const [ltg, smrtHtml, sbs] = await Promise.all([
    fetchLtgSlugs(),
    fetchText(SMRT_STATION_PAGE),
    fetchSbsStations(),
  ]);
  const smrt = extractSmrtStations(smrtHtml);

  const links = buildLinks(stations, { ltg, smrt, sbs });
  await fs.writeFile(OUT_FILE, serialise(links));

  const counts = { ltg: 0, sgtrains: 0, sbs: 0, smrt: 0 };
  for (const stationLinks of Object.values(links)) {
    for (const key of Object.keys(counts)) if (stationLinks[key]) counts[key] += 1;
  }
  console.log(`Wrote ${Object.keys(links).length} stations to ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`  ${counts.ltg} Land Transport Guru, ${counts.sgtrains} SGTrains, ${counts.sbs} SBS Transit, ${counts.smrt} SMRT`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
