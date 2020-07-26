const fs = require('fs');
const sprite = require('./sprite.json');

const { data } = sprite;

const output = data.map((d) => {
  const { sprite, w, h, x, y } = d;
  return [sprite.replace(/\-svg$/i, ''), x, y, w, h];
});

fs.writeFileSync('src/stations.json', JSON.stringify(output, null, '\t'));
