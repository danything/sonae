import { expect, test } from "bun:test";

import {
  latestRisk,
  nextRiskPoll,
  RISK_LEGEND,
  RISK_RETRY_MS,
  RISK_TILE_ZOOMS,
  riskIso,
  riskOf,
  RISKS,
  riskStale,
  riskTiles,
} from "#lib/map/risk.ts";
import {
  baseStyle,
  HIDDEN_UNDER_HAZARD,
  HIDDEN_UNDER_QUAKE,
  MAP_LEGEND,
  overlayVisibility,
  rainVisibility,
  readHazard,
  riskShown,
  riskVisibility,
  SHOWN_UNDER_HAZARD,
} from "#lib/map/style.ts";
import { CREDITS, creditText } from "#lib/notice.ts";

const ELEMENTS = [
  "land",
  "inund",
  "flood_mesh",
  "rain_mesh",
  "flood",
  "designated_river",
  "inland_flood",
  "designated_river_nation",
  "flood_riskline",
];
// targetTimes.json の形 (2026-11-21 に取ったものを縮めた。新しい順。新しい 3 枚は member が immed0〜2)
const TIMES = [
  {
    basetime: "20261120155000",
    validtime: "20261120155000",
    member: "immed0",
    elements: ELEMENTS,
  },
  {
    basetime: "20261120154000",
    validtime: "20261120154000",
    member: "immed1",
    elements: ELEMENTS,
  },
  {
    basetime: "20261120151000",
    validtime: "20261120151000",
    member: "none",
    elements: ELEMENTS,
  },
];

test("時刻の表から、選んだキキクルのいちばん新しい 1 枚を選ぶ。読めない行は使わない", () => {
  expect(latestRisk(TIMES, "land")).toEqual({
    basetime: "20261120155000",
    validtime: "20261120155000",
    member: "immed0",
  });
  expect(latestRisk([...TIMES].reverse(), "rain_mesh")?.validtime).toBe(
    "20261120155000",
  );
  // その要素が無い行・URL に入れられない member・時刻の違う行は使わない
  expect(
    latestRisk(
      [
        { ...TIMES[0], elements: ["inund"] },
        { ...TIMES[1], member: "../x" },
        { ...TIMES[2], validtime: "20261120161000" },
        null,
      ],
      "land",
    ),
  ).toBeNull();
  expect(latestRisk({}, "land")).toBeNull();
});

test("タイルの URL と判定の時刻", () => {
  const f = {
    basetime: "20261120155000",
    validtime: "20261120155000",
    member: "immed0",
  };
  expect(riskTiles(f, "land")).toBe(
    "https://www.jma.go.jp/bosai/jmatile/data/risk/20261120155000/immed0/20261120155000/surf/land/{z}/{x}/{y}.png",
  );
  expect(riskTiles(f, "rain_mesh")).toContain("/surf/rain_mesh/");
  expect(riskIso(f)).toBe("2026-11-20T15:50:00Z");
});

test("取りに行くのは、次の時刻が表に載る頃 (10 分 + 11 分 30 秒)。過ぎていれば 1 分後。40 分より前は古い", () => {
  const f = {
    basetime: "20261120155000",
    validtime: "20261120155000",
    member: "immed0",
  };
  const t = Date.parse("2026-11-20T15:50:00Z");
  // 16:00:30 に取れたら、16:11:30 に取る
  expect(nextRiskPoll(f, t + 10.5 * 60_000)).toBe(11 * 60_000);
  expect(nextRiskPoll(f, t + 22 * 60_000)).toBe(RISK_RETRY_MS);
  expect(nextRiskPoll(null, t)).toBe(RISK_RETRY_MS);
  expect(nextRiskPoll(f, t - 60 * 60_000)).toBe(21.5 * 60_000);
  expect(riskStale(f, t + 40 * 60_000)).toBe(false);
  expect(riskStale(f, t + 40 * 60_000 + 1)).toBe(true);
});

test("キキクルは重ねる図の 1 つ。土砂と大雨を選べ、選ぶと警報・注意報の塗りを隠し、地震を選んでいる間は隠す", () => {
  expect(RISKS.map((r) => [r.id, r.element])).toEqual([
    ["risk-land", "land"],
    ["risk-heavyrain", "rain_mesh"],
  ]);
  expect(readHazard("risk-land")).toBe("risk-land");
  expect(readHazard("risk-heavyrain")).toBe("risk-heavyrain");
  expect(readHazard("risk-inund")).toBe("none");
  expect(riskOf("rain")).toBeUndefined();
  // 雨雲とは同時に出さない
  expect(
    Object.values(rainVisibility("risk-land", false, true)).some(Boolean),
  ).toBe(false);
  expect(Object.values(riskVisibility("rain", false, true)).some(Boolean)).toBe(
    false,
  );
  expect(
    Object.values(riskVisibility("risk-heavyrain", false, true)).every(Boolean),
  ).toBe(true);
  expect(
    Object.values(riskVisibility("risk-land", false, false)).some(Boolean),
  ).toBe(false);
  const on = overlayVisibility("risk-land", 5, false);
  for (const l of HIDDEN_UNDER_HAZARD) expect(on[l]).toBe(false);
  for (const l of SHOWN_UNDER_HAZARD) expect(on[l]).toBe(true);
  expect(riskShown("risk-land", true)).toBe(false);
  const quake = overlayVisibility("risk-land", 5, true);
  expect(quake["quake-fill"]).toBe(true);
  for (const l of HIDDEN_UNDER_QUAKE) expect(quake[l]).toBe(false);
});

test("層は偶数のズームの段ごと。選んだキキクルの URL を持つ", () => {
  const style = baseStyle("", "risk-heavyrain", null, {
    basetime: "20261120155000",
    validtime: "20261120155000",
    member: "immed0",
  }) as {
    sources: Record<
      string,
      { tiles?: string[]; minzoom?: number; maxzoom?: number }
    >;
    layers: { id: string; layout?: { visibility?: string } }[];
  };
  for (const n of RISK_TILE_ZOOMS) {
    const src = style.sources[`risk-${n}`];
    expect([src?.minzoom, src?.maxzoom]).toEqual([n, n]);
    expect(src?.tiles?.[0]).toContain("/immed0/20261120155000/surf/rain_mesh/");
    expect(
      style.layers.find((l) => l.id === `risk-${n}`)?.layout?.visibility,
    ).toBe("visible");
  }
  const waiting = baseStyle("", "risk-land") as typeof style;
  expect(
    waiting.layers
      .filter((l) => l.id.startsWith("risk-"))
      .map((l) => l.layout?.visibility),
  ).toEqual(["none", "none", "none", "none"]);
});

test("凡例は気象庁の配色の指針の表 1-1 の 4 色、出典と地図の見方にキキクルがある", () => {
  expect(RISK_LEGEND.map((l) => [l.color, l.label])).toEqual([
    ["rgb(12 0 12)", "災害切迫"],
    ["rgb(170 0 170)", "危険"],
    ["rgb(255 40 0)", "警戒"],
    ["rgb(242 231 0)", "注意"],
  ]);
  const credit = CREDITS.find((c) => c.label === "キキクル");
  expect(credit && creditText(credit)).toContain(
    "気象庁「キキクル（危険度分布）」",
  );
  expect(MAP_LEGEND.find((l) => l.label === "キキクル")?.note).toContain(
    "地震を選んでいる間はキキクルを隠します",
  );
});
