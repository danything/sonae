/**
 * 震度観測点の位置の表 (static/areas/intensity-stations-v2.json) を作る (docs/map.md の「観測点ごとの震度」)。
 * 地図で、震度の電文に並ぶ観測点を震度の色の丸で置き、押したときの吹き出しに市町村と設置者を出すのに使う。
 * コンテナの中で動かす:
 *
 *   wslc run --rm -v "$PWD:/w" -w /w oven/bun:1.4.5-slim bun tools/stations/build.ts <コード表の zip か xlsx> [stations.json]
 *
 * 元 (どれも気象庁ホームページの利用規約。公共データ利用規約 第 1.0 版):
 * - 観測点のコードと名前: 気象庁防災情報 XML の技術資料 (https://xml.kishou.go.jp/tec_material.html) の
 *   コード表 `jmaxml_*_Code.zip` の中の「地震火山関連コード表.xlsx」のシート「24」(震度観測点)。緯度・経度は無い
 * - 位置: 気象庁ホームページの「震度観測点」のページ (https://www.jma.go.jp/jma/kishou/know/jishin/intens-st/) が読む
 *   `stations.json` (名前・緯度・経度・都道府県。コードは無い)。2 つ目の引数で手元の写しを渡せる。無ければ取得する
 * - 上の 2 つで名前が合わない観測点は、`tools/stations/extra.tsv` (手で書いた表。出どころも書く) で補う。
 *   コード表に無いが、移すまでは電文に並ぶ前の観測点もここに書く
 *
 * 2 つの表は名前で突き合わせる (都道府県が同じことも確かめる)。名前はどちらの表でも全国で重ならない。
 * 出力: `{ cities: [市町村の名前…], stations: { 観測点のコード (7 桁): [経度, 緯度, 設置者, 市町村, 名前, 別名…] } }`。
 * - 設置者は位置の表の `affi` (0 は気象庁、1 は自治体、2 は防災科研)。分からなければ -1
 * - 市町村は `cities` の番号 (コード表の市町村の名前。「札幌中央区」のような気象庁の書き方)。分からなければ -1。
 *   都道府県は観測点のコードの上 2 桁で分かるので持たない
 * - 名前はコード表の名前 (＊は付かない。コード表に無い観測点は位置の表の名前)。別名は、電文 (P2P) が前の名前で
 *   来ることがある観測点の、位置の表の名前
 *
 * 前の形 (観測点のコード → [経度, 緯度, 名前, 別名…]) の `intensity-stations.json` は、開いたままの古い画面が
 * 新しい形を読んで壊れないよう、名前を替えて消した (古い画面は 404 を受け、丸を出さないだけになる)
 */

import { readFileSync } from "node:fs";

import { readZip, type ZipEntry } from "../areas/zip.ts";

const STATIONS_URL =
  "https://www.jma.go.jp/jma/kishou/know/jishin/intens-st/stations.json";
const DIR = import.meta.dir;
const OUT = `${DIR}/../../static/areas/intensity-stations-v2.json`;

const [src, stationsPath] = process.argv.slice(2);
if (!src) throw new Error("コード表の zip か xlsx を渡してください");

/** zip の中の名前 (UTF-8 か Shift_JIS のバイトを latin1 で読んだ字) を読める字に戻す */
function entryName(e: ZipEntry): string {
  const raw = Buffer.from(e.name, "latin1");
  for (const enc of ["utf-8", "shift_jis"])
    try {
      return new TextDecoder(enc, { fatal: true }).decode(raw);
    } catch {
      // 次の字の形で試す
    }
  return e.name;
}

/** コード表の zip なら、中の「地震火山関連コード表.xlsx」を取り出す */
function workbook(path: string): ZipEntry[] {
  const top = readZip(readFileSync(path));
  if (top.some((e) => e.name === "xl/workbook.xml")) return top;
  const inner = top.find((e) => entryName(e).includes("地震火山関連コード表"));
  if (!inner) throw new Error(`${path} に地震火山関連コード表がありません`);
  return readZip(inner.data());
}

