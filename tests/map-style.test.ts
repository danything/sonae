import { expect, test } from "bun:test";

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

import {
  baseStyle,
  BLUE_MARBLE_TILES,
  DEPTH_COLORS,
  eewFill,
  hazardCovers,
  HAZARDS,
  hazardVisibility,
  HIDDEN_UNDER_HAZARD,
  hypocenterFeatures,
  intensityFill,
  intensityLabels,
  longPeriodLine,
  MAP_LEGEND,
  matchExpr,
  meFeatures,
  mergeShelters,
  overlayVisibility,
  PHOTO_MIN_ZOOM,
  PLATE_COLOR,
  PLATES_URL,
  readHazard,
  SHOWN_UNDER_HAZARD,
  specialWarningFilter,
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
  // ハザードマップの層と、ハザードマップを重ねている間だけ出す層のほかは、いつも出す
  const underHazard: string[] = [...SHOWN_UNDER_HAZARD];
  for (const l of style.layers)
    if (!l.id.startsWith("hazard-"))
      expect(l.layout?.visibility ?? "visible").toBe(
        underHazard.includes(l.id) ? "none" : "visible",
      );
  // 活断層図 (地形の分類で塗った全面の図) はいつもは重ねない
  expect(style.layers.map((l) => l.id)).not.toContain("faults");
  expect(
    style.layers.find((l) => l.id === "hazard-afm")?.layout?.visibility,
  ).toBe("none");
  expect(Object.keys(style.sources)).not.toContain("pale");
  expect(MAP_LEGEND.map((l) => l.label)).toContain("長周期地震動階級");
});

test("下地: 引いたときは Blue Marble、ズーム 9 から地理院の写真。境で 1 段重ねる", () => {
  const style = baseStyle() as {
    sources: Record<
      string,
      {
        tiles?: string[];
        minzoom?: number;
        maxzoom?: number;
        attribution?: string;
      }
    >;
    layers: {
      id: string;
      minzoom?: number;
      maxzoom?: number;
      paint?: Record<string, unknown>;
    }[];
  };
  const bm = style.sources["blue-marble"];
  const photo = style.sources.photo;
  expect(bm?.tiles).toEqual([BLUE_MARBLE_TILES]);
  expect(bm?.maxzoom).toBe(8);
  expect(bm?.attribution).toContain("NASA Earth Observatory");
  // 写真の 8 以下 (世界衛星モザイク) は灰色の三角が焼き込まれているので読まない
  expect(PHOTO_MIN_ZOOM).toBe(9);
  expect(photo?.minzoom).toBe(PHOTO_MIN_ZOOM);
  const ids = style.layers.map((l) => l.id);
  // Blue Marble は写真の下で、写真の出始めより 1 段先まで残す (境で白く抜けない)
  expect(ids.indexOf("blue-marble")).toBe(ids.indexOf("photo") - 1);
  const bmLayer = style.layers.find((l) => l.id === "blue-marble");
  const photoLayer = style.layers.find((l) => l.id === "photo");
  expect(photoLayer?.minzoom).toBe(PHOTO_MIN_ZOOM);
  expect(bmLayer?.maxzoom).toBeGreaterThan(PHOTO_MIN_ZOOM);
  // 写真は境から半段かけて重ねる (海の色の段差を和らげる)
  expect(photoLayer?.paint?.["raster-opacity"]).toEqual([
    "interpolate",
    ["linear"],
    ["zoom"],
    PHOTO_MIN_ZOOM,
    0,
    PHOTO_MIN_ZOOM + 0.5,
    1,
  ]);
});

