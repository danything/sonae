import { expect, test } from "bun:test";

import {
  baseStyle,
  DEPTH_COLORS,
  eewFill,
  hypocenterFeatures,
  intensityFill,
  intensityLabels,
  longPeriodLine,
  MAP_LEGEND,
  matchExpr,
  tsunamiPaint,
} from "#lib/map/style.ts";
import type { Eew, Quake, Tsunami } from "#lib/model.ts";

test("色の式: コード (気象庁) と名前 (P2P) で引き、どちらも無ければ透明", () => {
  expect(matchExpr(new Map(), new Map(), "x")).toBe("x");
  expect(
    intensityFill([
      { code: "442", name: "静岡県中部", int: "6-" },
      { name: "沖縄本島地方", int: "3" },
    ]),
  ).toEqual([
    "match",
    ["get", "code"],
    "442",
    "rgb(255 40 0)",
    [
      "match",
      ["get", "name"],
      "沖縄本島地方",
      "rgb(0 65 255)",
      "rgba(0,0,0,0)",
    ],
  ]);
});

test("緊急地震速報: 取り消されたものの地域は塗らない", () => {
  const e = { warnAreas: ["上川地方北部"], cancelled: false } as Eew;
  expect(eewFill([e], "red")).toEqual([
    "match",
    ["get", "name"],
    "上川地方北部",
    "red",
    "rgba(0,0,0,0)",
  ]);
  expect(eewFill([{ ...e, cancelled: true }], "red")).toBe("rgba(0,0,0,0)");
});

test("津波: 強い区分が勝ち、大津波警報は線を太く", () => {
  const t = {
    areas: [
      { code: "210", name: "岩手県", grade: "watch", kindName: "" },
      { code: "210", name: "岩手県", grade: "major", kindName: "" },
      { code: "220", name: "宮城県", grade: "none", kindName: "" },
    ],
  } as Tsunami;
  const p = tsunamiPaint([t]);
  expect(p.color).toEqual([
    "match",
    ["get", "code"],
    "210",
    "rgb(200 0 255)",
    "rgba(0,0,0,0)",
  ]);
  expect(p.width).toEqual(["match", ["get", "code"], "210", 8, 0]);
});

test("震度のラベル: 名前しか無いものはコードを引き、大きい震度を後に描く", () => {
  const labels = intensityLabels(
    [
      { code: "442", name: "静岡県中部", int: "6-" },
      { name: "静岡県東部", int: "4" },
      { name: "どこか", int: "7" },
    ],
    { "442": [138.3, 35], "441": [138.9, 35.2] },
    new Map([["静岡県東部", "441"]]),
  );
  expect(labels.map((l) => l.int)).toEqual(["4", "6-"]);
});

test("層はいつも全部出す。淡色地図の下地は無い", () => {
  const style = baseStyle() as {
    sources: Record<string, unknown>;
    layers: { id: string; layout?: { visibility?: string } }[];
  };
  for (const l of style.layers) expect(l.layout?.visibility).toBeUndefined();
  expect(style.layers.map((l) => l.id)).toContain("faults");
  expect(Object.keys(style.sources)).not.toContain("pale");
  expect(MAP_LEGEND.map((l) => l.label)).toContain("長周期地震動階級");
});

test("震源: 深さで色、新しいものほど上に描く", () => {
  const q = (id: string, depthKm?: number) =>
    ({ id, hypocenter: { name: "", lat: 35, lon: 135, depthKm } }) as Quake;
  const f = hypocenterFeatures([q("a", 10), q("b"), q("c", 400)]);
  expect(f.features.map((x) => x.properties.depth)).toEqual([10, -1, 400]);
  expect(f.features.map((x) => x.properties.order)).toEqual([50, 49, 48]);
  expect(DEPTH_COLORS.at(-1)?.upto).toBe(Infinity);
});

test("長周期地震動の枠: 階級 1 以上の地域だけを、階級の色で囲む", () => {
  expect(
    longPeriodLine([
      { code: "220", name: "宮城県北部", lg: "3" },
      { code: "200", name: "青森県津軽北部", lg: "1" },
      { code: "300", name: "どこか", lg: "0" },
    ]),
  ).toEqual([
    "match",
    ["get", "code"],
    "220",
    "rgb(255 40 0)",
    "200",
    "rgb(250 245 0)",
    "rgba(0,0,0,0)",
  ]);
  expect(longPeriodLine([])).toBe("rgba(0,0,0,0)");
});
