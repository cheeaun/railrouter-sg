#!/bin/bash

# Downloads sg-rail data from cheeaun/sgraildata
# Note: Source files use .geojson, local files use .geo.json

BASE_URL="https://raw.githubusercontent.com/cheeaun/sgraildata/master/data/v1"

echo "Downloading sg-rail.geojson..."
curl -sL "$BASE_URL/sg-rail.geojson" -o src/sg-rail.geo.json

echo "Downloading sg-rail-walks.geojson..."
curl -sL "$BASE_URL/sg-rail-walks.geojson" -o src/sg-rail-walks.geo.json

echo "Done!"
