const fs = require('fs');
const got = require('got');

fs.readdir('data/v2', (e, files) => {
  files
    .filter(f => /^[lm]rt-/.test(f))
    .map(async (f) => {
      const { stops } = JSON.parse(fs.readFileSync(`data/v2/${f}`));
      const ids = Object.keys(stops).join(',');
      const { body } = await got(`https://citymapper.com/api/3/stopinfo?ids=${ids}&region_id=sg-singapore`, {
        json: true,
      });
      const filePath = `data/v2/stops-${f}`;
      fs.writeFile(filePath, JSON.stringify(body, null, '\t'), (e) => {
        if (e) throw e;
        console.log('JSON file generated: ' + filePath);
      });
    });
});