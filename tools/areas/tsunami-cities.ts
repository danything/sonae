/**
 * 市町村等の表 `static/areas/cities.json` に、その市町村等の沿岸が入る津波予報区を足す (7 列目)。
 * tools/areas/build-weather.sh から cities.ts の後に呼ぶ。単独でも動く:
 *   wslc run --rm -v "$PWD:/w" -w /w oven/bun:1.4.5-slim bun tools/areas/tsunami-cities.ts
 *
 * 元は気象庁の「津波予報区に対応する沿岸の市町村対応表」(令和 8 年 3 月 26 日時点。
 * https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunami-yohoku.html の PDF) を
 * `tools/areas/tsunami-cities.tsv` に書き写したもの (予報区・都道府県・市町村名の 3 列)。
 * 予報区のコードは `static/areas/tsunami-areas.geojson` の名前から引く。
 *
 * - 「市名（〜沿岸）」のような一部の沿岸の書き方は、括弧を外して市町村等ごと当てる
 *   (市町村等は区域を分けないので、どちらの予報区にも入る)
 * - 読みが同じ市町村の前に付けた県・地方の名前 (「茨城鹿嶋市」「日高地方日高町」) は外して当てる
 * - 2 つに分けた市町村等 (仙台市東部・浜松市南部など) は、名前がその市で始まるもの全部に当てる
 * - 北方領土の村は市町村等の表に無いので当てない (表に無いものは数えて出す)
 * - 表に出てこない市町村等 (海に面していない所) は空の並び
 *
 * 出力: cities.json の各行の 7 列目に `[[予報区のコード, 予報区の名前], …]`
 */

import { readFileSync, writeFileSync } from "node:fs";

const DIR = new URL("../../static/areas/", import.meta.url);
const TSV = new URL("./tsunami-cities.tsv", import.meta.url);

/** 読みが同じ市町村の前に付けた名前を外したもの (表のまま → 市町村等の名前) */
const ALIASES: Record<string, string | string[]> = {
  日高地方日高町: "日高町",
  十勝大樹町: "大樹町",
  檜山江差町: "江差町",
  宗谷枝幸町: "枝幸町",
  // 市町村等の表では島の北と南に分けてある
  対馬市: ["上対馬", "下対馬"],
  茨城鹿嶋市: "鹿嶋市",
  東京利島村: "利島村",
  愛知美浜町: "美浜町",
  三重大紀町: "大紀町",
  三重御浜町: "御浜町",
  福井美浜町: "美浜町",
  福井坂井市: "坂井市",
  大阪堺市: "堺市",
  洲本市西部沿岸: "洲本市",
  "洲本市東部沿岸・南部沿岸": "洲本市",
  和歌山美浜町: "美浜町",
  和歌山日高町: "日高町",
  佐賀鹿島市: "鹿島市",
  鹿児島十島村: "十島村",
};
/** 北方領土の村 (市町村等の表に無い) */
const NORTHERN = new Set([
  "色丹村",
  "国後泊村",
  "留夜別村",
  "留別村",
  "紗那村",
  "蘂取村",
]);

const cities = JSON.parse(
  readFileSync(new URL("cities.json", DIR), "utf8"),
) as Record<string, unknown[]>;
const tsunami = JSON.parse(
  readFileSync(new URL("tsunami-areas.geojson", DIR), "utf8"),
) as { features: { properties: { code: string; name: string } }[] };
const areaCode = new Map(
  tsunami.features.map((f) => [f.properties.name, f.properties.code]),
);

/** 都道府県の名前 → 市町村等のコードの上 2 桁 (cities.json の 2 列目の頭から取る) */
const PREFS = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
];

const out = new Map<string, Map<string, string>>();
const missing: string[] = [];
let entries = 0;
for (const line of readFileSync(TSV, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const [area = "", pref = "", list = ""] = line.split("\t");
  const code = areaCode.get(area);
  if (!code)
    throw new Error(`予報区「${area}」が tsunami-areas.geojson にありません`);
  const p = String(PREFS.indexOf(pref) + 1).padStart(2, "0");
  if (p === "00") throw new Error(`都道府県「${pref}」が分かりません`);
  for (const raw of list.split("、")) {
    const name = raw.replace(/（[^）]*）/g, "").trim();
    if (!name) continue;
    entries++;
    if (NORTHERN.has(name)) continue;
    const inPref = Object.entries(cities).filter(([c]) => c.startsWith(p));
    // 市町村等の表に同じ名前の区域があれば (「八雲町熊石」「北見市常呂」) それだけに当てる
    const same = inPref.filter(([, row]) => row[0] === name);
    const wants = [ALIASES[name] ?? name].flat();
    const hits = inPref.filter(([, row]) =>
      wants.some((w) => String(row[0]).startsWith(w)),
    );
    // 「森町」で「森…町」を拾わないよう、名前がちょうど同じものがあればそれだけにする
    const exact =
      same.length > 0
        ? same
        : hits.filter(([, row]) => wants.includes(String(row[0])));
    const use = exact.length > 0 ? exact : hits;
    if (use.length === 0) {
      missing.push(`${pref}${raw}`);
      continue;
    }
    // 分けた市町村等に当てたものは、確かめられるよう出す
    if (exact.length === 0)
      console.log(
        `${pref}${raw} → ${use.map(([, row]) => String(row[0])).join("・")}`,
      );
    for (const [c] of use) {
      const m = out.get(c) ?? new Map<string, string>();
      m.set(code, area);
      out.set(c, m);
    }
  }
}
if (missing.length > 0)
  throw new Error(`市町村等の表に無いもの: ${missing.join("、")}`);

for (const [c, row] of Object.entries(cities)) {
  const m = out.get(c);
  row[6] = m ? [...m].toSorted(([a], [b]) => a.localeCompare(b)) : [];
}
writeFileSync(new URL("cities.json", DIR), JSON.stringify(cities));
console.log(
  `表の市町村 ${entries} 件から、沿岸の市町村等 ${out.size} 件に津波予報区を当てた (北方領土の ${NORTHERN.size} 村は除く)`,
);
