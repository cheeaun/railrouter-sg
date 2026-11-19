// Download the PGF glyph-range PBFs needed by the Tamil shaper.
// Files are always fetched from a pinned upstream commit (never `main`), and
// their hashes are recorded in scripts/pgf-glyphs-upstream.json.
// Usage:
//   npm run fetch-glyphs                # restore from the pinned commit
//   npm run fetch-glyphs -- --update    # pin the latest upstream commit, download, re-record
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getLatestCommit,
  readManifest,
  writeManifest,
  rawGlyphUrl,
  sha256,
} from './pgf-upstream.mjs';

const root = path.resolve(import.meta.dirname, '..');
const csvPath = path.join(root, 'src/complex-text/NotoSansTamil-Regular-v1.multiscript.csv');
const outDir = path.join(root, 'src/glyphs');
const update = process.argv.includes('--update') || process.argv.includes('--force');

const csv = await fs.readFile(csvPath, 'utf8');
const ranges = [...new Set(csv.trim().split('\n').slice(1).map((line) => Math.floor(+line.split(',')[5] / 256) * 256))].sort((a, b) => a - b);
const filenames = ranges.map((start) => `${start}-${start + 255}.pbf`);

const manifest = await readManifest();
const target = update ? await getLatestCommit() : manifest?.sha ? { sha: manifest.sha, message: 'pinned', url: '' } : await getLatestCommit();
console.log(`using upstream commit ${target.sha.slice(0, 7)}${update ? ' (latest)' : ''}`);

await fs.mkdir(outDir, { recursive: true });
const files = {};
for (const name of filenames) {
  const targetPath = path.join(outDir, name);
  let buffer;
  try {
    buffer = await fs.readFile(targetPath);
  } catch {
    buffer = null;
  }
  const expected = update ? null : manifest?.files?.[name];
  if (buffer && expected && sha256(buffer) === expected) {
    console.log(`skip ${name} (matches pinned hash)`);
    files[name] = expected;
    continue;
  }
  process.stdout.write(`download ${name} from ${target.sha.slice(0, 7)} ... `);
  const response = await fetch(rawGlyphUrl(target.sha, name));
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${rawGlyphUrl(target.sha, name)}`);
  buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(targetPath, buffer);
  files[name] = sha256(buffer);
  console.log(`${buffer.length} bytes (sha256 ${files[name].slice(0, 12)})`);
}

await writeManifest({
  sha: target.sha,
  message: target.message,
  date: target.date,
  url: target.url,
  files,
});
console.log(`wrote scripts/pgf-glyphs-upstream.json`);
