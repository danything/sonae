/**
 * 市町村等 (気象警報等) の表 `static/areas/cities.json` を作る。tools/areas/build-weather.sh から呼ぶ。
 *
 * - 名前と、属する「市町村等をまとめた地域等」「一次細分区域等」「府県予報区等」のコードは、気象庁の
 *   コード表 (技術資料の `jmaxml_*_Code.zip` の `*_AreaInformationCity-AreaForecastLocalM.xlsx`)
 *   から取る。気象警報・注意報で使う行 (F 列が 1) だけ
 * - 地震情報／細分区域は、コード表に対応が無いので、市町村等の面の中の 1 点がどの細分区域の面に入るかで決める
 *   (mapshaper の点と面の結び付け。build-weather.sh)
 *
 * 出力: `{ "<市町村等のコード>": [名前, 府県と市町村の名前, 府県予報区, 一次細分区域, まとめた地域, 地震の細分区域] }`
 */

import { readFileSync, writeFileSync } from "node:fs";

import { readZip } from "./zip.ts";

const [codeZip, pointsPath, out] = process.argv.slice(2);
if (!codeZip || !pointsPath || !out)
  throw new Error("コード表の zip と、点の GeoJSON と、出す所を渡してください");

const xlsxEntry = readZip(readFileSync(codeZip)).find((e) =>
  e.name.includes("AreaInformationCity-AreaForecastLocalM"),
);
if (!xlsxEntry)
  throw new Error("コード表に AreaInformationCity の xlsx がありません");
const xlsx = new Map(readZip(xlsxEntry.data()).map((e) => [e.name, e]));
const file = (name: string) => {
  const e = xlsx.get(name);
  if (!e) throw new Error(`xlsx に ${name} がありません`);
  return e.data().toString("utf8");
};

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
// 振り仮名 (rPh) は外し、本文の字だけをつなぐ
const strings = [
  ...file("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g),
].map((m) =>
  unescape(
    [
      ...(m[1] ?? "")
        .replace(/<rPh[\s\S]*?<\/rPh>/g, "")
        .matchAll(/<t[^>]*>([^<]*)<\/t>/g),
    ]
      .map((t) => t[1])
      .join(""),
  ),
);

/** シートの行を、列の字 (A・B…) から値への表にする */
function rows(sheet: string): Record<string, string>[] {
  return [
    ...file(`xl/worksheets/${sheet}.xml`).matchAll(
      /<row [^>]*>([\s\S]*?)<\/row>/g,
    ),
  ].map((row) => {
    const out: Record<string, string> = {};
    for (const c of (row[1] ?? "").matchAll(
      /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const v = /<v>([^<]*)<\/v>/.exec(c[3] ?? "")?.[1];
      if (v === undefined) continue;
      out[c[1] ?? ""] = /t="s"/.test(c[2] ?? "")
        ? (strings[Number(v)] ?? "")
        : unescape(v);
    }
    return out;
  });
}

// シートの並び: sheet1 は AreaInformationCity、sheet2 は警報・注意報の関係表 (workbook.xml の順)
const relation = new Map<string, { ichiji: string; office: string }>();
for (const r of rows("sheet2"))
  if (/^\d{6}$/.test(r.A ?? "") && r.C && r.E)
    relation.set(r.A ?? "", { ichiji: r.C, office: r.E });

const points = JSON.parse(readFileSync(pointsPath, "utf8")) as {
  features: { properties: { code?: string; quake?: string | null } }[];
};
const quakeOf = new Map(
  points.features.map((f) => [f.properties.code ?? "", f.properties.quake]),
);

const table: Record<string, (string | null)[]> = {};
for (const r of rows("sheet1")) {
  const code = r.A ?? "";
  if (!/^\d{7}$/.test(code) || r.F !== "1") continue;
  const group = r.E ?? "";
  const rel = relation.get(group);
  table[code] = [
    r.C ?? "",
    r.B ?? r.C ?? "",
    rel?.office ?? null,
    rel?.ichiji ?? null,
    group || null,
    quakeOf.get(code) ?? null,
  ];
}
writeFileSync(out, JSON.stringify(table));
const n = Object.keys(table).length;
const noQuake = Object.values(table).filter((v) => v[5] === null).length;
console.log(`市町村等 ${n} 件 (地震の細分区域が決まらないもの ${noQuake} 件)`);
