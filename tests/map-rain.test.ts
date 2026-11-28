import { expect, test } from "bun:test";

import {
  latestRain,
  nextRainPoll,
  RAIN_LEGEND,
  RAIN_RETRY_MS,
  RAIN_TILE_ZOOMS,
  rainIso,
  rainLayerZoom,
  rainStale,
  rainTiles,
} from "#lib/map/rain.ts";
import {
  baseStyle,
  HIDDEN_UNDER_HAZARD,
  HIDDEN_UNDER_QUAKE,
  MAP_LEGEND,
  overlayVisibility,
  rainShown,
  rainVisibility,
  readHazard,
  SHOWN_UNDER_HAZARD,
} from "#lib/map/style.ts";
import { CREDITS, creditText } from "#lib/notice.ts";

// targetTimes_N1.json の形 (2026-11-20 に取ったものを縮めた。新しい順)
const N1 = [
  {
    basetime: "20261120141500",
    validtime: "20261120141500",
    elements: ["hrpns", "hrpns_nd"],
  },
  {
    basetime: "20261120141000",
    validtime: "20261120141000",
    elements: ["hrpns", "hrpns_nd"],
  },
];

test("時刻の表から、いちばん新しい観測を選ぶ。予測と読めない行は使わない", () => {
  expect(latestRain(N1)).toEqual({
    basetime: "20261120141500",
    validtime: "20261120141500",
  });
  // 並びが逆でも新しいものを選ぶ
  expect(latestRain([...N1].reverse())?.validtime).toBe("20261120141500");
  // 予測 (N2 の形。validtime が先) は使わない
  expect(
    latestRain([
      {
        basetime: "20261120141500",
        validtime: "20261120151500",
        elements: ["hrpns"],
      },
      ...N1.slice(1),
    ])?.validtime,
  ).toBe("20261120141000");
  // 降水強度 (hrpns) の無い行・形の違う時刻は使わない
  expect(
    latestRain([
      {
        basetime: "20261120142000",
        validtime: "20261120142000",
        elements: ["thns"],
      },
      { basetime: "2026-11-20", validtime: "2026-11-20" },
      null,
    ]),
  ).toBeNull();
  expect(latestRain({})).toBeNull();
  expect(latestRain([])).toBeNull();
});

test("タイルの URL と観測の時刻 (UTC の表を ISO に)", () => {
  const f = { basetime: "20261120141500", validtime: "20261120141500" };
  expect(rainTiles(f)).toBe(
    "/relay/jmatile/nowc/20261120141500/none/20261120141500/surf/hrpns/{z}/{x}/{y}.png",
  );
  expect(rainIso(f)).toBe("2026-11-20T14:15:00Z");
});

test("次に取得するのは、次の観測が出そろう頃 (5 分 + 90 秒)。過ぎていれば 1 分後", () => {
  const f = { basetime: "20261120141500", validtime: "20261120141500" };
  const t = Date.parse("2026-11-20T14:15:00Z");
  // 14:15:30 に取れたら、14:21:30 に取る
  expect(nextRainPoll(f, t + 30_000)).toBe(6 * 60_000);
  // 14:21:30 を過ぎても 14:15 のままなら (遅れている)、1 分後に取り直す
  expect(nextRainPoll(f, t + 7 * 60_000)).toBe(RAIN_RETRY_MS);
  expect(nextRainPoll(null, t)).toBe(RAIN_RETRY_MS);
  // 端末の時計が遅れていても、待ちは 6 分半を超えない
  expect(nextRainPoll(f, t - 60 * 60_000)).toBe(6.5 * 60_000);
});

test("15 分より前の観測は古いとみなす", () => {
  const f = { basetime: "20261120141500", validtime: "20261120141500" };
  const t = Date.parse("2026-11-20T14:15:00Z");
  expect(rainStale(f, t + 15 * 60_000)).toBe(false);
  expect(rainStale(f, t + 15 * 60_000 + 1)).toBe(true);
});

