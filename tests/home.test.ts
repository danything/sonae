import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { byPrefecture, type Cities, homeOf, prefectureOf } from "#lib/home.ts";

const cities = JSON.parse(
  readFileSync("static/areas/cities.json", "utf8"),
) as Cities;

test("都道府県の選ぶ欄: 47 都道府県が全部、名前つきで並ぶ", () => {
  const groups = byPrefecture(cities);
  expect(groups.length).toBe(47);
  for (const g of groups) {
    expect(g.pref).not.toBe("");
    expect(g.pref).toBe(prefectureOf(g.cities[0]?.code ?? ""));
  }
  // 先頭の市町村等が 2 つに分けた市 (説明の文の列) の県も名前が出る
  const names = groups.map((g) => g.pref);
  expect(names).toContain("宮城県");
  expect(names).toContain("神奈川県");
  expect(names).toContain("富山県");
});

test("都道府県の名前はコードの上 2 桁から引く", () => {
  expect(prefectureOf("0110000")).toBe("北海道");
  expect(prefectureOf("1310100")).toBe("東京都");
  expect(prefectureOf("4720100")).toBe("沖縄県");
  expect(prefectureOf("9900000")).toBe("");
});

test("住んでいる地域の名前は「都道府県 + 市町村等」(分けた市でも説明の文にしない)", () => {
  expect(homeOf("0410001", cities, new Map())?.name).toBe("宮城県仙台市東部");
  expect(homeOf("1410011", cities, new Map())?.name).toBe("神奈川県横浜市北部");
  expect(homeOf("1310100", cities, new Map())?.name).toBe("東京都千代田区");
});