const unescape = (s: string) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/** シート「24」の行を、列の文字 (A・B…) → 値で返す。ふりがな (rPh) は外す */
function sheetRows(entries: ZipEntry[], sheet: string) {
  const text = (name: string) => {
    const e = entries.find((x) => x.name === name);
    if (!e) throw new Error(`xlsx に ${name} がありません`);
    return e.data().toString("utf8");
  };
  const rid = new RegExp(`<sheet name="${sheet}"[^>]*r:id="([^"]+)"`).exec(
    text("xl/workbook.xml"),
  )?.[1];
  const target = rid
    ? new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(
        text("xl/_rels/workbook.xml.rels"),
      )?.[1]
    : undefined;
  if (!target) throw new Error(`シート「${sheet}」がありません`);
  const strings = [
    ...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) =>
    unescape(
      [
        ...(m[1] ?? "")
          .replace(/<rPh[\s\S]*?<\/rPh>/g, "")
          .matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g),
      ]
        .map((t) => t[1])
        .join(""),
    ),
  );
  const rows: Record<string, string>[] = [];
  for (const r of text(`xl/${target.replace(/^\/?xl\//, "")}`).matchAll(
    /<row [^>]*>([\s\S]*?)<\/row>/g,
  )) {
    const cells: Record<string, string> = {};
    for (const c of (r[1] ?? "").matchAll(
      /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[3] ?? "")?.[1];
      if (v === undefined || !c[1]) continue;
      cells[c[1]] = /t="s"/.test(c[2] ?? "")
        ? (strings[Number(v)] ?? "")
        : unescape(v);
    }
    rows.push(cells);
  }
  return rows;
}

// ---- コード表 (シート「24」: A〜C が細分区域、D〜F が市町村、G〜I が震度観測点のコード・名前・ふりがな) ----
const rows = sheetRows(workbook(src), "24");
if (!rows.some((r) => r.G?.includes("震度観測点")))
  throw new Error(
    "シート「24」の見出しに「震度観測点」がありません (形が変わった)",
  );
const codes = rows
  .filter((r) => /^\d{7}$/.test(r.G ?? "") && r.H)
  .map((r) => ({
    code: r.G as string,
    name: (r.H as string).trim(),
    city: (r.E ?? "").trim(),
  }));

// 市町村の名前は番号にして 1 度だけ持つ (観測点ごとに名前を書くと表が大きくなる)
const cities: string[] = [];
const cityNo = new Map<string, number>();
const cityIndex = (name: string) => {
  if (!name) return -1;
  let n = cityNo.get(name);
  if (n === undefined) {
    n = cities.length;
    cities.push(name);
    cityNo.set(name, n);
  }
  return n;
};
// コード表に無い観測点 (extra.tsv) の市町村は、観測点のコードの上 5 桁 (市町村のコードの上 5 桁と同じ) で引く
const cityByPrefix = new Map<string, string>();
for (const r of rows)
  if (/^\d{7}$/.test(r.D ?? "") && r.E)
    cityByPrefix.set((r.D as string).slice(0, 5), (r.E as string).trim());

// ---- 位置の表 ----
interface Pos {
  lat: string;
  lon: string;
  name: string;
  pref: string;
  /** 設置者 (0 は気象庁、1 は自治体、2 は防災科研) */
  affi?: string;
}
/** 設置者の数。知らない値は -1 */
const affiOf = (p: Pos | undefined) =>
  p && /^[012]$/.test(p.affi ?? "") ? Number(p.affi) : -1;
const positions = (
  stationsPath
    ? JSON.parse(readFileSync(stationsPath, "utf8"))
    : await (async () => {
        const res = await fetch(STATIONS_URL, {
          headers: {
            "user-agent": "sonae (+https://github.com/danything/sonae)",
          },
        });
        if (!res.ok) throw new Error(`${res.status} ${STATIONS_URL}`);
        return res.json();
      })()
) as Pos[];
const byName = new Map<string, Pos>();
for (const p of positions) {
  if (byName.has(p.name))
    throw new Error(`位置の表で名前が重なります: ${p.name}`);
  byName.set(p.name, p);
}

