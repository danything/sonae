import { expect, test } from "bun:test";

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

import {
  forecastFrames,
  hoursAhead,
  latestAnalysis,
  N3_TILE_ZOOMS,
  nextN3Poll,
  NOWC_KINDS,
  nowcStale,
  nowcTiles,
  rasrfStale,
  rasrfTiles,
  slmcsFeatures,
  slmcsUrl,
  stepLayerZoom,
} from "#lib/map/nowc.ts";
import {
  baseStyle,
  nowcShown,
  nowcVisibility,
  overlayVisibility,
  rasrfVisibility,
  readHazard,
} from "#lib/map/style.ts";

/** targetTimes_N3.json の形 (2026-11-21 に取ったものを縮めた) */
const N3 = [
  {
    basetime: "20261120163000",
    validtime: "20261120173000",
    elements: ["thns", "thns_nd", "trns", "trns_nd"],
  },
  {
    basetime: "20261120163000",
    validtime: "20261120164000",
    elements: ["thns", "trns", "slmcs_fcst", "slmcs_unify", "slmcs_unifyfcst"],
  },
  {
    basetime: "20261120163500",
    validtime: "20261120163500",
    elements: ["liden"],
  },
  {
    basetime: "20261120163000",
    validtime: "20261120163000",
    elements: ["thns", "trns", "amds_rain10m", "liden", "slmcs", "slmcs_unify"],
  },
  {
    basetime: "20261120162000",
    validtime: "20261120162000",
    elements: ["thns", "trns", "slmcs", "slmcs_unify"],
  },
];

/** rasrf/targetTimes.json の形 (2026-11-21 に取ったものを縮めた) */
const RASRF = [
  {
    basetime: "20261120160000",
    validtime: "20261121070000",
    member: "none",
    elements: ["rasrf"],
  },
  {
    basetime: "20261120163000",
    validtime: "20261120183000",
    member: "immed",
    elements: ["rasrf", "rasrf03h"],
  },
  {
    basetime: "20261120163000",
    validtime: "20261120173000",
    member: "immed",
    elements: ["rasrf", "rasrf03h"],
  },
  {
    basetime: "20261120164000",
    validtime: "20261120164000",
    member: "none",
    elements: ["rasrf"],
  },
  {
    basetime: "20261120163000",
    validtime: "20261120163000",
    member: "none",
    elements: ["rasrf", "slmcs"],
  },
];

test("雷・竜巻: いちばん新しい解析 (basetime と validtime が同じ) を選び、予測は使わない", () => {
  const f = latestAnalysis(N3, "thns");
  expect(f).toEqual({
    basetime: "20261120163000",
    validtime: "20261120163000",
    member: "none",
  });
  expect(nowcTiles(f!, "thns")).toBe(
    "https://www.jma.go.jp/bosai/jmatile/data/nowc/20261120163000/none/20261120163000/surf/thns/{z}/{x}/{y}.png",
  );
  // 雷の監視 (liden) だけの行は選ばない
  expect(latestAnalysis(N3, "trns")?.validtime).toBe("20261120163000");
  expect(latestAnalysis([], "thns")).toBeNull();
  expect(latestAnalysis("x", "thns")).toBeNull();
  // URL に入れる値は形を確かめる
  expect(
    latestAnalysis(
      [
        {
          basetime: "20261120163000",
          validtime: "20261120163000",
          member: "../x",
          elements: ["thns"],
        },
      ],
      "thns",
    ),
  ).toBeNull();
});

test("雷・竜巻: 凡例は気象庁の色と段。タイルは偶数のズームの 4〜8", () => {
  const thunder = NOWC_KINDS.find((k) => k.id === "thunder");
  expect(thunder?.legend.map((l) => [l.color, l.label])).toEqual([
    ["rgb(200 0 255)", "4"],
    ["rgb(255 40 0)", "3"],
    ["rgb(255 170 0)", "2"],
    ["rgb(255 245 0)", "1"],
  ]);
  const tornado = NOWC_KINDS.find((k) => k.id === "tornado");
  expect(tornado?.legend.map((l) => l.label)).toEqual(["2", "1"]);
  expect(N3_TILE_ZOOMS).toEqual([4, 6, 8]);
  expect(stepLayerZoom(4, N3_TILE_ZOOMS)).toEqual({ maxzoom: 5 });
  expect(stepLayerZoom(6, N3_TILE_ZOOMS)).toEqual({ minzoom: 5, maxzoom: 7 });
  expect(stepLayerZoom(8, N3_TILE_ZOOMS)).toEqual({ minzoom: 7 });
});

test("雷・竜巻: 次の解析が載る頃に取り、古い解析は古いとする", () => {
  const f = latestAnalysis(N3, "thns")!;
  const t = Date.parse("2026-11-20T16:30:00Z");
  // 解析の 10 分後 + 5 分
  expect(nextN3Poll(f, t + 60_000)).toBe(14 * 60_000);
  expect(nextN3Poll(f, t + 20 * 60_000)).toBe(60_000);
  expect(nextN3Poll(null, t)).toBe(60_000);
  expect(nowcStale(f, t + 30 * 60_000)).toBe(false);
  expect(nowcStale(f, t + 36 * 60_000)).toBe(true);
});

