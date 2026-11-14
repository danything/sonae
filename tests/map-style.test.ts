import { expect, test } from "bun:test";

import {
  baseStyle,
  DEPTH_COLORS,
  eewFill,
  hazardVisibility,
  hypocenterFeatures,
  intensityFill,
  intensityLabels,
  longPeriodLine,
  MAP_LEGEND,
  matchExpr,
  meFeatures,
  mergeShelters,
  readHazard,
  tilesIn,
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
  for (const l of style.layers)
    if (!l.id.startsWith("hazard-"))
      expect(l.layout?.visibility).toBeUndefined();
  expect(style.layers.map((l) => l.id)).toContain("faults");
  expect(Object.keys(style.sources)).not.toContain("pale");
  expect(MAP_LEGEND.map((l) => l.label)).toContain("長周期地震動階級");
});

test("ハザードマップ: 選んだものだけ出す。既定と知らない値はなし", () => {
  expect(readHazard(null)).toBe("none");
  expect(readHazard("nope")).toBe("none");
  expect(readHazard("landslide")).toBe("landslide");
  const shown = hazardVisibility("landslide");
  expect(Object.entries(shown).filter(([, on]) => on).length).toBe(3);
  expect(Object.values(hazardVisibility("none")).some(Boolean)).toBe(false);
  const style = baseStyle("https://s.example", "flood") as {
    sprite: string;
    glyphs?: string;
    layers: { id: string; layout?: { visibility?: string } }[];
  };
  const flood = style.layers.find(
    (l) => l.id === "hazard-01_flood_l2_shinsuishin_data",
  );
  expect(flood?.layout?.visibility).toBe("visible");
  // 字体は外から読まない。記号は自分で配る
  expect(style.glyphs).toBeUndefined();
  expect(style.sprite).toBe("https://s.example/map/gsi/sprite/std");
});

test("避難場所: 見ている範囲のズーム 10 のタイル。多すぎたら読まない", () => {
  // 東京駅のまわり (ズーム 10 で 909/403)
  expect(tilesIn([139.75, 35.67, 139.78, 35.69], 10)).toEqual([[909, 403]]);
  expect(tilesIn([130, 30, 140, 40], 10)).toEqual([]);
});

test("避難場所: 災害ごとの層と指定避難所を、同じ施設 1 つにまとめる", () => {
  const f = (name: string, props: Record<string, unknown> = {}) => ({
    geometry: { coordinates: [139.7, 35.6] },
    properties: { name, address: "東京都", ...props },
  });
  const merged = mergeShelters([
    { layer: "skhb01", features: [f("A小", { disaster1: 1, disaster4: 1 })] },
    { layer: "skhb04", features: [f("A小", { disaster1: 1, disaster4: 1 })] },
    { layer: "sih", features: [f("A小"), f("B中")] },
  ]);
  expect(merged.map((m) => m.properties)).toEqual([
    { name: "A小", address: "東京都", disasters: [1, 4], shelter: true },
    { name: "B中", address: "東京都", disasters: [], shelter: true },
  ]);
});

test("現在地: 点と、誤差の半径 (メートル) の円", () => {
  const f = meFeatures(139.767, 35.681, 500);
  const [circle, dot] = f.features;
  expect(dot?.geometry.coordinates).toEqual([139.767, 35.681]);
  if (circle?.geometry.type !== "Polygon") throw new Error("円が無い");
  const ring = (circle.geometry.coordinates as [number, number][][])[0]!;
  expect(ring[0]).toEqual(ring.at(-1)!);
  // 北の点は緯度で約 500 m (1 度は約 111 km)
  const north = ring[0]!;
  expect((north[1] - 35.681) * 111_195).toBeCloseTo(500, -1);
  expect(north[0]).toBeCloseTo(139.767, 6);
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
