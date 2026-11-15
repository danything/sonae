import { expect, test } from "bun:test";

import {
  CREDITS,
  creditText,
  mapCredit,
  NOTICE,
  showsGrus,
} from "#lib/notice.ts";

test("注意文は非公式であることと、公式の情報を優先することを言う", () => {
  expect(NOTICE).toContain("公式のものではありません");
  expect(NOTICE).toContain("優先してください");
});

const all = CREDITS.map(creditText).join("\n");
const links = CREDITS.flatMap((c) =>
  c.parts.flatMap((p) => (typeof p === "string" ? [] : [p.href])),
);

test("出典: 各機関の規約の例の文言", () => {
  // 気象庁ホームページの利用規約
  expect(all).toContain("出典：気象庁ホームページ（https://");
  expect(all).toContain("気象庁「予報区等GISデータ」（");
  expect(all).toMatch(/）を加工して作成/);
  // 国土地理院: 「国土地理院」「地理院タイル」と一覧へのリンク、追記して掲載
  expect(all).toContain("出典：国土地理院");
  expect(all).toContain("地理院タイルに");
  expect(all).toContain("を追記して掲載");
  expect(links).toContain("https://maps.gsi.go.jp/development/ichiran.html");
  // 写真の備考 (GRUS) と都市圏活断層図の調査者
  expect(all).toContain("GRUS画像（© Axelspace）");
  expect(all).toContain("調査者");
  // ハザードマップポータルサイトの出典の記載方法
  expect(all).toContain("出典：「ハザードマップポータルサイト」");
  expect(all).toContain("「ハザードマップポータルサイト」を加工して作成");
  // USGS・EMSC
  expect(all).toContain("courtesy of the U.S. Geological Survey");
  expect(all).toContain(
    "EMSC-CSEM SeismicPortal, https://www.seismicportal.eu",
  );
});

test("出典のリンクはどれも https", () => {
  for (const h of links) expect(h).toStartWith("https://");
});

test("地図の隅の短い出典: 映している層に合わせる", () => {
  expect(mapCredit({ hazard: "", grus: false })).toBe(
    "出典: 国土地理院・気象庁 ほか",
  );
  expect(
    mapCredit({ hazard: "ハザードマップポータルサイト", grus: true }),
  ).toBe(
    "出典: 国土地理院・気象庁・ハザードマップポータルサイト・GRUS画像（© Axelspace） ほか",
  );
  // 活断層図は、選んで映しているときだけ足す
  expect(mapCredit({ hazard: "都市圏活断層図", grus: false })).toBe(
    "出典: 国土地理院・気象庁・都市圏活断層図 ほか",
  );
});

test("GRUS 画像の範囲 (沖ノ鳥島のあたり) を映しているか", () => {
  // 沖ノ鳥島に寄せたところ (写真のタイル)
  expect(showsGrus([136.07, 20.42, 136.09, 20.43], 15)).toBe(true);
  // 日本全体は範囲を含むが、写真のタイル (ズーム 14〜) ではなく衛星のモザイク
  expect(showsGrus([122, 20, 154, 46], 4)).toBe(false);
  // 寄せていても本州だけ
  expect(showsGrus([139.7, 35.6, 139.8, 35.7], 15)).toBe(false);
});
