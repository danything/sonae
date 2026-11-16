import { describe, expect, test } from "bun:test";

import {
  byPrefecture,
  type Cities,
  cityAt,
  homeOf,
  prefectureOf,
} from "#lib/home.ts";

import { cities } from "./helpers.ts";

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

describe("住んでいる地域を選ぶ", () => {
  const small: Cities = {
    "3220100": ["松江市", "島根県松江市", "320000", "320010", "320011", "570"],
    "3220300": ["出雲市", "島根県出雲市", "320000", "320010", "320012", "570"],
    "1310100": [
      "千代田区",
      "東京都千代田区",
      "130000",
      "130010",
      "130011",
      "350",
    ],
  };
  test("市町村等の表から、地震情報／細分区域と府県予報区を引く", () => {
    expect(homeOf("3220100", small, new Map([["570", "島根県東部"]]))).toEqual({
      code: "3220100",
      name: "島根県松江市",
      quake: { code: "570", name: "島根県東部" },
      office: "320000",
      ichiji: "320010",
      // 表に津波予報区の列が無ければ、海に面していないものとして空
      tsunami: [],
    });
    expect(homeOf("9999999", small, new Map())).toBeNull();
  });
  test("都道府県ごとに束ねる", () => {
    expect(byPrefecture(small).map((g) => [g.pref, g.cities.length])).toEqual([
      ["東京都", 1],
      ["島根県", 2],
    ]);
  });
  test("位置が入る市町村等 (穴は外す)", () => {
    const features = [
      {
        properties: { code: "1" },
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
            [
              [4, 4],
              [6, 4],
              [6, 6],
              [4, 6],
              [4, 4],
            ],
          ] as [number, number][][],
        },
      },
    ];
    expect(cityAt(2, 2, features)).toBe("1");
    expect(cityAt(5, 5, features)).toBeNull();
    expect(cityAt(20, 20, features)).toBeNull();
  });
});
