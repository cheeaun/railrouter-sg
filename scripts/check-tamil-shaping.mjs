// Deterministic check: does this project actually shape Tamil on the map?
// "RTL support" is not evidence — Tamil is an Indic abugida, not RTL. This
// checks that the app wires in the ported HarfBuzz shaper, serves its custom
// PGF glyph ranges locally, and produces valid PGF-encoded output.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const evidence = [];

const loadAsset = async (url, kind) => {
  const buffer = await fs.readFile(url);
  return kind === 'text' ? buffer.toString('utf8') : buffer;
};

const appSource = await fs.readFile(path.join(root, 'src/index.js'), 'utf8');
const shaperImported = appSource.includes("from './complex-text/shaper.js'");
const labelUsesShapedField = appSource.includes("['get', 'name_ta_shaped']");
const csv = await fs.readFile(
  path.join(root, 'src/complex-text/NotoSansTamil-Regular-v1.multiscript.csv'),
  'utf8',
);
const glyphRanges = [
  ...new Set(csv.trim().split('\n').slice(1).map((line) => Math.floor(+line.split(',')[5] / 256) * 256)),
];
const glyphFiles = glyphRanges.map((start) => `${start}-${start + 255}.pbf`);
const glyphsPresent = await Promise.all(
  glyphFiles.map(async (name) => {
    try {
      await fs.access(path.join(root, 'src/glyphs', name));
      return true;
    } catch {
      return false;
    }
  }),
);
const selfHosted = glyphsPresent.every(Boolean) && !appSource.includes('wipfli.github.io/pgf-glyph-ranges');

evidence.push(`ported HarfBuzz shaper imported: ${shaperImported}`);
evidence.push(`Tamil label layer uses pre-shaped property: ${labelUsesShapedField}`);
evidence.push(
  `self-hosted PGF glyphs: ${glyphFiles.join(', ')} (all present: ${glyphsPresent.every(Boolean)}, no external URL: ${!appSource.includes('wipfli.github.io/pgf-glyph-ranges')})`,
);

const { createTamilShaper } = await import('../src/complex-text/tamil-shaper.js');
const shaper = await createTamilShaper(loadAsset);
const input = 'தமிழ்'; // "Tamil" in Tamil
const shaped = shaper.applyArabicShaping(input);
const encodedCodepoints = new Set(csv.trim().split('\n').slice(1).map((line) => +line.split(',')[5]));
const allPGF = [...shaped].every((ch) => encodedCodepoints.has(ch.codePointAt(0)));
const passed = shaperImported && labelUsesShapedField && selfHosted && shaped !== input && allPGF;

evidence.push(`shaper output for ${JSON.stringify(input)}: ${JSON.stringify(shaped)}`);
evidence.push(`all output codepoints are in the PGF glyph encoding: ${allPGF}`);

console.log(evidence.map((line) => `  ${line}`).join('\n'));
if (!passed) {
  console.error('\nFAIL: Tamil complex shaping is not wired up.');
  process.exit(1);
}
console.log('\nPASS: Tamil complex shaping is provided by the ported HarfBuzz shaper.');
