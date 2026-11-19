// Tamil complex-text shaping, ported from https://github.com/wipfli/maplibre-gl-complex-text
// (MIT). Uses the `harfbuzzjs` npm package; the Noto font is OFL.
//
// Mapbox GL JS v3 removed setRTLTextPlugin and hardcodes an Arabic-only ICU
// shaper. This module reproduces the plugin's shaping step so Tamil station
// labels can be pre-encoded into the custom PGF glyph ranges.
import * as hb from 'harfbuzzjs';

// Split into Tamil runs and everything else, preserving order.
function splitRuns(input) {
  const runs = [];
  const re = /(\p{Script=Tamil}+(?:[\u200C\u200D]\p{Script=Tamil}+)*)/gu;
  let last = 0;
  for (const match of input.matchAll(re)) {
    if (match.index > last) runs.push({ tamil: false, text: input.slice(last, match.index) });
    runs.push({ tamil: true, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < input.length) runs.push({ tamil: false, text: input.slice(last) });
  return runs;
}

export async function createTamilShaper(loadAsset) {
  const [fontBase64, csvText] = await Promise.all([
    loadAsset(new URL('./NotoSansTamil-Regular-without-glyf.ttf.base64.txt', import.meta.url), 'text'),
    loadAsset(new URL('./NotoSansTamil-Regular-v1.multiscript.csv', import.meta.url), 'text'),
  ]);

  const binary = atob(String(fontBase64).trim());
  const fontBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) fontBytes[i] = binary.charCodeAt(i);
  const font = new hb.Font(new hb.Face(new hb.Blob(fontBytes)));
  font.setScale(1000, 1000);

  const encoding = new Map();
  for (const line of String(csvText).trim().split('\n').slice(1)) {
    const [index, xOffset, yOffset, xAdvance, yAdvance, codepoint] = line.split(',');
    encoding.set(`${index}/${xOffset}/${yOffset}/${xAdvance}/${yAdvance}`, +codepoint);
  }

  function codepointFor(glyph) {
    const base = `${glyph.g}/${glyph.dx}/${glyph.dy}/${glyph.ax}/${glyph.ay}`;
    return encoding.get(base)
      ?? encoding.get(`${glyph.g}/${glyph.dx}/${glyph.dy}/${glyph.ax + 1}/${glyph.ay}`)
      ?? encoding.get(`${glyph.g}/${glyph.dx}/${glyph.dy}/${glyph.ax - 1}/${glyph.ay}`)
      ?? -1;
  }

  function shape(text) {
    const buffer = new hb.Buffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hb.shape(font, buffer);
    const infos = buffer.getGlyphInfos();
    const positions = buffer.getGlyphPositions();
    return infos.map((info, i) => ({
      g: info.codepoint,
      dx: Math.round(positions[i].xOffset / 64),
      dy: Math.round(positions[i].yOffset / 64),
      ax: Math.round(positions[i].xAdvance / 64),
      ay: Math.round(positions[i].yAdvance / 64),
    })).map(codepointFor).filter((cp) => cp !== -1);
  }

  function applyArabicShaping(input) {
    if (!input) return input;
    let result = '';
    for (const run of splitRuns(input)) {
      if (!run.tamil) {
        result += run.text;
        continue;
      }
      const codepoints = shape(run.text);
      result += codepoints.length ? String.fromCharCode(...codepoints) : run.text;
    }
    return result;
  }

  function processBidirectionalText(input, lineBreakPoints) {
    if (!input || !lineBreakPoints || lineBreakPoints.length === 0) return [input];
    const lines = [];
    let start = 0;
    for (const point of lineBreakPoints) {
      lines.push(input.slice(start, point));
      start = point;
    }
    if (start < input.length) lines.push(input.slice(start));
    return lines;
  }

  return { applyArabicShaping, processBidirectionalText, shape };
}
