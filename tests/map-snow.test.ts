import { expect, test } from "bun:test";

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

import {
  readSnowHours,
  SNOW_FALL_HOURS,
  SNOW_KINDS,
  SNOW_TIMES_URL,
  snowFallKind,
  snowFrames,
  snowOf,
  snowStale,
  snowTiles,
} from "#lib/map/snow.ts";
import {
  baseStyle,
  COLOR_DEPTHS,
  depthApplies,
  overlayVisibility,
  readColorDepth,
  readHazard,
  snowShown,
  snowVisibility,
} from "#lib/map/style.ts";
import { CREDITS, creditText } from "#lib/notice.ts";

const ELEMENTS = ["snowd", "snowf01h", "snowf03h", "snowf12h", "snowf24h"];

// snow/targetTimes.json の形 (2026-11-28 に取ったものを縮めた。新しい順。予測は最新の解析から 1〜6 時間先)
const TIMES = [
  {
    basetime: "20261128070000",
    validtime: "20261128090000",
    elements: ELEMENTS,
  },
  {
    basetime: "20261128070000",
    validtime: "20261128080000",
    elements: ELEMENTS,
  },
  {
    basetime: "20261128070000",
    validtime: "20261128070000",
    elements: ELEMENTS,
  },
  {
    basetime: "20261128060000",
    validtime: "20261128060000",
    elements: ELEMENTS,
  },
  // 1 つ前の解析からの予測 (最新の解析の並びには入れない)
  {
    basetime: "20261128060000",
    validtime: "20261128100000",
    elements: ELEMENTS,
  },
];

test("今後の雪: いちばん新しい解析を 0 枚目に、同じ解析からの予測を先の時刻の順に並べる", () => {
  const frames = snowFrames(TIMES, "snowd");
  expect(frames.map((f) => [f.validtime, f.forecast])).toEqual([
    ["20261128070000", false],
    ["20261128080000", true],
    ["20261128090000", true],
  ]);
  expect(frames.every((f) => f.basetime === "20261128070000")).toBe(true);
  expect(snowTiles(frames[1]!, "snowf12h")).toBe(
    "/relay/jmatile/snow/20261128070000/none/20261128080000/surf/snowf12h/{z}/{x}/{y}.png",
  );
  expect(SNOW_TIMES_URL).toBe("/relay/jmatile/snow/targetTimes.json");
});

test("今後の雪: 冬でない間 (表が空・要素が無い) は並びが空", () => {
  expect(snowFrames([], "snowd")).toEqual([]);
  expect(snowFrames(null, "snowd")).toEqual([]);
  expect(
    snowFrames(
      [
        {
          basetime: "20260701000000",
          validtime: "20260701000000",
          elements: [],
        },
      ],
      "snowd",
    ),
  ).toEqual([]);
});

test("今後の雪: 解析から 150 分より経ったら古い", () => {
  const f = {
    basetime: "20261128070000",
    validtime: "20261128070000",
    member: "none",
  };
  const at = Date.parse("2026-11-28T07:00:00Z");
  expect(snowStale(f, at + 150 * 60_000)).toBe(false);
  expect(snowStale(f, at + 151 * 60_000)).toBe(true);
});

test("今後の雪: 凡例はタイルのパレットの色と、気象庁の凡例の区切り", () => {
  expect(snowOf("snow-depth")?.element).toBe("snowd");
  expect(snowOf("snow-fall")?.element).toBe("snowf12h");
  expect(snowOf("snow-depth")?.legend.map((l) => l.label)).toEqual([
    "200 以上",
    "150〜200",
    "100〜150",
    "50〜100",
    "20〜50",
    "5〜20",
    "5 未満",
  ]);
  expect(snowOf("snow-fall")?.legend.at(-1)).toEqual({
    color: "rgb(242 242 255)",
    label: "7 未満",
  });
});

