// Verifies the self-hosted PBFs match the pinned commit and checks whether a
// newer upstream version exists. Runs after `npm install` (see package.json).
// Never fails the install: a missing network is only a warning.
// Use --strict to exit 1 when files are stale/missing or an update is available.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getLatestCommit, readManifest, sha256 } from './pgf-upstream.mjs';

const root = path.resolve(import.meta.dirname, '..');
const strict = process.argv.includes('--strict');
const warn = (message) => console.warn(`[pgf-glyphs] ${message}`);
let stale = false;

const manifest = await readManifest();
if (!manifest?.sha || !manifest?.files) {
  warn('no pinned glyph manifest; run `npm run fetch-glyphs`.');
  process.exit(strict ? 1 : 0);
}

for (const [name, expected] of Object.entries(manifest.files)) {
  try {
    const buffer = await fs.readFile(path.join(root, 'src/glyphs', name));
    if (sha256(buffer) !== expected) {
      warn(`${name} does not match the pinned hash; run \`npm run fetch-glyphs\`.`);
      stale = true;
    }
  } catch {
    warn(`${name} is missing; run \`npm run fetch-glyphs\`.`);
    stale = true;
  }
}

let latest;
try {
  latest = await getLatestCommit();
} catch (error) {
  warn(`could not check upstream (${error.message}); continuing.`);
  process.exit(0);
}

const update = latest.sha !== manifest.sha;
if (process.argv.includes('--verbose') && !update && !stale) {
  console.log(`[pgf-glyphs] pinned ${manifest.sha.slice(0, 7)}, upstream unchanged`);
}

if (update) {
  console.warn(
    `[pgf-glyphs] New upstream version available: ${latest.sha.slice(0, 7)} (${latest.date})\n` +
    `[pgf-glyphs]   ${latest.message}\n` +
    `[pgf-glyphs]   ${latest.url}\n` +
    `[pgf-glyphs] Run \`npm run fetch-glyphs -- --update\` to pin and download it.`,
  );
}

if (strict && (stale || update)) process.exit(1);
