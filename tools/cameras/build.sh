#!/bin/sh
# 気象庁の火山の監視カメラの表 (static/cameras/volcano-cameras.json) を作る。地図のカメラの印を置くのに使う
# (docs/map.md の「火山の監視カメラ」)。依存はホストに入れず、コンテナの中で動かす:
#   wslc run --rm -v "$PWD:/w" -w /w oven/bun:1.4.5-slim sh tools/cameras/build.sh
#
# 元: 気象庁ホームページの「監視カメラ画像」の地図 (volmap.html) が読む GeoJSON
# (https://www.data.jma.go.jp/vois/data/obs/volcam/param/geojson/camicon.geojson)。気象庁のホームページの表示に
# 使うもので、公式の API ではない (形が変わったら直す)。利用条件は気象庁ホームページの利用規約 (公共データ利用規約
# 第 1.0 版)。位置は小数 3 桁 (約 100 m) で、カメラを置いた正確な場所とは限らない。
#
# 画像の URL は表に入れない。最新の画像の名前は撮った時刻で、固定の URL が無いので、画面が印を押したときに
# カメラのページ (volcam.php?VC=<番号>) から読む (`#lib/map/cameras.ts`)。
#
# 出力: GeoJSON の FeatureCollection。properties は vc (カメラの 5 桁の番号。頭の 3 桁は火山のコード)・
# volcano (火山の名前)・camera (カメラの名前)。2026-11-28 は 49 火山の 95 台。カメラが増えたり減ったりしたら作り直す。
set -eu
DIR=$(dirname "$0")/../../static
mkdir -p "$DIR/cameras"
bun -e '
  const url = "https://www.data.jma.go.jp/vois/data/obs/volcam/param/geojson/camicon.geojson";
  const res = await fetch(url, {
    headers: { "user-agent": "sonae (+https://github.com/danything/sonae)" },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const src = await res.json();
  // 火山の名前は活火山の一覧 (tools/volcanoes/build.sh) から引き、カメラの名前と分ける (「霧島山 新燃岳南西」)
  const volcanoes = await Bun.file(process.argv[2]).json();
  const features = [];
  for (const f of src.features) {
    const vc = String(f.properties?.code ?? "");
    // 名前に HTML のルビが混ざる行がある (阿蘇山の「車帰」)。読みの <rt> ごと外し、ほかのタグも外す
    const name = String(f.properties?.name ?? "")
      .replace(/<rt>.*?<\/rt>/g, "")
      .replace(/<[^>]*>/g, "")
      .trim();
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (!/^\d{5}$/.test(vc) || !name || !Number.isFinite(lon) || !Number.isFinite(lat))
      throw new Error(`読めない行: ${JSON.stringify(f.properties)}`);
    const known = volcanoes[vc.slice(0, 3)]?.[2];
    const volcano =
      known && name.startsWith(`${known} `) ? known : name.split(/\s+/)[0];
    const camera = name.slice(volcano.length).trim() || name;
    features.push({
      type: "Feature",
      properties: { vc, volcano, camera },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });
  }
  features.sort((a, b) => a.properties.vc.localeCompare(b.properties.vc));
  await Bun.write(
    process.argv[1],
    JSON.stringify({ type: "FeatureCollection", features }) + "\n",
  );
  console.log(`${new Set(features.map((f) => f.properties.volcano)).size} 火山の ${features.length} 台`);
' "$DIR/cameras/volcano-cameras.json" "$DIR/areas/volcano-points.json"
