import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  nearestStation,
  stationAt,
  stationFeatures,
  stationIndex,
  stationInfo,
  stationKey,
  stationPopup,
  type StationTable,
} from "#lib/map/stations.ts";
import { QUAKE_FILL_OPACITY, quakeFillOpacity } from "#lib/map/style.ts";
import type { StationIntensity } from "#lib/model.ts";
import { parseJmaXml } from "#lib/server/sources/jma-xml.ts";
import { parseP2p } from "#lib/server/sources/p2p-json.ts";

import { codeOf, fixture, json } from "./helpers.ts";

const TABLE = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "..",
      "static",
      "areas",
      "intensity-stations-v2.json",
    ),
    "utf8",
  ),
) as StationTable;
const index = stationIndex(TABLE);

const small: StationTable = {
  cities: ["西伊豆町", "防府市"],
  stations: {
    "2230630": [138.78, 34.77, 1, 0, "西伊豆町仁科"],
    "3520601": [131.56, 34.05, 0, 1, "防府市寿町", "防府市寿"],
    "9990001": [139.0, 35.0, -1, -1, "どこか町"],
  },
};

describe("名前をそろえる", () => {
  test("気象庁の XML の「＊」と前後の空白を外す", () => {
    expect(stationKey("西伊豆町仁科＊")).toBe("西伊豆町仁科");
    expect(stationKey(" 熱海市泉＊ ")).toBe("熱海市泉");
    expect(stationKey("宮古島市城辺福北")).toBe("宮古島市城辺福北");
  });
});

describe("位置を引く", () => {
  const idx = stationIndex(small);

  test("コードがあればコードで引く (名前が違っても)", () => {
    expect(
      stationAt({ code: "2230630", name: "前の名前＊", int: "3" }, idx),
    ).toEqual([138.78, 34.77]);
  });

  test("コードが無ければ名前で引く (P2P と、コードを読む前に受けた報)", () => {
    expect(stationAt({ name: "西伊豆町仁科", int: "3" }, idx)).toEqual([
      138.78, 34.77,
    ]);
    expect(stationAt({ name: "西伊豆町仁科＊", int: "3" }, idx)).toEqual([
      138.78, 34.77,
    ]);
  });

  test("別名 (位置の表の前の名前) でも引ける", () => {
    expect(stationAt({ name: "防府市寿", int: "1" }, idx)).toEqual([
      131.56, 34.05,
    ]);
    expect(stationAt({ name: "防府市寿町", int: "1" }, idx)).toEqual([
      131.56, 34.05,
    ]);
  });

  test("表に無いコードで、名前でも引けなければ無い", () => {
    expect(
      stationAt({ code: "1320632", name: "東京府中市宮西町＊", int: "2" }, idx),
    ).toBeUndefined();
  });
});

describe("地図に置く点", () => {
  const idx = stationIndex(small);
  const stations: StationIntensity[] = [
    { code: "3520601", name: "防府市寿町", int: "1" },
    { code: "2230630", name: "西伊豆町仁科＊", int: "5-" },
    { name: "東京府中市宮西町＊", int: "2" },
    { name: "どこか＊", int: "5-?" },
  ];

  test("位置の引けない観測点は点にせず、名前を返す", () => {
    const r = stationFeatures(stations, idx);
    expect(r.data.features).toHaveLength(2);
    expect(r.missing).toEqual(["東京府中市宮西町＊"]);
  });

  test("5弱以上未入電は点にも、引けない数にも入れない", () => {
    const r = stationFeatures(stations, idx);
    expect(r.data.features.some((f) => f.properties.int === "5-?")).toBe(false);
    expect(r.missing).not.toContain("どこか＊");
  });

  test("震度の小さいほうから並べ、大きい震度ほど order が大きい (上に描く)", () => {
    const f = stationFeatures(stations, idx).data.features;
    expect(f.map((x) => x.properties.int)).toEqual(["1", "5-"]);
    expect(f[1]?.properties.order).toBeGreaterThan(f[0]?.properties.order ?? 0);
    expect(f[1]?.properties.color).toBe("rgb(255 230 0)");
  });
});

