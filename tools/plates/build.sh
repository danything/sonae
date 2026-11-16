#!/bin/sh
# プレート境界 (PB2002) の線を簡略化して、地図に重ねる GeoJSON を作る (docs/map.md)。
# 依存はホストに入れず、コンテナの中で動かす:
#
#   wslc run --rm -v "$PWD:/usr/src/app" -w /usr/src/app oven/bun:1.4.4-slim sh tools/plates/build.sh
#
# 元: Peter Bird (2003) の PB2002 を Hugo Ahlenius (Nordpil) が整え、GeoJSON にしたもの
#   https://github.com/fraxen/tectonicplates (GeoJSON/PB2002_boundaries.json)
#   ODC Attribution License 1.0 (https://opendatacommons.org/licenses/by/1-0/)。
#   研究の模型 (2003) で、どの機関の公式の線でもない。出典の書き方は static/plates/README.md と docs/map.md
#
# 出力 (static/plates/):
#   - pb2002-boundaries.geojson … プレート境界の線 (属性は持たない)。日本全体を見る大きさで形が分かれば足りる
set -eu
# 元のリポジトリの決まったコミット (2014-10-06。それ以降は更新されていない)
REV=339b0c56563c118307b1f4542703047f5f698fae
URL="https://raw.githubusercontent.com/fraxen/tectonicplates/$REV/GeoJSON/PB2002_boundaries.json"
OUT=$(dirname "$0")/../../static/plates
MAPSHAPER="bunx mapshaper@0.7.101"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

bun -e '
  const res = await fetch(process.argv[1]);
  if (!res.ok) throw new Error(`${res.status} ${process.argv[1]}`);
  await Bun.write(process.argv[2], res);
' "$URL" "$WORK/boundaries.json"

mkdir -p "$OUT"
# 境界の線は 1 本ずつの区間 (約 230 本)。2 km 間隔に間引き、座標は 0.01 度 (約 1 km) に丸める
$MAPSHAPER -i "$WORK/boundaries.json" \
  -filter-fields \
  -simplify interval=2000 keep-shapes \
  -o "$OUT/pb2002-boundaries.geojson" format=geojson geojson-type=FeatureCollection precision=0.01 force

ls -la "$OUT"