// ---- 手で補う表 (コード・緯度・経度・位置の表での名前・出どころ。# で始まる行は書き添え) ----
const extra = new Map<string, { lat: number; lon: number; alias?: string }>();
for (const line of readFileSync(`${DIR}/extra.tsv`, "utf8").split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  const [code, lat, lon, alias] = line.split("\t");
  if (!code || !lat || !lon)
    throw new Error(`extra.tsv の行が読めません: ${line}`);
  extra.set(code, {
    lat: Number(lat),
    lon: Number(lon),
    alias: alias || undefined,
  });
}

const round = (n: number) => Math.round(n * 100) / 100;
const out: Record<string, (number | string)[]> = {};
const used = new Set<string>();
const missing: string[] = [];
const seen = new Set<string>();
for (const { code, name, city } of codes) {
  if (seen.has(name)) throw new Error(`コード表で名前が重なります: ${name}`);
  seen.add(name);
  const p = byName.get(name);
  const x = extra.get(code);
  if (p && x)
    console.warn(
      `extra.tsv の ${code} ${name} は、もう名前で結び付きます (行を消す)`,
    );
  if (p) {
    if (Number(p.pref) !== Number(code.slice(0, 2)))
      throw new Error(
        `都道府県が合いません: ${code} ${name} (位置の表は ${p.pref})`,
      );
    used.add(name);
    out[code] = [
      round(Number(p.lon)),
      round(Number(p.lat)),
      affiOf(p),
      cityIndex(city),
      name,
    ];
  } else if (x) {
    if (x.alias) used.add(x.alias);
    out[code] = [
      round(x.lon),
      round(x.lat),
      affiOf(x.alias ? byName.get(x.alias) : undefined),
      cityIndex(city),
      name,
      ...(x.alias ? [x.alias] : []),
    ];
  } else missing.push(`${code} ${name}`);
}
// コード表に無いが、まだ電文に並ぶ観測点 (移す・やめる前のもの)。位置の表の名前で出す
const tableCodes = new Set(codes.map((c) => c.code));
for (const [code, x] of extra) {
  if (tableCodes.has(code)) continue;
  if (!x.alias) throw new Error(`extra.tsv の ${code} に名前がありません`);
  if (seen.has(x.alias))
    throw new Error(
      `extra.tsv の ${code} ${x.alias} はコード表の名前と重なります`,
    );
  used.add(x.alias);
  out[code] = [
    round(x.lon),
    round(x.lat),
    affiOf(byName.get(x.alias)),
    cityIndex(cityByPrefix.get(code.slice(0, 5)) ?? ""),
    x.alias,
  ];
}
// 画面は名前 (別名も) → 位置の索引を作るので、どの名前も 1 つの観測点だけを指すようにする
const owner = new Map<string, string>();
for (const [code, [, , , , ...names]] of Object.entries(out))
  for (const n of names) {
    const prev = owner.get(n as string);
    if (prev && prev !== code)
      throw new Error(`名前 ${n} が ${prev} と ${code} の両方を指します`);
    owner.set(n as string, code);
  }
const unused = positions.filter((p) => !used.has(p.name)).map((p) => p.name);

const noAffi = Object.entries(out).filter(([, v]) => v[2] === -1);
const noCity = Object.entries(out).filter(([, v]) => v[3] === -1);
const text = JSON.stringify({ cities, stations: out });
await Bun.write(OUT, text);
console.log(
  `${Object.keys(out).length} 点 (コード表 ${codes.length} 点・位置の表 ${positions.length} 点)。` +
    `${text.length.toLocaleString()} バイト・gzip ${Bun.gzipSync(text).length.toLocaleString()} バイト`,
);
console.log(
  `位置の無い観測点 (${missing.length}): ${missing.join("、") || "なし"}`,
);
console.log(
  `使わなかった位置 (${unused.length}): ${unused.join("、") || "なし"}`,
);
console.log(
  `設置者の分からない観測点 (${noAffi.length}): ${noAffi.map(([c]) => c).join("、") || "なし"}`,
);
console.log(
  `市町村の分からない観測点 (${noCity.length}): ${noCity.map(([c]) => c).join("、") || "なし"}`,
);