test("重ねる図: 今後の雪は 1 つだけ選ぶ層。地震を選んでいる間は隠し、選んでいる間は警報・注意報の塗りを隠す", () => {
  for (const k of SNOW_KINDS) expect(readHazard(k.id)).toBe(k.id);
  expect(snowShown("snow-depth", false)).toBe(true);
  expect(snowShown("snow-depth", true)).toBe(false);
  expect(snowShown("rain", false)).toBe(false);
  expect(Object.values(snowVisibility("snow-fall", false, true))).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(
    Object.values(snowVisibility("snow-fall", false, false)).some(Boolean),
  ).toBe(false);
  expect(
    Object.values(snowVisibility("snow-fall", true, true)).some(Boolean),
  ).toBe(false);
  expect(overlayVisibility("snow-depth")["warning-fill"]).toBe(false);
  expect(overlayVisibility("snow-depth")["warning-special"]).toBe(true);
});

test("地図の style: 今後の雪の層は、時刻の表を読むまで出さず、style として正しい", () => {
  const style = baseStyle("https://s.example", "snow-depth") as {
    layers: { id: string; layout?: { visibility?: string } }[];
  };
  expect(style.layers.find((l) => l.id === "snow-4")?.layout?.visibility).toBe(
    "none",
  );
  expect(
    validateStyleMin(style as never).map((e: { message: string }) => e.message),
  ).toEqual([]);
});

test("出典と注意: 今後の雪の出典と、加工して作成したこと", () => {
  const c = CREDITS.find((x) => x.label === "今後の雪");
  expect(c).toBeDefined();
  const text = creditText(c!);
  expect(text).toContain(
    "出典：気象庁ホームページ（https://www.jma.go.jp/bosai/snow/）",
  );
  expect(text).toContain("気象庁「今後の雪（降雪短時間予報）」を加工して作成");
});

test("今後の雪: 降雪量は 3・6・12・24・48・72 時間から選び、要素と凡例が替わる (既定は 12 時間)", () => {
  expect(SNOW_FALL_HOURS).toEqual([3, 6, 12, 24, 48, 72]);
  expect(snowOf("snow-fall", 3)?.element).toBe("snowf03h");
  expect(snowOf("snow-fall", 72)?.element).toBe("snowf72h");
  expect(snowOf("snow-fall", 24)?.pill).toBe("今後の雪: 降雪量 (24 時間)");
  // 区切りは気象庁の凡例 (legend_normal_snowf24h.svg) のまま。8 色
  expect(snowOf("snow-fall", 24)?.legend.map((l) => l.label)).toEqual([
    "70 以上",
    "60〜70",
    "50〜60",
    "40〜50",
    "30〜40",
    "20〜30",
    "10〜20",
    "10 未満",
  ]);
  for (const h of SNOW_FALL_HOURS)
    expect(snowFallKind(h).legend).toHaveLength(8);
  // 積雪の深さは時間で替わらない
  expect(snowOf("snow-depth", 3)?.element).toBe("snowd");
  expect(readSnowHours("6")).toBe(6);
  expect(readSnowHours("5")).toBe(12);
  expect(readSnowHours(null)).toBe(12);
});

test("色の濃さ: 気象庁の画面と同じ 3 つ (薄い 0.5・ふつう 0.75・濃い 1) を、気象庁の格子の図にだけ選べる", () => {
  expect(COLOR_DEPTHS.map((d) => [d.label, d.opacity])).toEqual([
    ["薄い", 0.5],
    ["ふつう", 0.75],
    ["濃い", 1],
  ]);
  expect(readColorDepth("deep")).toBe("deep");
  expect(readColorDepth("x")).toBe("normal");
  for (const id of [
    "rain",
    "rain-loop",
    "rain-forecast",
    "thunder",
    "risk-land",
    "snow-fall",
  ] as const)
    expect(depthApplies(id)).toBe(true);
  for (const id of ["none", "risk-flood", "flood", "quake-prob"] as const)
    expect(depthApplies(id)).toBe(false);
  // 地図を作るときの不透明度も色の濃さから
  const style = baseStyle("", "snow-depth", null, null, "thin") as {
    layers: { id: string; paint?: Record<string, unknown> }[];
  };
  for (const id of ["rain-4", "risk-4", "nowc-4", "rasrf-4", "snow-4"])
    expect(
      style.layers.find((l) => l.id === id)?.paint?.["raster-opacity"],
    ).toBe(0.5);
});