describe("配る表 (static/areas/intensity-stations-v2.json)", () => {
  test("コード表の観測点のほとんどに位置がある", () => {
    expect(Object.keys(TABLE.stations).length).toBeGreaterThan(4300);
    for (const [code, [lon, lat, affi, city]] of Object.entries(
      TABLE.stations,
    )) {
      expect([0, 1, 2]).toContain(affi as number);
      expect(TABLE.cities[city as number]).toBeTruthy();
      expect(code).toMatch(/^\d{7}$/);
      expect(lon).toBeGreaterThan(122);
      expect(lon).toBeLessThan(154);
      expect(lat).toBeGreaterThan(20);
      expect(lat).toBeLessThan(46);
    }
  });

  test("コード表に無いが、まだ電文に並ぶ前の観測点も引ける (tools/stations/extra.tsv)", () => {
    expect(
      stationAt({ code: "4520120", name: "宮崎市松橋＊", int: "1" }, index),
    ).toEqual([131.42, 31.91]);
    expect(stationAt({ name: "防府市寿", int: "1" }, index)).toEqual([
      131.56, 34.05,
    ]);
  });

  test("気象庁の XML (VXSE53) の観測点を引ける", () => {
    const file = "32-35_06_04_240613_VXSE53.xml";
    const item = parseJmaXml(fixture(`jma/${file}`), codeOf(file))[0];
    if (item?.type !== "quake") throw new Error("quake ではない");
    const { stations } = item.report;
    expect(stations.length).toBeGreaterThan(100);
    expect(stations.every((s) => s.code?.length === 7)).toBe(true);
    // サンプル電文 (2008 年の地震) の後に移した・やめた観測点は引けない。引けるものがほとんど
    const r = stationFeatures(stations, index);
    expect(r.data.features.length).toBeGreaterThan(stations.length * 0.8);
  });

  test("P2P地震情報の観測点 (＊の無い名前) を引ける", () => {
    const [item] = parseP2p(json("p2p/spec-551.json"));
    if (item?.type !== "quake") throw new Error("quake ではない");
    const r = stationFeatures(item.report.stations, index);
    expect(r.data.features).toHaveLength(1);
    // 仕様書の例 (2019 年) の「宮古島市伊良部長浜」は、いまのコード表に無い (いまは「宮古島市伊良部前里添」)
    expect(r.missing).toEqual(["宮古島市伊良部長浜"]);
  });
});

describe("観測点の吹き出し", () => {
  const idx = stationIndex(small);
  const popup = (s: StationIntensity) => {
    const info = stationInfo(s, idx);
    if (!info) throw new Error("引けない");
    return stationPopup(s, info);
  };

  test("名前は「＊」を外し、震度のラベル・都道府県と市町村・設置者を出す", () => {
    expect(
      popup({ code: "2230630", name: "西伊豆町仁科＊", int: "5-" }),
    ).toEqual({
      name: "西伊豆町仁科",
      label: "震度5弱",
      place: "静岡県・西伊豆町",
      owner: "地方公共団体の観測点",
    });
    expect(popup({ name: "防府市寿", int: "1" })).toEqual({
      name: "防府市寿",
      label: "震度1",
      place: "山口県・防府市",
      owner: "気象庁の観測点",
    });
  });

  test("表に設置者が無ければ、「＊」の有無で分かるだけを出す (P2P は印が無いので出さない)", () => {
    expect(popup({ code: "9990001", name: "どこか町＊", int: "2" }).owner).toBe(
      "気象庁以外の観測点",
    );
    expect(popup({ code: "9990001", name: "どこか町", int: "2" }).owner).toBe(
      "気象庁の観測点",
    );
    expect(popup({ name: "どこか町", int: "2" }).owner).toBe("");
    // 都道府県は電文のものを使う
    expect(popup({ name: "どこか町", pref: "群馬県", int: "2" }).place).toBe(
      "群馬県",
    );
  });

  test("点に吹き出しの中身を持たせる", () => {
    const f = stationFeatures(
      [{ code: "2230630", name: "西伊豆町仁科＊", int: "3" }],
      idx,
    ).data.features[0];
    expect(f?.properties.name).toBe("西伊豆町仁科");
    expect(f?.properties.label).toBe("震度3");
    expect(f?.properties.owner).toBe("地方公共団体の観測点");
  });

  test("配る表の観測点は、どれも設置者と市町村が分かる", () => {
    const i = stationIndex(TABLE);
    const info = stationInfo({ code: "0123500", name: "", int: "1" }, i);
    expect(info?.pref).toBe("北海道");
    expect(info?.city).toBe("石狩市");
    for (const v of i.byCode.values()) {
      expect(v.owner).toBeDefined();
      expect(v.city).not.toBe("");
      expect(v.pref).not.toBe("");
    }
  });
});

describe("押した所の観測点", () => {
  test("いちばん近いものを選び、同じ近さなら大きい震度 (上に描いているもの)", () => {
    expect(
      nearestStation([
        { d2: 100, order: 9, id: "a" },
        { d2: 4, order: 1, id: "b" },
        { d2: 4, order: 5, id: "c" },
      ])?.id,
    ).toBe("c");
    expect(nearestStation([])).toBeUndefined();
  });
});

test("地域の塗りは、観測点の丸を出しているときだけ寄せるほど薄くする", () => {
  expect(quakeFillOpacity(false)).toBe(QUAKE_FILL_OPACITY);
  const e = quakeFillOpacity(true);
  expect(Array.isArray(e)).toBe(true);
  expect(JSON.stringify(e)).toContain('["zoom"]');
});
