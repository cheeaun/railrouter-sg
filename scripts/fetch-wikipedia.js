const fs = require('fs');
const cheerio = require('cheerio');
const got = require('got');

const ROOT = 'https://en.wikipedia.org';

(async () => {
  const mrt = await got(`${ROOT}/wiki/List_of_Singapore_MRT_stations`);
  const lrt = await got(`${ROOT}/wiki/List_of_Singapore_LRT_stations`);
  const $ = cheerio.load(mrt.body + lrt.body);

  const results = [];
  const stationCells = $('.wikitable td:nth-child(1):has(span[style*=border-radius])');
  await Promise.all(stationCells.map(async (i, cell) => {
    const codes = $(cell).find('span').map((i, el) => {
      return {
        text: $(el).text().trim(),
        color: ($(el).attr('style').match(/#[a-f0-9]{3,6}/i) || [''])[0],
      };
    }).get();

    const nameCell = $(cell).next('td');
    const nameLink = nameCell.find('a');
    const name = nameLink.text().trim();
    const url = ROOT + nameLink.prop('href');

    if (!name) return;

    const chNameCell = nameCell.next('td');
    const name_chinese = chNameCell.text().trim();

    const taNameCell = chNameCell.next('td');
    const name_tamil = taNameCell.text().trim();

    let image = null;
    if (url) {
      console.log(url);
      const station = await got(url);
      const $$ = cheerio.load(station.body);
      const src = $$('.infobox img[alt][src*=jpg i]').prop('src');
      if (src) image = 'https:' + src;
    }

    results.push({
      codes,
      name,
      url,
      name_chinese,
      name_tamil,
      image,
    });
  }).get());

  console.info(`Total stations: ${results.length}`);

  const filePath = `data/v2/wikipedia.json`;
  fs.writeFile(filePath, JSON.stringify(results, null, '\t'), (e) => {
    if (e) throw e;
    console.log('JSON file generated: ' + filePath);
  });
})();