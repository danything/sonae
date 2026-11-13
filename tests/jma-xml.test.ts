import { describe, expect, test } from "bun:test";

import type { Quake } from "#lib/model.ts";
import {
  parseFeed,
  parseJmaXml,
  readCoordinate,
  readIntensity,
  WANTED_CODES,
} from "#lib/server/sources/jma-xml.ts";
import type { Normalized } from "#lib/server/sources/types.ts";

import { codeOf, fixture } from "./helpers.ts";

const parse = (file: string) =>
  parseJmaXml(fixture(`jma/${file}`), codeOf(file));
const one = <T extends Normalized["type"]>(file: string, type: T) => {
  const items = parse(file);
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item?.type !== type) throw new Error(`${type} ではありません`);
  return item as Extract<Normalized, { type: T }>;
};

describe("読み方の部品", () => {
  test("震度", () => {
    expect(readIntensity("6-")).toBe("6-");
    expect(readIntensity("震度６弱")).toBe("6-");
    expect(readIntensity("震度４")).toBe("4");
    expect(readIntensity("震度５弱以上未入電")).toBe("5-?");
    expect(readIntensity("なし")).toBeUndefined();
  });
  test("座標 (ISO 6709)", () => {
    expect(readCoordinate("+39.0+140.9-10000/")).toEqual({
      lat: 39,
      lon: 140.9,
      depthKm: 10,
    });
    expect(readCoordinate("-36.1-072.6/")).toEqual({
      lat: -36.1,
      lon: -72.6,
      depthKm: undefined,
    });
    expect(readCoordinate("+35.0+135.0+0/")).toEqual({
      lat: 35,
      lon: 135,
      depthKm: 0,
    });
    expect(readCoordinate("")).toBeUndefined();
  });
});

describe("地震情報", () => {
  test("震度速報 (VXSE51): 地域ごとの震度、震源は無い", () => {
    const { report, eventId, status } = one(
      "32-35_01_01_100806_VXSE51.xml",
      "quake",
    );
    expect(eventId).toBe("20090811050711");
    expect(status).toBe("normal");
    expect(report.kind).toBe("scale");
    expect(report.maxInt).toBe("6-");
    expect(report.hypocenter).toBeUndefined();
    expect(report.targetTime).toBe("2009-08-11T05:07:00+09:00");
    expect(report.areas.find((a) => a.name === "静岡県中部")).toEqual({
      code: "442",
      name: "静岡県中部",
      pref: "静岡県",
      int: "6-",
    });
    expect(report.areas).toHaveLength(37);
  });

  test("震源・震度に関する情報 (VXSE53): 震源・M・観測点、未入電も読む", () => {
    const { report } = one("32-35_06_04_240613_VXSE53.xml", "quake");
    expect(report.kind).toBe("detail");
    expect(report.originTime).toBe("2008-06-14T08:43:00+09:00");
    expect(report.hypocenter).toEqual({
      name: "岩手県内陸南部",
      lat: 39,
      lon: 140.9,
      depthKm: 10,
    });
    expect(report.magnitude).toBe(7);
    expect(report.magnitudeText).toBe("Ｍ７．０");
    expect(report.maxInt).toBe("6+");
    expect(report.stations.some((s) => s.int === "5-?")).toBe(true);
    expect(report.comments).toContain("この地震による津波の心配はありません。");
  });

  test("訓練の電文は status が training", () => {
    expect(one("32-35_01_03_240613_VXSE53.xml", "quake").status).toBe(
      "training",
    );
  });

  test("遠地地震に関する情報", () => {
    const { report } = one("32-39_05_01_100831_VXSE53.xml", "quake");
    expect(report.kind).toBe("foreign");
    expect(report.hypocenter?.lat).toBeLessThan(0);
  });

  test("取消は infoType で分かる", () => {
    const { report } = one("32-35_06_02_100915_VXSE52.xml", "quake");
    expect(report.infoType).toBe("取消");
    expect(report.kind).toBe("hypocenter");
  });

  test("震源要素更新 (VXSE61)", () => {
    const { report, eventId } = one("32-35_03_02_240613_VXSE61.xml", "quake");
    expect(eventId).toBe("20090811050711");
    expect(report.kind).toBe("update");
    expect(report.hypocenter).toEqual({
      name: "駿河湾",
      lat: 34.8,
      lon: 138.5,
      depthKm: 20,
    });
    expect(report.magnitude).toBe(6.5);
  });
});