test("プレート境界: 付加情報のいちばん下に細い破線で引き、震源の丸より目立たせない", async () => {
  const style = baseStyle() as {
    sources: Record<string, { data?: unknown; attribution?: string }>;
    layers: { id: string; type: string; paint?: Record<string, unknown> }[];
  };
  expect(style.sources.plates?.data).toBe(PLATES_URL);
  expect(style.sources.plates?.attribution).toContain(
    "https://opendatacommons.org/licenses/by/1-0/",
  );
  const ids = style.layers.map((l) => l.id);
  const at = ids.indexOf("plate-boundaries");
  // 写真とハザードマップのすぐ上、区域の塗りと震源より下
  expect(at).toBeGreaterThan(ids.indexOf("photo"));
  expect(at).toBeLessThan(ids.indexOf("warning-fill"));
  expect(at).toBeLessThan(ids.indexOf("hypocenters"));
  const plate = style.layers[at];
  expect(plate?.type).toBe("line");
  expect(plate?.paint?.["line-color"]).toBe(PLATE_COLOR);
  expect(plate?.paint?.["line-dasharray"]).toBeDefined();
  // 半分透かす (震源の丸は不透明度 0.8)
  const alpha = Number(/,\s*([\d.]+)\)$/.exec(PLATE_COLOR)?.[1]);
  expect(alpha).toBeLessThan(0.8);
  expect(MAP_LEGEND.map((l) => l.label)).toContain("プレート境界");
  // 配るファイルは線だけで、出典とライセンスの README が隣にある
  const fc = (await Bun.file(`static${PLATES_URL}`).json()) as {
    type: string;
    features: { geometry: { type: string } }[];
  };
  expect(fc.type).toBe("FeatureCollection");
  expect(fc.features.length).toBeGreaterThan(100);
  for (const f of fc.features)
    expect(["LineString", "MultiLineString"]).toContain(f.geometry.type);
  const readme = await Bun.file("static/plates/README.md").text();
  expect(readme).toContain("https://opendatacommons.org/licenses/by/1-0/");
  expect(readme).toContain("Contains information from PB2002");
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

test("ハザードマップ: 活断層を選べ、地理院タイルの afm をズーム 11〜16 で読む", () => {
  expect(readHazard("faults")).toBe("faults");
  const shown = hazardVisibility("faults");
  expect(Object.entries(shown).filter(([, on]) => on)).toEqual([
    ["hazard-afm", true],
  ]);
  const style = baseStyle("", "faults") as {
    sources: Record<
      string,
      { tiles?: string[]; minzoom?: number; maxzoom?: number }
    >;
  };
  const afm = style.sources["hazard-afm"];
  expect(afm?.tiles).toEqual([
    "https://cyberjapandata.gsi.go.jp/xyz/afm/{z}/{x}/{y}.png",
  ]);
  expect([afm?.minzoom, afm?.maxzoom]).toEqual([11, 16]);
  // 凡例の画像は無く、国土地理院の説明へのリンクを出す
  const faults = HAZARDS.find((h) => h.id === "faults");
  expect(faults?.legends).toEqual([]);
  expect(faults?.about?.some((p) => typeof p !== "string")).toBe(true);
  expect(faults?.credit).toBe("都市圏活断層図");
});

test("図が重ならないズーム (活断層の 11 未満) では隠さない", () => {
  expect(hazardCovers("faults", 10.9)).toBe(false);
  expect(hazardCovers("faults", 11)).toBe(true);
  expect(hazardCovers("flood", 5)).toBe(true);
  expect(hazardCovers("none", 15)).toBe(false);
  expect(overlayVisibility("faults", 5)["warning-fill"]).toBe(true);
  expect(overlayVisibility("faults", 5)["warning-special"]).toBe(false);
  expect(overlayVisibility("faults", 12)["warning-fill"]).toBe(false);
});

test("ハザードマップを重ねている間は、面で塗る色を隠し、特別警報は縁取りで残す", () => {
  const none = overlayVisibility("none");
  for (const l of HIDDEN_UNDER_HAZARD) expect(none[l]).toBe(true);
  for (const l of SHOWN_UNDER_HAZARD) expect(none[l]).toBe(false);
  for (const id of ["flood", "landslide", "tsunami", "faults"] as const) {
    const on = overlayVisibility(id);
    for (const l of HIDDEN_UNDER_HAZARD) expect(on[l]).toBe(false);
    for (const l of SHOWN_UNDER_HAZARD) expect(on[l]).toBe(true);
  }
  // 命に関わるいま出ているもの (緊急地震速報の縁取り・津波の線) は隠す層に入れない
  const hidden: string[] = [...HIDDEN_UNDER_HAZARD];
  for (const keep of ["eew-line", "tsunami", "longperiod-line"])
    expect(hidden).not.toContain(keep);
  const style = baseStyle("", "flood") as {
    layers: { id: string; layout?: { visibility?: string } }[];
  };
  const vis = (id: string) =>
    style.layers.find((l) => l.id === id)?.layout?.visibility;
  expect(vis("warning-fill")).toBe("none");
  expect(vis("warning-special")).toBe("visible");
  // 特別警報 (レベル 5) の市町村等だけを縁取る
  expect(
    specialWarningFilter(
      new Map([
        ["0110000", 5],
        ["0120000", 3],
      ]),
    ),
  ).toEqual(["in", ["get", "code"], ["literal", ["0110000"]]]);
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

test("地図の style は MapLibre の決まりに合う (式の形の誤りで地図が出なくなるのを防ぐ)", () => {
  for (const hazard of ["none", "flood", "faults"] as const) {
    const errors = validateStyleMin(
      baseStyle("https://s.example", hazard) as never,
    );
    expect(errors.map((e) => e.message)).toEqual([]);
  }
});
