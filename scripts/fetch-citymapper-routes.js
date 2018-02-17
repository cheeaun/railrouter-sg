const fs = require('fs');
const got = require('got');

const routes = [
  'mrt-east-west-line',
  'mrt-circle-line',
  'mrt-downtown-line',
  'mrt-north-east-line',
  'mrt-north-south-line',
  'lrt-bukit-panjang-lrt',
  'lrt-punggol-lrt-east-loop',
  'lrt-punggol-lrt-west-loop',
  'lrt-sengkang-lrt-east-loop',
  'lrt-sengkang-lrt-west-loop',
];

routes.map(async (r) => {
  const { body } = await got(`https://citymapper.com/api/1/routeinfo?route=${r}&region_id=sg-singapore`, {
    json: true,
  });
  const filePath = `data/v2/${r}.json`;
  fs.writeFile(filePath, JSON.stringify(body, null, '\t'), (e) => {
    if (e) throw e;
    console.log('JSON file generated: ' + filePath);
  });
});