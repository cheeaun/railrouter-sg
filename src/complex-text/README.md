# Tamil complex-text shaping

Ported (Tamil subset) from [wipfli/maplibre-gl-complex-text](https://github.com/wipfli/maplibre-gl-complex-text) (MIT). Mapbox GL JS v3 removed the RTL plugin hook that project relies on, so the shaping step is called directly on the app's GeoJSON station labels before they reach the label layer.

HarfBuzz comes from the [`harfbuzzjs`](https://www.npmjs.com/package/harfbuzzjs) npm package (MIT). The upstream plugin inlined an older `hbjs.js` + `hb.wasm` because that version of the wrapper was not published in a browser-friendly form; the current npm release needs the `process` browser polyfill (see `package.json`) but avoids vendoring ~330 KB of generated code.

Still vendored from upstream:

- `NotoSansTamil-Regular-without-glyf.ttf.base64.txt` — SIL OFL
- `NotoSansTamil-Regular-v1.multiscript.csv` — MIT

The two PBF glyph-range files needed for Tamil are self-hosted in `src/glyphs/` and served through the `transformRequest` hook in `src/index.js`. `scripts/pgf-glyphs-upstream.json` pins the upstream commit and the SHA-256 of each file; downloads always come from that pinned commit, never the moving `main` branch. `npm run fetch-glyphs` restores files from the pin; `npm run fetch-glyphs -- --update` pins the latest upstream commit and re-downloads. `postinstall` checks file integrity and warns when upstream has a newer commit (`--strict` makes it fail). Licence notice is in `src/glyphs/LICENSE.txt`.

Run `node scripts/check-tamil-shaping.mjs` for a deterministic check that the shaper produces valid PGF-encoded output.
