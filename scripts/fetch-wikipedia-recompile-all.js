const fs = require('fs');
const got = require('got');

const thumbnailWidth = 500;
const allFile = 'data/all.json';
const allData = JSON.parse(fs.readFileSync(allFile));

const promises = allData.stops.map(async (stop) => {
  try {
    const stopName = stop.name.replace(/\s+[a-zA-Z]{2}[0-9]+$/i, '');
    const type = /mrt/i.test(stop.network) ? 'mrt' : 'lrt';
    let fullName = stopName + ' ' + type + ' station';

    if (/damai/i.test(stopName)){
      // There's another Damai LRT station in Malaysia
      // https://en.wikipedia.org/wiki/Damai_LRT_Station_(Malaysia)
      // This prevents it from getting the wrong one
      fullName += ', singapore';
    }

    let url = 'https://en.wikipedia.org/w/api.php?action=opensearch&format=json&search=' + encodeURIComponent(fullName) + '&limit=1&redirects=resolve';
    console.log('➡️ ' + url);
    const { body } = await got(url, {json: true, timeout: 5000});
    if (!body || !body.length){
      console.log('NOT FOUND: ' + stopName);
      return;
    }
    url = body[3][0];
    if (!url) return;

    console.log(stopName + ': ' + url);
    stop.wikipedia_url = url;

    const title = url.match(/wiki\/(.*)$/i)[1]; // "title" from the URL
    const apiURL = 'https://en.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(title) + '&prop=pageimages&format=json&pithumbsize=' + thumbnailWidth;
    console.log('➡️ ' + apiURL);
    const { body: b } = await got(apiURL, {json: true, timeout: 5000});

    const pages = b.query.pages;
    const thumbnail = pages[Object.keys(pages)[0]].thumbnail;
    let imgURL = thumbnail ? thumbnail.source : null;
    if (/map/i.test(imgURL)) imgURL = null; // NO to map images from Wikipedia!
    if (imgURL){
      stop.wikipedia_image_url = imgURL;
      return;
    } else {
      console.log('No image found for ' + stopName);
      // Sometimes, prop=pageimages doesn't do a good job, so we have to do an even better job
      // Fallback would be using the good old prop=images
      // Note that some wikipedia pages DON'T HAVE images, so it grabs a tiny image at the footer
      // which is still... kinda relevant, so whatever, still grab it anyway
      const url1 = 'https://en.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(title) + '&prop=images&imlimit=1&format=json';
      console.log('➡️ ' + url1);
      const { body: b1 } = await got(url1, {json: true, timeout: 5000});
      const imgTitle = b1.query.pages[Object.keys(b1.query.pages)[0]].images[0].title;

      const url2 = 'https://en.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(imgTitle) + '&prop=imageinfo&iiprop=url&iiurlwidth=' + thumbnailWidth + '&format=json';
      console.log('➡️ ' + url2);
      const { body: b2 } = await got(url2, {json: true, timeout: 5000});

      imgURL = b2.query.pages['-1'].imageinfo[0].thumburl;
      stop.wikipedia_image_url = imgURL;
    }
  } catch(e) {
    console.error(e);
  }
});

Promise.all(promises).then(() => {
  console.log('DONE!');
  fs.writeFile(allFile, JSON.stringify(allData, null, '\t'), function(e){
    if (e) throw e;
    console.log('JSON file generated: ' + allFile);
  });
}).catch((e) => {
  console.error(e);
});

