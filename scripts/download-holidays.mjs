#!/usr/bin/env node
/**
 * Downloads Singapore's public holidays from data.gov.sg and writes
 * src/public-holidays.json for the runtime timetable overlay.
 *
 * The dataset is MOM's consolidated list. It already includes the observed
 * dates for holidays that fall on a Sunday (for example, National Day 2026 is
 * both 9 August and the observed holiday on 10 August), which is exactly what
 * the train timetable needs.
 *
 * Usage:
 *   node scripts/download-holidays.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_FILE = path.join(ROOT, 'src', 'public-holidays.json');
const DATASET_ID = 'd_8ef23381f9417e4d4254ee8b4dcdb176';
const API_URL = 'https://data.gov.sg/api/action/datastore_search';

// Keep the JSON ordered and free of duplicates so rerunning produces the same
// file, and so the runtime can turn the list straight into a Set.
export function parseHolidayDates(records) {
  const dates = new Set();
  for (const record of records) {
    const date = String(record?.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const parsed = new Date(`${date}T00:00:00Z`);
    // Reject impossible/rolled-over dates such as 2026-02-30.
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) continue;
    dates.add(date);
  }
  return [...dates].sort();
}

async function main() {
  const url = `${API_URL}?resource_id=${encodeURIComponent(DATASET_ID)}&limit=10000`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`data.gov.sg returned HTTP ${response.status}`);

  const payload = await response.json();
  if (!payload.success) throw new Error(`data.gov.sg request failed: ${payload.errorMsg || 'unknown error'}`);

  const records = payload.result?.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('data.gov.sg returned no public-holiday records');
  }

  const dates = parseHolidayDates(records);
  if (dates.length === 0) throw new Error('No valid public-holiday dates found');

  const json =
    JSON.stringify(
      {
        source: API_URL,
        dataset: DATASET_ID,
        dates,
      },
      null,
      2,
    ) + '\n';
  await fs.writeFile(OUT_FILE, json);

  const years = [...new Set(dates.map((date) => date.slice(0, 4)))];
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`  ${dates.length} dates covering ${years[0]}-${years.at(-1)} (${years.length} years)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
