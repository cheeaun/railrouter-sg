const fs = require('fs');
const got = require('got');
const yauzl = require('yauzl');
const parser = require('fast-xml-parser');

(async () => {
  const res = await got('https://data.gov.sg/dataset/lta-mrt-station-exit');
  const url = 'https://data.gov.sg' + (res.body.match(/\/dataset\/[^\/]+\/download/i) || [])[0];
  const { body } = await got(url, { encoding: null });
  yauzl.fromBuffer(body, (err, zipfile) => {
    zipfile.on('entry', (entry) => {
      if (/kml$/i.test(entry.fileName)) {
        zipfile.openReadStream(entry, function(err, readStream) {
          if (err) throw err;
          let content = '';
          readStream.on('data', (d) => {
            content += d;
          });
          readStream.on('end', () => {
            const data = parser.parse(content);
            const filePath = `data/v2/stops.json`;
            fs.writeFile(filePath, JSON.stringify(data, null, '\t'), (e) => {
              if (e) throw e;
              console.log('JSON file generated: ' + filePath);
            });
          });
        });
      }
    });
  });
})();