test("今後の雨: 予測のあるいちばん新しい basetime の行を、先の時刻の順に並べる", () => {
  const frames = forecastFrames(RASRF);
  expect(frames.map((f) => f.validtime)).toEqual([
    "20261120173000",
    "20261120183000",
  ]);
  expect(frames[0]?.member).toBe("immed");
  expect(hoursAhead(frames[1]!)).toBe(2);
  expect(
    hoursAhead({
      basetime: "20261120163000",
      validtime: "20261120180000",
      member: "immed",
    }),
  ).toBe(1.5);
  expect(rasrfTiles(frames[0]!)).toBe(
    "https://www.jma.go.jp/bosai/jmatile/data/rasrf/20261120163000/immed/20261120173000/surf/rasrf/{z}/{x}/{y}.png",
  );
  expect(forecastFrames([])).toEqual([]);
  // 解析が 80 分より前なら古い (2 回続けて新しい予測が取れていない)
  const t = Date.parse("2026-11-20T16:30:00Z");
  expect(rasrfStale(frames[0]!, t + 60 * 60_000)).toBe(false);
  expect(rasrfStale(frames[0]!, t + 81 * 60_000)).toBe(true);
});

test("線状降水帯: 解析の雨域の GeoJSON を読み、面と線だけを描く", () => {
  const f = latestAnalysis(N3, "slmcs_unify")!;
  expect(slmcsUrl(f)).toBe(
    "https://www.jma.go.jp/bosai/jmatile/data/nowc/20261120163000/none/20261120163000/surf/slmcs_unify/data.geojson",
  );
  // 出ていないときは空の FeatureCollection が来る (2026-11-21 の形)
  expect(slmcsFeatures({ type: "FeatureCollection", features: [] })).toEqual({
    type: "FeatureCollection",
    features: [],
  });
  const ring = [
    [130, 32],
    [131, 32],
    [131, 33],
    [130, 32],
  ];
  const fc = slmcsFeatures({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { x: 1 },
      },
      { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] } },
      { type: "Feature", geometry: null },
    ],
  });
  expect(fc.features.length).toBe(1);
  expect(fc.features[0]?.properties).toEqual({});
  expect(slmcsFeatures(null).features).toEqual([]);
});

test("重ねる図: 雷・竜巻・今後の雨は 1 つだけ選ぶ層。地震を選んでいる間は隠し、選んでいる間は警報・注意報の塗りを隠す", () => {
  for (const id of ["thunder", "tornado", "rain-forecast"])
    expect(readHazard(id)).toBe(id as never);
  expect(nowcShown("thunder", false)).toBe(true);
  expect(nowcShown("thunder", true)).toBe(false);
  expect(nowcShown("rain", false)).toBe(false);
  expect(Object.values(nowcVisibility("tornado", false, true))).toEqual([
    true,
    true,
    true,
  ]);
  expect(Object.values(nowcVisibility("tornado", false, false))).toEqual([
    false,
    false,
    false,
  ]);
  expect(Object.values(nowcVisibility("rain-forecast", false, true))).toEqual([
    false,
    false,
    false,
  ]);
  expect(
    Object.values(rasrfVisibility("rain-forecast", false, true)).every(Boolean),
  ).toBe(true);
  expect(
    Object.values(rasrfVisibility("rain-forecast", true, true)).some(Boolean),
  ).toBe(false);
  expect(overlayVisibility("thunder")["warning-fill"]).toBe(false);
  expect(overlayVisibility("thunder")["warning-special"]).toBe(true);
  // 地震を選んでいる間は雷を隠すので、地震を選んでいる間の決まりだけ (警報・注意報の塗りを隠し、震度の塗りは出す)
  expect(overlayVisibility("thunder", 5, true)["quake-fill"]).toBe(true);
});

test("地図の style: 線状降水帯は警報の面の上・震源の丸の下に、いつも出す", () => {
  const style = baseStyle("", "thunder") as {
    layers: { id: string; layout?: { visibility?: string } }[];
  };
  const ids = style.layers.map((l) => l.id);
  const at = (id: string) => ids.indexOf(id);
  expect(at("slmcs-line")).toBeGreaterThan(at("warning-fill"));
  expect(at("slmcs-line")).toBeGreaterThan(at("slmcs-casing"));
  expect(at("slmcs-line")).toBeLessThan(at("hypocenters"));
  expect(
    style.layers.find((l) => l.id === "slmcs-line")?.layout?.visibility ??
      "visible",
  ).toBe("visible");
  // 時刻の表を読むまで、雷と今後の雨の層は出さない
  expect(style.layers.find((l) => l.id === "nowc-4")?.layout?.visibility).toBe(
    "none",
  );
  for (const hazard of ["thunder", "rain-forecast"] as const)
    expect(
      validateStyleMin(baseStyle("https://s.example", hazard) as never).map(
        (e) => e.message,
      ),
    ).toEqual([]);
});
