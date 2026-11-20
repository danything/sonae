import { describe, expect, test } from "bun:test";

import {
  circleOf,
  dayHour,
  envelope,
  nearestTyphoonPoint,
  TYPHOON_STALE_MS,
  typhoonBounds,
  typhoonFeatures,
  typhoonName,
  typhoonPopup,
  typhoonsOnMap,
} from "#lib/map/typhoon.ts";
import type { WeatherInfo } from "#lib/model.ts";
import { parseWeatherXml } from "#lib/server/sources/jma-weather.ts";
import { homeProbability } from "#lib/typhoon-prob.ts";

import { fixture, memoryStore } from "./helpers.ts";

const parse = (file: string, code: string) =>
  parseWeatherXml(fixture(`jma/${file}`), code);

function info(file: string, code = "VPTW60"): WeatherInfo {
  const [item] = parse(file, code);
  if (item?.type !== "weather") throw new Error("気象の報ではありません");
  return { ...item.info, cancelled: false, updatedAt: item.info.reportedAt };
}

const PROB = "made-76_01_01_200630_VPTA50-4areas.xml";
function probability() {
  const [item] = parse(PROB, "VPTA50");
  if (item?.type !== "typhoonprob") throw new Error("確率ではありません");
  return item;
}

describe("台風解析・予報情報の予報", () => {
  test("3 時間ごとと 5 日先までの予報円・暴風警戒域・強さを、電文の値のまま時刻の順に持つ", () => {
    const w = info("10_04_03_170913_VPTW60.xml");
    expect(w.typhoon?.storm).toEqual({
      lat: 25.5,
      lon: 125.5,
      axes: [{ km: 150 }],
    });
    expect(w.typhoon?.gale).toEqual({
      lat: 25.5,
      lon: 125.5,
      axes: [{ km: 390 }],
    });
    const fcs = w.typhoonForecasts ?? [];
    expect(fcs.map((f) => f.hours)).toEqual([
      3, 6, 9, 12, 15, 18, 21, 24, 48, 72, 96, 120,
    ]);
    expect(fcs[7]).toMatchObject({
      hours: 24,
      time: "2017-09-14T21:00:00+09:00",
      circle: { lat: 27.5, lon: 124.1, axes: [{ km: 110 }] },
      stormWarning: [{ km: 280 }],
      pressureHpa: 940,
      maxWindMs: 45,
    });
    // 120 時間後は暴風警戒域が「なし」
    expect(fcs[11]?.stormWarning).toBeUndefined();
    expect(fcs[11]?.circle.axes).toEqual([{ km: 650 }]);
  });

  test("推定 (１時間後) は予報に入れない。予報の無い報 (消滅) は空", () => {
    expect(info("10_04_07_170916_VPTW60.xml").typhoonForecasts).toEqual([]);
    expect(info("10_04_08_170918_VPTW60.xml").typhoonForecasts).toEqual([]);
  });

  test("暴風警戒域が方向で違うときは、方向ごとの半径を持つ。暴風域の無い台風は暴風域を持たない", () => {
    const w = info("10_03_01_171016_VPTW60.xml");
    expect(w.typhoon?.storm).toBeUndefined();
    const f96 = w.typhoonForecasts?.find((f) => f.hours === 96);
    expect(f96?.stormWarning).toEqual([
      { direction: "南東", km: 600 },
      { direction: "北西", km: 540 },
    ]);
  });

  test("台風番号の無い熱帯低気圧は種類の名前で呼ぶ", () => {
    const w = info("10_05_06_200826_VPTW62.xml", "VPTW62");
    expect(w.typhoon?.number).toBeUndefined();
    expect(typhoonName(w.typhoon ?? {})).toBe("熱帯低気圧");
    expect(typhoonName({ number: "1718" })).toBe("台風第 18 号");
  });
});

