# RailRouter SG

![Screenshot of RailRouter SG](screenshots/screenshot-5.png)

![Screenshot of RailRouter SG](screenshots/screenshot-6.png)

**RailRouter SG** is a **progressive web app** that lets you explore MRT and LRT rail routes in Singapore.

It was built to [scratch my curiosity itch](https://twitter.com/cheeaun/status/683495506031448064) for comparing the _real_ route lines VS the lines shown on Google Maps, which I personally find too _straight_ and skews the perception of how trains actually travel in the real world.

Available features:

- **Real** rail route lines, for all train routes.
- Show station names in Chinese and Tamil, besides English.
- Show station building structures, both underground and aboveground.
- Show location of exits (a.k.a. entrances) for (almost) all stations.
- Show train arrival times for _some_ stations.
- Possibly, **works offline**.

## Previously

![Screenshot of RailRouter SG](screenshots/screenshot-2.png)

This is the first version, using Google Maps.

## Technicalities

### For development

- `npm i` - install dependencies
- `npm start` - starts the server
- `npm run build` - builds the production assets for deployment

### Data source

From my other repo: **[cheeaun/sgraildata](https://github.com/cheeaun/sgraildata)**.

### Generating station code markers

1. Go to https://codepen.io/cheeaun/full/pogQjgV
2. Paste all the train codes.
3. Click "Generate Images" button to download ZIP file of SVG images.
4. Extract files from the ZIP file.
5. Go to https://www.facetstudios.com/sprite-generator
6. Drag/Upload all SVG files to the site.
7. Uncheck "Export for retina". Check "Generate JSON".
8. Click "Download Files" button.
9. Extract files from ZIP file.
10. Move & rename sprite image to `src/stations.png`. Optimize the image with [TinyPNG](https://tinypng.com/).
11. Move & rename sprite JSON to `src/sprite.json`.
12. Run `node scripts/gen-stations-sprite.js` which will generate `src/stations.json`.

## License

Data: [© OpenStreetMap contributors](http://www.openstreetmap.org/copyright) and [OneMap](http://www.onemap.sg/home/).

Everything else: [MIT](http://cheeaun.mit-license.org/)
