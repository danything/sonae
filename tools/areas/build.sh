#!/bin/sh
# 気象庁の予報区等 GIS データ (シェープファイル) から、地図に重ねる GeoJSON を作る。
# 依存はホストに入れず、コンテナの中で動かす (docker compose run --rm sonae sh tools/areas/build.sh <zip を置いた所>)。
#
# 元: https://www.data.jma.go.jp/developer/gis.html
#   - 20240520_AreaForecastLocalE_GIS.zip … 地震情報／細分区域 (面)
#   - 20240520_AreaTsunami_GIS.zip       … 津波予報区 (線)
# 利用条件は気象庁ホームページの利用規約。出典は docs/map.md。
#
# 出力 (static/areas/):
#   - quake-areas.geojson   … 細分区域の面 (code・name)。震度の色と、緊急地震速報の警報の地域を塗る
#   - quake-points.json     … 細分区域の中の 1 点 (code → [経度, 緯度])。震度のラベルを置く
#   - tsunami-areas.geojson … 津波予報区の線 (code・name)。警報・注意報の色を塗る
#
# 簡略化の度合いは、画面で地域の形が分かり、ファイルが数百 KB に収まる所 (docs/design.md の未決の点 7)。
set -eu
SRC=${1:?zip を置いたディレクトリ}
OUT=$(dirname "$0")/../../static/areas
MAPSHAPER="bunx mapshaper@0.7.101"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

for name in AreaForecastLocalE AreaTsunami; do
  mkdir -p "$WORK/$name"
  # zip の中の名前は Shift_JIS (津波予報区は区切りが \)。中身の名前は使わないので、拡張子だけ残して付け直す
  # 区切りがバックスラッシュの zip では unzip が警告して 1 で終わる (中身は取り出せている)
  unzip -q -o "$SRC"/*_"$name"_GIS.zip -d "$WORK/$name/raw" || [ $? -eq 1 ]
  find "$WORK/$name/raw" -type f | while read -r f; do
    mv "$f" "$WORK/$name/area.${f##*.}"
  done
done

# 属性 (dbf) は UTF-8
$MAPSHAPER -i "$WORK/AreaForecastLocalE/area.shp" encoding=utf8 \
  -filter-fields code,name \
  -simplify interval=300 weighted keep-shapes \
  -clean \
  -o "$OUT/quake-areas.geojson" format=geojson precision=0.001 force

$MAPSHAPER -i "$WORK/AreaForecastLocalE/area.shp" encoding=utf8 \
  -filter-fields code \
  -points inner \
  -o "$WORK/points.json" format=geojson precision=0.001 force
bun -e '
  const fc = JSON.parse(await Bun.file(process.argv[1]).text());
  const out = Object.fromEntries(fc.features.map((f) => [f.properties.code, f.geometry.coordinates]));
  await Bun.write(process.argv[2], JSON.stringify(out));
' "$WORK/points.json" "$OUT/quake-points.json"

$MAPSHAPER -i "$WORK/AreaTsunami/area.shp" encoding=utf8 \
  -filter-fields code,name \
  -simplify interval=300 weighted \
  -o "$OUT/tsunami-areas.geojson" format=geojson precision=0.001 force

ls -la "$OUT"