describe("台風の暴風域に入る確率", () => {
  test("地域ごとに 3 時間ごとと 1〜5 日の積算を読み、どれも 0% の地域は持たない", () => {
    const item = probability();
    const p = item.probability;
    expect(item.infoType).toBe("発表");
    expect(p.series).toBe("typhoon-TC2001");
    expect(p.number).toBe("2001");
    expect(p.dayHours).toEqual([24, 48, 72, 96, 120]);
    expect(p.stepTimes).toHaveLength(40);
    expect(p.stepTimes[0]).toBe("2020-09-30T15:00:00+09:00");
    // 宗谷北部はどの時刻も 0%
    expect(Object.keys(p.areas).sort()).toEqual(["130011", "180022", "280011"]);
    expect(p.areas["180022"]).toMatchObject({
      name: "嶺南西部",
      days: [0, 0, 34, 34, 34],
    });
    expect(p.areas["180022"]?.steps).toHaveLength(40);
    expect(Math.max(...(p.areas["180022"]?.steps ?? []))).toBe(29);
  });

  test("台風ごとにいちばん新しい報だけを持ち、古い報と取消で置き換えない・消す。一覧のイベントは出さない", () => {
    const { store } = memoryStore();
    const body = fixture(`jma/${PROB}`);
    const item = probability();
    const events = store.ingest({
      source: "jma-weather",
      key: "a",
      code: "VPTA50",
      body,
      items: [item],
    });
    expect(events).toEqual([]);
    expect(store.typhoonProbability("typhoon-TC2001")?.reportedAt).toBe(
      "2021-03-19T16:55:00+09:00",
    );
    // 古い報は捨てる
    const old = {
      ...item,
      probability: {
        ...item.probability,
        reportedAt: "2021-03-19T10:00:00+09:00",
        areas: {},
      },
    };
    store.ingest({
      source: "jma-weather",
      key: "b",
      code: "VPTA50",
      items: [old],
    });
    expect(
      Object.keys(store.typhoonProbability("typhoon-TC2001")?.areas ?? {}),
    ).toHaveLength(3);
    // 取消はその台風の確率を消す
    store.ingest({
      source: "jma-weather",
      key: "c",
      code: "VPTA50",
      items: [{ ...item, infoType: "取消" }],
    });
    expect(store.typhoonProbability("typhoon-TC2001")).toBeUndefined();
  });
});

