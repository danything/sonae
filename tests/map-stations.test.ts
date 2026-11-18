import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  stationAt,
  stationFeatures,
  stationIndex,
  stationKey,
  type StationTable,
} from "#lib/map/stations.ts";
import { QUAKE_FILL_OPACITY, quakeFillOpacity } from "#lib/map/style.ts";
import type { StationIntensity } from "#lib/model.ts";
import { parseJmaXml } from "#lib/server/sources/jma-xml.ts";
import { parseP2p } from "#lib/server/sources/p2p-json.ts";

import { codeOf, fixture, json } from "./helpers.ts";

const TABLE = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "static", "areas", "intensity-stations.json"),
    "utf8",
  ),
) as StationTable;
const index = stationIndex(TABLE);

const small: StationTable = {
  "2230630": [138.78, 34.77, "西伊豆町仁科"],
  "3520601": [131.56, 34.05, "防府市寿町", "防府市寿"],
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

describe("配る表 (static/areas/intensity-stations.json)", () => {
  test("コード表の観測点のほとんどに位置がある", () => {
    expect(Object.keys(TABLE).length).toBeGreaterThan(4300);
    for (const [code, [lon, lat]] of Object.entries(TABLE)) {
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

test("地域の塗りは、観測点の丸を出しているときだけ寄せるほど薄くする", () => {
  expect(quakeFillOpacity(false)).toBe(QUAKE_FILL_OPACITY);
  const e = quakeFillOpacity(true);
  expect(Array.isArray(e)).toBe(true);
  expect(JSON.stringify(e)).toContain('["zoom"]');
});
