/**
 * 府県予報区ごとの市町村等と、その面の外枠 (緯度・経度の範囲) の表 `static/areas/offices.json` を作る。
 * tools/areas/build-weather.sh から呼ぶ (できた warning-areas.geojson と cities.json から作るので、zip は要らない)。
 *
 * 地図で一覧の府県予報区の警報・注意報を選んだとき、その府県予報区の市町村等を縁取り、
 * 出ている市町村等が画面に収まるよう寄せるのに使う (docs/map.md)。
 *
 * 出力: `{ "<府県予報区のコード>": { "<市町村等のコード>": [西, 南, 東, 北] } }` (小数 2 桁、外へ丸める)
 */

import { readFileSync, writeFileSync } from "node:fs";

const [areasPath, citiesPath, out] = process.argv.slice(2);
if (!areasPath || !citiesPath || !out)
  throw new Error(
    "warning-areas.geojson と cities.json と、出す所を渡してください",
  );

type Pos = [number, number];
const areas = JSON.parse(readFileSync(areasPath, "utf8")) as {
  features: {
    properties: { code: string };
    geometry: { type: string; coordinates: unknown };
  }[];
};
const cities = JSON.parse(readFileSync(citiesPath, "utf8")) as Record<
  string,
  [string, string, string | null, ...unknown[]]
>;

const down = (v: number) => Math.floor(v * 100) / 100;
const up = (v: number) => Math.ceil(v * 100) / 100;

/** 面の座標を全部たどって、範囲を広げる */
function extend(box: number[], c: unknown): void {
  if (!Array.isArray(c)) return;
  if (typeof c[0] === "number") {
    const [x, y] = c as Pos;
    box[0] = Math.min(box[0] ?? x, x);
    box[1] = Math.min(box[1] ?? y, y);
    box[2] = Math.max(box[2] ?? x, x);
    box[3] = Math.max(box[3] ?? y, y);
    return;
  }
  for (const x of c) extend(box, x);
}

const boxes = new Map<string, number[]>();
for (const f of areas.features) {
  const box = boxes.get(f.properties.code) ?? [];
  extend(box, f.geometry.coordinates);
  boxes.set(f.properties.code, box);
}

const table: Record<string, Record<string, number[]>> = {};
let missing = 0;
for (const code of Object.keys(cities).sort()) {
  const office = cities[code]?.[2];
  const box = boxes.get(code);
  if (!office) continue;
  if (!box || box.length !== 4) {
    missing++;
    continue;
  }
  const [w = 0, s = 0, e = 0, n = 0] = box;
  (table[office] ??= {})[code] = [down(w), down(s), up(e), up(n)];
}

writeFileSync(out, JSON.stringify(table));
console.log(
  `府県予報区 ${Object.keys(table).length} 件・面の無い市町村等 ${missing} 件`,
);
