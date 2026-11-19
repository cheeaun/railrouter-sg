// Deterministic check: does this project actually shape Tamil on the map?
// "RTL support" is not evidence — Tamil is an Indic abugida, not RTL. This
// checks the installed mapbox-gl's own shaping implementation, and, for v3,
// exercises the ported HarfBuzz shaper with a known Tamil word and verifies
// the output codepoints come from the custom PGF glyph encoding.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'node_modules/mapbox-gl/package.json'), 'utf8')).version;
const major = Number(version.split('.')[0]);
const evidence = [];

const loadAsset = async (url, kind) => {
  const buffer = await fs.readFile(url);
  return kind === 'text' ? buffer.toString('utf8') : buffer;
};

if (major >= 3) {
  const devBundle = await fs.readFile(path.join(root, 'node_modules/mapbox-gl/dist/mapbox-gl-dev.js'), 'utf8');
  const extractBody = (fnName) => {
    const start = devBundle.indexOf(`function ${fnName}(`);
    if (start === -1) throw new Error(`${fnName} not found in mapbox-gl ${version}`);
    return devBundle.slice(start, devBundle.indexOf('\n}', start) + 2);
  };
  const ranges = [...extractBody('charInSupportedScript').matchAll(/char\s*>=\s*(\d+)\s*&&\s*char\s*<=\s*(\d+)/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  const builtInSupportsTamil = !ranges.some(([lo, hi]) => 0x0b80 >= lo && 0x0b80 <= hi);

  evidence.push(`mapbox-gl ${version}: built-in shaper supports Tamil = ${builtInSupportsTamil} (${JSON.stringify(ranges)} excluded)`);
  evidence.push('setRTLTextPlugin present: ' + devBundle.includes('setRTLTextPlugin'));

  const appSource = await fs.readFile(path.join(root, 'src/index.js'), 'utf8');
  const shaperImported = appSource.includes("from './complex-text/shaper.js'");
  const labelUsesShapedField = appSource.includes("['get', 'name_ta_shaped']");
  const csv = await fs.readFile(path.join(root, 'src/complex-text/NotoSansTamil-Regular-v1.multiscript.csv'), 'utf8');
  const glyphRanges = [...new Set(csv.trim().split('\n').slice(1).map((line) => Math.floor(+line.split(',')[5] / 256) * 256))];
  const glyphFiles = glyphRanges.map((start) => `${start}-${start + 255}.pbf`);
  const glyphsPresent = await Promise.all(glyphFiles.map(async (name) => {
    try { await fs.access(path.join(root, 'src/glyphs', name)); return true; } catch { return false; }
  }));
  const selfHosted = glyphsPresent.every(Boolean) && !appSource.includes('wipfli.github.io/pgf-glyph-ranges');
  evidence.push(`ported HarfBuzz shaper imported: ${shaperImported}`);
  evidence.push(`Tamil label layer uses pre-shaped property: ${labelUsesShapedField}`);
  evidence.push(`self-hosted PGF glyphs: ${glyphFiles.join(', ')} (all present: ${glyphsPresent.every(Boolean)}, no external URL: ${!appSource.includes('wipfli.github.io/pgf-glyph-ranges')})`);

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
} else {
  const devBundle = await fs.readFile(path.join(root, 'node_modules/mapbox-gl/dist/mapbox-gl.js'), 'utf8');
  const hasPluginApi = /\bsetRTLTextPlugin\s*[:=(]/.test(devBundle);
  const appSource = await fs.readFile(path.join(root, 'src/index.js'), 'utf8');
  const appRegistersPlugin = /setRTLTextPlugin\(\s*['"][^'"]*complex-text/.test(appSource);
  evidence.push(`mapbox-gl ${version}: setRTLTextPlugin present = ${hasPluginApi}`);
  evidence.push(`app registers complex-text plugin: ${appRegistersPlugin}`);
  console.log(evidence.map((line) => `  ${line}`).join('\n'));
  if (!hasPluginApi || !appRegistersPlugin) {
    console.error('\nFAIL: Tamil complex shaping is not wired up.');
    process.exit(1);
  }
  console.log('\nPASS: Tamil complex shaping is provided by the external plugin.');
}
