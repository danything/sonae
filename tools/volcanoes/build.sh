#!/bin/sh
# 活火山の位置の表 (static/areas/volcano-points.json) を作る。地図の火山の印を置くのに使う。
# 噴火警報・予報 (VFVO50) には火山の位置が載っているが、噴火速報 (VFVO56) には無いので、この表で補う。
# 依存はホストに入れず、コンテナの中で動かす (docker compose run --rm sonae sh tools/volcanoes/build.sh)。
#
# 元: 気象庁ホームページの活火山の一覧 (https://www.jma.go.jp/bosai/volcano/const/volcano_list.json)。
# 気象庁のホームページの表示に使う JSON で、公式の API ではない (形が変わったら直す)。利用条件は気象庁ホームページの
# 利用規約 (公共データ利用規約 第 1.0 版)。コードは気象庁防災情報 XML のコード表「火山名」(PointVolcano) と同じ。
#
# 出力: 火山名のコード → [経度, 緯度, 名前]。活火山は 111 で、年に何度も変わらない。
set -eu
OUT=$(dirname "$0")/../../static/areas/volcano-points.json
curl -fsS -A "sonae (+https://github.com/danything/sonae)" \
  https://www.jma.go.jp/bosai/volcano/const/volcano_list.json |
  bun -e '
    const list = JSON.parse(await Bun.stdin.text());
    const out = {};
    for (const v of list) {
      // 「全国の活火山」(900) のような、位置の無いまとめの項目は飛ばす
      if (!Array.isArray(v.latlon)) continue;
      const [lat, lon] = v.latlon.map(Number);
      if (!v.code || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out[v.code] = [lon, lat, v.name_jp];
    }
    await Bun.write(process.argv[1], JSON.stringify(out));
    console.log(`${Object.keys(out).length} 火山`);
  ' "$OUT"