test("タイルは偶数のズームだけ。段ごとに、地図のズーム n − 1 から n + 1 の手前で出す", () => {
  expect([...RAIN_TILE_ZOOMS]).toEqual([4, 6, 8, 10]);
  expect(rainLayerZoom(4)).toEqual({ maxzoom: 5 });
  expect(rainLayerZoom(6)).toEqual({ minzoom: 5, maxzoom: 7 });
  expect(rainLayerZoom(8)).toEqual({ minzoom: 7, maxzoom: 9 });
  expect(rainLayerZoom(10)).toEqual({ minzoom: 9 });
  const style = baseStyle("", "rain", {
    basetime: "20261120141500",
    validtime: "20261120141500",
  }) as {
    sources: Record<
      string,
      { tiles?: string[]; minzoom?: number; maxzoom?: number }
    >;
    layers: {
      id: string;
      minzoom?: number;
      maxzoom?: number;
      layout?: { visibility?: string };
    }[];
  };
  for (const n of RAIN_TILE_ZOOMS) {
    const src = style.sources[`rain-${n}`];
    expect([src?.minzoom, src?.maxzoom]).toEqual([n, n]);
    expect(src?.tiles?.[0]).toContain("/20261120141500/surf/hrpns/");
    const layer = style.layers.find((l) => l.id === `rain-${n}`);
    expect(layer?.layout?.visibility).toBe("visible");
  }
  // 時刻がまだ分からない間は出さない
  const waiting = baseStyle("", "rain") as typeof style;
  expect(
    waiting.layers
      .filter((l) => l.id.startsWith("rain-"))
      .map((l) => l.layout?.visibility),
  ).toEqual(["none", "none", "none", "none"]);
});

test("雨雲は重ねる図の 1 つ。選ぶと警報・注意報の塗りを隠し、地震を選んでいる間は雨雲を隠す", () => {
  expect(readHazard("rain")).toBe("rain");
  // ハザードマップとは同時に出さない (1 つだけ選ぶ)
  expect(
    Object.values(rainVisibility("flood", false, true)).some(Boolean),
  ).toBe(false);
  expect(
    Object.values(rainVisibility("rain", false, true)).every(Boolean),
  ).toBe(true);
  expect(
    Object.values(rainVisibility("rain", false, false)).some(Boolean),
  ).toBe(false);
  // 雨雲を重ねている間は、ハザードマップと同じく面の塗りを隠し、特別警報は縁取りで残す
  const on = overlayVisibility("rain", 5, false);
  for (const l of HIDDEN_UNDER_HAZARD) expect(on[l]).toBe(false);
  for (const l of SHOWN_UNDER_HAZARD) expect(on[l]).toBe(true);
  // 地震を選んでいる間は雨雲を隠す (色が震度の色と同じ)。震度の塗りは出し、警報・注意報は地震の決まりで隠す
  expect(rainShown("rain", true)).toBe(false);
  expect(Object.values(rainVisibility("rain", true, true)).some(Boolean)).toBe(
    false,
  );
  const quake = overlayVisibility("rain", 5, true);
  expect(quake["quake-fill"]).toBe(true);
  expect(quake["eew-fill"]).toBe(true);
  for (const l of HIDDEN_UNDER_QUAKE) expect(quake[l]).toBe(false);
});

test("凡例は気象庁の配色の指針の降水量の 8 色、出典と地図の見方に雨雲がある", () => {
  expect(RAIN_LEGEND.map((l) => l.color)).toEqual([
    "rgb(180 0 104)",
    "rgb(255 40 0)",
    "rgb(255 153 0)",
    "rgb(250 245 0)",
    "rgb(0 65 255)",
    "rgb(33 140 255)",
    "rgb(160 210 255)",
    "rgb(242 242 255)",
  ]);
  const credit = CREDITS.find((c) => c.label === "雨雲");
  expect(credit && creditText(credit)).toContain(
    "気象庁「高解像度降水ナウキャスト」を加工して作成",
  );
  expect(credit && creditText(credit)).toContain("予測は出さず");
  expect(MAP_LEGEND.find((l) => l.label === "雨雲")?.note).toContain(
    "地震を選んでいる間は雨雲を隠します",
  );
});