describe("地図の台風", () => {
  const now = Date.parse("2017-09-13T22:00:00+09:00");

  test("台風ごとにいちばん新しい報だけ。消滅・取消・訓練・12 時間より古い報は描かない", () => {
    const a = info("10_04_03_170913_VPTW60.xml");
    const older = {
      ...a,
      id: "older",
      reportedAt: "2017-09-13T15:00:00+09:00",
    };
    expect(typhoonsOnMap([older, a], now).map((w) => w.id)).toEqual([a.id]);
    expect(typhoonsOnMap([{ ...a, cancelled: true }], now)).toEqual([]);
    expect(typhoonsOnMap([{ ...a, status: "training" }], now)).toEqual([]);
    expect(
      typhoonsOnMap([a], Date.parse(a.reportedAt) + TYPHOON_STALE_MS + 1),
    ).toEqual([]);
    const ended = info("10_04_08_170918_VPTW60.xml");
    expect(typhoonsOnMap([ended], Date.parse(ended.reportedAt))).toEqual([]);
    // 別の台風は同時に描く
    const b = { ...a, id: "b", series: "typhoon-TC9999" };
    expect(typhoonsOnMap([a, b], now)).toHaveLength(2);
  });

  test("予報円・中心を結ぶ線・暴風警戒域・暴風域・強風域の線と、実況と予報の中心の点", () => {
    const a = info("10_04_03_170913_VPTW60.xml");
    const { lines, points } = typhoonFeatures([a], null);
    const kinds = lines.features.map((f) => f.properties.kind);
    expect(kinds.filter((k) => k === "forecast")).toHaveLength(12);
    expect(kinds.filter((k) => k === "track")).toHaveLength(1);
    expect(kinds.filter((k) => k === "storm")).toHaveLength(1);
    expect(kinds.filter((k) => k === "gale")).toHaveLength(1);
    expect(kinds.filter((k) => k === "warning").length).toBeGreaterThan(0);
    expect(points.features).toHaveLength(13);
    expect(points.features[0]?.properties).toMatchObject({
      kind: "now",
      index: -1,
      label: "台風第 18 号",
    });
    expect(points.features[8]?.properties).toMatchObject({
      kind: "forecast",
      index: 7,
      label: "14日 21時",
    });
    // 台風が無ければ何も描かない
    expect(typhoonFeatures([], null).lines.features).toEqual([]);
  });

  test("片寄った円は、向かい合う 2 つの半径を直径の両端にする", () => {
    const c = circleOf({ lat: 20, lon: 130 }, [
      { direction: "南東", km: 600 },
      { direction: "北西", km: 540 },
    ]);
    expect(c.km).toBe(570);
    // 中心は南東へ 30 km ずれる
    expect(c.lat).toBeLessThan(20);
    expect(c.lon).toBeGreaterThan(130);
    expect(circleOf({ lat: 20, lon: 130 }, [{ km: 100 }])).toEqual({
      lat: 20,
      lon: 130,
      km: 100,
    });
  });

  test("暴風警戒域の外周は、どの円の内側にも入らない線だけ", () => {
    const sq = (x: number, y: number, r: number): [number, number][] =>
      Array.from({ length: 33 }, (_, i) => {
        const t = (2 * Math.PI * i) / 32;
        return [x + r * Math.cos(t), y + r * Math.sin(t)];
      });
    // 小さな円が大きな円の中にあれば、外周は大きな円だけ
    const lines = envelope([sq(130, 20, 0.2), sq(130, 20, 2)]);
    for (const l of lines)
      for (const [x, y] of l)
        expect(Math.hypot(x - 130, (y - 20) * 1.06)).toBeGreaterThan(1.8);
    // 1 つなら、その円の周
    expect(envelope([sq(130, 20, 1)]).length).toBe(1);
    expect(envelope([])).toEqual([]);
  });

  test("押した中心の吹き出しに、名前・号数・中心気圧・最大風速・予報の時刻を出す", () => {
    const a = info("10_04_03_170913_VPTW60.xml");
    const fmt = (iso: string) => iso.slice(5, 16);
    const now = typhoonPopup(a, -1, fmt).map((l) => l.text);
    expect(now[0]).toBe("台風第 18 号 (TALIM)");
    expect(now).toContain("中心気圧 950 hPa");
    expect(now.at(-1)).toBe("出典：気象庁 (台風解析・予報情報)");
    const f24 = typhoonPopup(a, 7, fmt).map((l) => l.text);
    expect(f24[1]).toBe("09-14T21:00 の予報 (24 時間後)");
    expect(f24).toContain("最大風速 45 m/s (最大瞬間風速 65 m/s)");
    expect(f24).toContain("予報円の半径 110 km");
    expect(f24).toContain("暴風警戒域の半径 280 km");
  });

  test("寄せる範囲は予報円と暴風警戒域が収まる", () => {
    const a = info("10_04_03_170913_VPTW60.xml");
    const [w, s, e, n] = typhoonBounds(a) ?? [0, 0, 0, 0];
    expect(n).toBeGreaterThan(43.9 + 5); // 120 時間後の予報円 (650 km)
    expect(s).toBeLessThan(25.5 - 3); // 強風域 (390 km)
    expect(w).toBeLessThan(124);
    expect(e).toBeGreaterThan(146.3);
  });

  test("近い点を選び、同じ近さなら実況の中心", () => {
    expect(
      nearestTyphoonPoint([
        { d2: 4, index: 2 },
        { d2: 4, index: -1 },
        { d2: 9, index: 0 },
      ])?.index,
    ).toBe(-1);
    expect(dayHour("2017-09-14T00:00:00+09:00")).toBe("14日 0時");
  });
});

describe("住んでいる地域が暴風域に入る確率", () => {
  test("積算と、0% でない最初から最後までの 3 時間ごと。値の無い地域はどれも 0%", () => {
    const p = probability().probability;
    const h = homeProbability(p, "180022", "嶺南西部");
    expect(h.zero).toBe(false);
    expect(h.days.map((d) => d.p)).toEqual([0, 0, 34, 34, 34]);
    expect(h.days[0]?.until).toBe("2020-10-01T06:00:00.000Z");
    expect(h.steps.length).toBeGreaterThan(0);
    expect(h.steps[0]?.p).toBeGreaterThan(0);
    expect(h.steps.at(-1)?.p).toBeGreaterThan(0);
    expect(h.steps[0]?.to).toBe(
      p.stepTimes[p.stepTimes.indexOf(h.steps[0]?.from ?? "") + 1],
    );
    const z = homeProbability(p, "011011", "宗谷北部");
    expect(z).toMatchObject({ name: "宗谷北部", zero: true, steps: [] });
    expect(z.days.every((d) => d.p === 0)).toBe(true);
  });
});
