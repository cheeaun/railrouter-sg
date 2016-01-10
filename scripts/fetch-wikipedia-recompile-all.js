var fs = require('fs');
var got = require('got');

var thumbnailWidth = 500;
var allFile = 'data/all.json';
var allData = JSON.parse(fs.readFileSync(allFile));
var stopPromises = Object.keys(allData.stops).map(function(key){
  return new Promise(function(resolve, reject){
    try {
      var stop = allData.stops[key];
      var stopName = stop.name.replace(/\s+[a-zA-Z]{2}[0-9]+$/i, '');
      var type = /mrt/i.test(stop.network) ? 'mrt' : 'lrt';
      var fullName = stopName + ' ' + type + ' station';
      if (/damai/i.test(stopName)){
        // There's another Damai LRT station in Malaysia
        // https://en.wikipedia.org/wiki/Damai_LRT_Station_(Malaysia)
        // This prevents it from getting the wrong one
        fullName += ', singapore';
      }
      got('https://en.wikipedia.org/w/api.php?action=opensearch&format=json&search=' + encodeURIComponent(fullName) + '&limit=1&redirects=resolve', {json: true, timeout: 5000}, function(err, body, res){
        if (err){
          reject(err);
          return;
        }
        if (!body || !body.length){
          console.log('NOT FOUND: ' + stopName);
          return;
        }
        var url = body[3][0];
        console.log(stopName + ': ' + url);
        stop.wikipedia_url = url;

        var title = url.match(/wiki\/(.*)$/i)[1]; // "title" from the URL
        var apiURL = 'https://en.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(title) + '&prop=pageimages&format=json&pithumbsize=' + thumbnailWidth;
        got(apiURL, {json: true, timeout: 5000}, function(e, b, r){
          if (e){
            reject(e);
            return;
          }
          var pages = b.query.pages;
          var thumbnail = pages[Object.keys(pages)[0]].thumbnail;
          var imgURL = thumbnail ? thumbnail.source : null;
          if (/map/i.test(imgURL)) imgURL = null; // NO to map images from Wikipedia!
          if (imgURL){
            stop.wikipedia_image_url = imgURL;
            resolve();
          } else {
            console.log('No image found for ' + stopName);
            // Sometimes, prop=pageimages doesn't do a good job, so we have to do an even better job
            // Fallback would be using the good old prop=images
            // Note that some wikipedia pages DON'T HAVE images, so it grabs a tiny image at the footer
            // which is still... kinda relevant, so whatever, still grab it anyway
            console.log('Try https://en.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(title) + '&prop=images&imlimit=1&format=json')
            got('https://en.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(title) + '&prop=images&imlimit=1&format=json', {json: true, timeout: 5000}, function(e1, b1, r1){
              if (e1){
                reject(e1);
                return;
              }
              var imgTitle = b1.query.pages[Object.keys(b1.query.pages)[0]].images[0].title;
              got('https://en.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(imgTitle) + '&prop=imageinfo&iiprop=url&iiurlwidth=' + thumbnailWidth + '&format=json', {json: true, timeout: 5000}, function(e2, b2, r2){
                if (e2){
                  reject(e2);
                  return;
                }
                var imgURL = b2.query.pages['-1'].imageinfo[0].thumburl;
                stop.wikipedia_image_url = imgURL;
                resolve();
              });
            });
          }
        });
      });
    } catch (e){
      reject(e);
    }
  });
});

Promise.all(stopPromises).then(function(){
  console.log('DONE!');
  fs.writeFile(allFile, JSON.stringify(allData, null, '\t'), function(e){
    if (e) throw e;
    console.log('JSON file generated: ' + allFile);
  });
}, function(e){
  console.log(e);
});