describe("津波", () => {
  test("VTSE41: 全予報区の状態", () => {
    const { report } = one("32-39_11_02_250206_VTSE41.xml", "tsunami");
    expect(report.eventIds).toEqual(["20110311144640"]);
    const iwate = report.areas?.find((a) => a.name === "岩手県");
    expect(iwate).toMatchObject({
      grade: "major",
      kindName: "大津波警報：発表",
      maxHeightText: "巨大",
      condition: "津波到達中と推測",
    });
    const grades = new Set(report.areas?.map((a) => a.grade));
    expect([...grades].sort()).toEqual([
      "forecast",
      "major",
      "warning",
      "watch",
    ]);
  });
  test("VTSE51: 観測と予報区", () => {
    const { report } = one("32-39_11_10_250206_VTSE51.xml", "tsunami");
    expect(report.observations.length).toBeGreaterThan(0);
    expect(report.observations.every((o) => !o.offshore)).toBe(true);
    expect(report.areas?.length).toBeGreaterThan(0);
  });
  test("VTSE52: 沖合の観測だけ (予報区は無い)", () => {
    const { report } = one("61_11_01_250206_VTSE52.xml", "tsunami");
    expect(report.areas).toBeUndefined();
    expect(report.observations[0]).toMatchObject({
      station: "岩手釜石沖",
      offshore: true,
      initial: "引き",
    });
  });
});

describe("お知らせ", () => {
  test("南海トラフ地震臨時情報 (調査中)", () => {
    const { advisory } = one("74_01_01_200512_VYSE50.xml", "advisory");
    expect(advisory.code).toBe("VYSE50");
    expect(advisory.title).toBe("南海トラフ地震臨時情報（調査中）");
    expect(advisory.serialName).toBe("調査中");
    expect(advisory.text).toContain("評価検討会");
  });
  test("北海道・三陸沖後発地震注意情報", () => {
    const { advisory } = one("80_01_01_260917_VYSE60.xml", "advisory");
    expect(advisory.headline).toContain("三陸沖");
  });
  test("地震・津波に関するお知らせ: 本文は Body/Text", () => {
    const { advisory } = one("42_01_01_100514_VZSE40.xml", "advisory");
    expect(advisory.headline).toBe("沖縄県の震度データ入電停止のお知らせ");
    expect(advisory.text).toContain("入電停止期間");
  });
});

test("フィード: 種別をリンクから取り、取る種別だけを残せる", () => {
  const entries = parseFeed(fixture("jma/made-feed.xml"));
  expect(entries.map((e) => e.code)).toEqual([
    "VFVO53",
    "VXSE53",
    "VXSE52",
    "VXSE56",
  ]);
  expect(entries.filter((e) => WANTED_CODES.has(e.code))).toHaveLength(3);
});

test("サンプルの地震はどれも読める (種類が付く)", () => {
  for (const f of [
    "32-35_01_01_100806_VXSE51.xml",
    "32-35_10_01_220510_VXSE51.xml",
    "32-35_06_01_240613_VXSE52.xml",
    "32-35_06_06_100915_VXSE53.xml",
  ]) {
    const item = parse(f)[0];
    expect(item?.type).toBe("quake");
    expect(
      (item as { report: Quake["reports"][number] }).report.kind,
    ).toBeTruthy();
  }
});
