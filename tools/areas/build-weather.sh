#!/bin/sh
# 気象警報・注意報を塗る市町村等の面と、市町村等の表を作る。ホストに何も入れず、コンテナの中で動かす:
#   wslc run --rm -v "$PWD:/w" -w /w oven/bun:1.4.4-slim sh tools/areas/build-weather.sh <zip を置いた所>
#
# 元 (どれも気象庁ホームページの利用規約。出典は docs/map.md):
#   - https://www.data.jma.go.jp/developer/gis.html
#     - *_AreaInformationCity_weather_GIS.zip … 市町村等 (気象警報等) の面。20260226 版 (令和 8 年 5 月下旬からの
#       区域)。日付の違う zip を同じ所に置かない (1 つだけ置く)
#     - *_AreaForecastLocalE_GIS.zip         … 地震情報／細分区域の面 (市町村等がどの細分区域に入るかを決める)
#   - https://xml.kishou.go.jp/tec_material.html
#     - jmaxml_*_Code.zip                     … コード表 (市町村等の名前と、属する一次細分区域・府県予報区)
#
# 出力 (static/areas/):
#   - warning-areas.geojson … 市町村等の面 (code・name)。警報・注意報の段の色を塗る
#   - cities.json           … 市町村等の名前・府県予報区・一次細分区域・地震の細分区域 (tools/areas/cities.ts)
set -eu
SRC=${1:?zip を置いたディレクトリ}
DIR=$(dirname "$0")
OUT=$DIR/../../static/areas
MAPSHAPER="bunx mapshaper@0.7.101"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# zip の中の名前は Shift_JIS なので、拡張子だけ残して付け直す
bun "$DIR/zip.ts" "$(ls "$SRC"/*_AreaInformationCity_weather_GIS.zip)" "$WORK/city" area
bun "$DIR/zip.ts" "$(ls "$SRC"/*_AreaForecastLocalE_GIS.zip)" "$WORK/quake" area

# 属性 (dbf) は UTF-8。コードの無い面 (北方領土・境界の決まっていない土地) は除く。
# 簡略化は、細分区域 (quake-areas) と同じくらいの大きさ (gzip で 300KB ほど) に収まる 600m
$MAPSHAPER -i "$WORK/city/area.shp" encoding=utf8 \
  -filter 'regioncode != ""' \
  -rename-fields code=regioncode \
  -filter-fields code,name \
  -simplify interval=600 weighted keep-shapes \
  -clean \
  -o "$OUT/warning-areas.geojson" format=geojson precision=0.001 force

# 市町村等の面の中の 1 点が、どの地震情報／細分区域に入るか
$MAPSHAPER -i "$WORK/quake/area.shp" encoding=utf8 name=quake \
  -rename-fields quake=code \
  -filter-fields quake \
  -i "$WORK/city/area.shp" encoding=utf8 name=city \
  -filter 'regioncode != ""' \
  -rename-fields code=regioncode \
  -filter-fields code \
  -points inner \
  -join quake fields=quake \
  -o "$WORK/points.json" format=geojson precision=0.001 force

bun "$DIR/cities.ts" "$(ls "$SRC"/jmaxml_*_Code.zip)" "$WORK/points.json" "$OUT/cities.json"

ls -la "$OUT"
