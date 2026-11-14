/**
 * 地図の下地と、重ねる層 (docs/map.md)。MapLibre の style と、データから色の式を組む関数。
 * DOM にも MapLibre にも触らない (試験できるように)。
 */

import {
  INTENSITY_COLORS,
  LG_COLORS,
  TSUNAMI_COLORS,
  WARNING_COLORS,
} from "#lib/format.ts";
import type {
  AreaIntensity,
  AreaLongPeriod,
  Eew,
  ForeignQuake,
  ObservedIntensity,
  Quake,
  Tsunami,
  Volcano,
  WarningLevel,
} from "#lib/model.ts";
import { intensityRank, TSUNAMI_ORDER, volcanoTop } from "#lib/model.ts";

const GSI = "https://cyberjapandata.gsi.go.jp/xyz";
const TILES = "https://maps.gsi.go.jp/development/ichiran.html";

/**
 * 写真の出典。地理院タイルの一覧の「写真」の備考のとおり、ズームの段ごとに元の衛星画像の出典も出す
 * (2〜8 は世界衛星モザイク、9〜13 は全国ランドサットモザイク、14〜18 はシームレス空中写真)
 */
export const PHOTO_ATTRIBUTION = [
  `<a href="${TILES}" target="_blank" rel="noopener">国土地理院</a> (シームレス空中写真)`,
  "Landsat8画像 (GSI, TSIC, GEO Grid/AIST)・Landsat8画像 (courtesy of the U.S. Geological Survey)・海底地形 (GEBCO)",
  "世界衛星モザイク画像: NASA LP DAAC, USGS/EROS Center",
  "GRUS画像 (© Axelspace)",
].join(" | ");

export const JMA_GIS_ATTRIBUTION =
  '<a href="https://www.data.jma.go.jp/developer/gis.html" target="_blank" rel="noopener">気象庁 予報区等 GIS データ</a> を加工';

/**
 * 地図の見方 (「出典と注意」の窓に出す)。層はいつも全部出していて、オン・オフは無い (docs/map.md)。
 * 色の意味は地図の上には書かないので、ここに言葉で書く
 */
export const MAP_LEGEND: { label: string; note: string }[] = [
  {
    label: "各地の震度",
    note: "地図に出している地震 (選んだ地震か、いちばん新しい地震) の、地域ごとの震度の色と数字",
  },
  {
    label: "震源",
    note: "新しい 50 件の丸。色は深さ (30 km まで赤・100 km まで黄・300 km まで緑・それより深いと青)、大きさは M。地図に出している地震は ×",
  },
  {
    label: "長周期地震動階級",
    note: "地図に出している地震で、階級 1 以上を観測した地域を太い枠で囲みます。枠の色は階級 4 紫・3 赤・2 橙・1 黄",
  },
  {
    label: "津波の警報・注意報",
    note: "津波予報区の海岸の線を区分の色で引きます。大津波警報は線が太くなります",
  },
  {
    label: "緊急地震速報",
    note: "出ている間の震央の × と、警報の出た地域 (赤く塗って縁取ります)",
  },
  {
    label: "気象警報・注意報",
    note: "市町村等を段の色で塗ります。特別警報 黒・危険警報 紫・警報 赤・注意報 黄 (気象庁の配色)",
  },
  {
    label: "海外の地震",
    note: "新しい 50 件。白い縁の丸 (色と大きさは震源と同じ)",
  },
  {
    label: "火山",
    note: "噴火警戒レベル 2 以上の火山と、選んだ情報の火山の三角。中の数字はレベル",
  },
  {
    label: "活断層",
    note: "都市圏活断層図。大きく寄せたとき (ズーム 11 以上) だけ出ます",
  },
];

const TRANSPARENT = "rgba(0,0,0,0)";

type Expr = unknown[];

/**
 * 地域の鍵 (気象庁の XML はコード、P2P は名前) から色を引く式。どちらも無ければ透明。
 * `match` は組を 1 つ以上要るので、空なら既定の値だけを返す
 */
export function matchExpr<T extends string | number>(
  byCode: Map<string, T>,
  byName: Map<string, T>,
  fallback: T | Expr,
): T | Expr {
  const make = (key: string, m: Map<string, T>, rest: T | Expr): T | Expr =>
    m.size === 0 ? rest : ["match", ["get", key], ...[...m].flat(), rest];
  return make("code", byCode, make("name", byName, fallback));
}

/** 震度の色で地域を塗る式 */
export function intensityFill(areas: AreaIntensity[]): string | Expr {
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const a of areas) {
    const color = INTENSITY_COLORS[a.int]?.bg;
    if (!color) continue;
    if (a.code) byCode.set(a.code, color);
    else byName.set(a.name, color);
  }
  return matchExpr(byCode, byName, TRANSPARENT);
}

/** 長周期地震動階級 1 以上の地域の枠の色の式 (階級 0 と取消は透明) */
export function longPeriodLine(areas: AreaLongPeriod[]): string | Expr {
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const a of areas) {
    const color = LG_COLORS[a.lg]?.bg;
    if (!color) continue;
    if (a.code) byCode.set(a.code, color);
    else byName.set(a.name, color);
  }
  return matchExpr(byCode, byName, TRANSPARENT);
}

/** 市町村等を、いま出ている気象警報・注意報のいちばん高い段の色で塗る式 */
export function warningFill(levels: Map<string, WarningLevel>): string | Expr {
  const byCode = new Map<string, string>();
  for (const [code, level] of levels) {
    const color = level > 0 ? WARNING_COLORS[level]?.bg : undefined;
    if (color) byCode.set(code, color);
  }
  return matchExpr(byCode, new Map(), TRANSPARENT);
}

/** 緊急地震速報の警報の地域 (名前) を塗る式 */
export function eewFill(eews: Eew[], color: string): string | Expr {
  const names = new Map<string, string>();
  for (const e of eews) {
    if (e.cancelled) continue;
    for (const n of e.warnAreas) names.set(n, color);
  }
  return matchExpr(new Map(), names, TRANSPARENT);
}

/** 津波予報区の線の色と太さ (大津波警報は太さを 2 倍。気象庁の配色の指針) */
export function tsunamiPaint(tsunamis: Tsunami[]): {
  color: string | Expr;
  width: number | Expr;
} {
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();
  const widthCode = new Map<string, number>();
  const widthName = new Map<string, number>();
  // 強いほうを後に入れて勝たせる
  const areas = tsunamis
    .flatMap((t) => t.areas)
    .filter((a) => a.grade !== "none")
    .sort(
      (a, b) => TSUNAMI_ORDER.indexOf(b.grade) - TSUNAMI_ORDER.indexOf(a.grade),
    );
  for (const a of areas) {
    const color = TSUNAMI_COLORS[a.grade]?.bg ?? TRANSPARENT;
    const width = a.grade === "major" ? 8 : a.grade === "forecast" ? 2 : 4;
    (a.code ? byCode : byName).set(a.code ?? a.name, color);
    (a.code ? widthCode : widthName).set(a.code ?? a.name, width);
  }
  return {
    color: matchExpr(byCode, byName, TRANSPARENT),
    width: matchExpr(widthCode, widthName, 0),
  };
}

/**
 * 震源の点の色 (深さ)。境は 30・100・300 km。深さの分からないものは灰色。
 * 震度の色 (気象庁の配色の指針) と取り違えないよう、震度のラベルとは別の形 (丸) で描く
 */
export const DEPTH_COLORS = [
  { upto: 30, color: "#ff3b30", label: "30 km まで" },
  { upto: 100, color: "#ffcc00", label: "100 km まで" },
  { upto: 300, color: "#34c759", label: "300 km まで" },
  { upto: Infinity, color: "#2f80ff", label: "それより深い" },
] as const;

/** 深さ (km、無ければ -1) から色を引く MapLibre の式 */
export function depthColorExpr(): Expr {
  return [
    "case",
    ["<", ["get", "depth"], 0],
    "#9aa0a6",
    [
      "step",
      ["get", "depth"],
      DEPTH_COLORS[0].color,
      DEPTH_COLORS[0].upto + 0.5,
      DEPTH_COLORS[1].color,
      DEPTH_COLORS[1].upto + 0.5,
      DEPTH_COLORS[2].color,
      DEPTH_COLORS[2].upto + 0.5,
      DEPTH_COLORS[3].color,
    ],
  ];
}

/**
 * 震源の点 (新しい順に最大 n 件)。色は深さ、大きさは M。新しいものほど上に描く (`order`)
 */
export function hypocenterFeatures(quakes: Quake[], n = 50) {
  return {
    type: "FeatureCollection" as const,
    features: quakes
      .filter(
        (q) =>
          q.hypocenter?.lat !== undefined &&
          q.hypocenter.lon !== undefined &&
          !q.cancelled,
      )
      .slice(0, n)
      .map((q, i) => ({
        type: "Feature" as const,
        properties: {
          id: q.id,
          m: typeof q.magnitude === "number" ? q.magnitude : 3,
          depth: q.hypocenter?.depthKm ?? -1,
          order: n - i,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [q.hypocenter?.lon ?? 0, q.hypocenter?.lat ?? 0],
        },
      })),
  };
}

/** 地域ごとの震度のラベルを置く (大きいほうから。重なるときに大きい震度が上に来るよう、描く順は小さいほうから) */
export function intensityLabels(
  areas: AreaIntensity[],
  points: Record<string, [number, number]>,
  byName: Map<string, string>,
): { int: ObservedIntensity; at: [number, number]; name: string }[] {
  return areas
    .flatMap((a) => {
      const code = a.code ?? byName.get(a.name);
      const at = code ? points[code] : undefined;
      return at ? [{ int: a.int, at, name: a.name }] : [];
    })
    .sort((a, b) => intensityRank(a.int) - intensityRank(b.int));
}

/** 海外の地震の点の出典 (機関を足したらここにも足す) */
export const FOREIGN_ATTRIBUTION =
  '海外の地震: <a href="https://earthquake.usgs.gov/" target="_blank" rel="noopener">Credit: U.S. Geological Survey</a> | <a href="https://www.seismicportal.eu" target="_blank" rel="noopener">Credit: EMSC-CSEM SeismicPortal</a> (CC BY 4.0) | <a href="https://www.geonet.org.nz/" target="_blank" rel="noopener">GeoNet</a> (CC BY 3.0 NZ) | <a href="https://www.cwa.gov.tw/" target="_blank" rel="noopener">中央氣象署</a>';

/** 海外の地震の点 (新しい順に最大 n 件)。色は深さ、大きさは M */
export function foreignFeatures(quakes: ForeignQuake[], n = 50) {
  return {
    type: "FeatureCollection" as const,
    features: quakes.slice(0, n).map((q, i) => ({
      type: "Feature" as const,
      properties: {
        id: q.id,
        m: q.magnitude ?? 4.5,
        depth: q.depthKm ?? -1,
        order: n - i,
      },
      geometry: { type: "Point" as const, coordinates: [q.lon, q.lat] },
    })),
  };
}

/** 地図に置く火山の印 1 つ */
export interface VolcanoMark {
  code: string;
  name: string;
  at: [number, number];
  /** 警戒の段 (1〜5)。分からなければ無し */
  level?: number;
  kind: string;
  /** 選んだ情報の火山 */
  selected: boolean;
}

/**
 * 火山の印。いまの噴火警報・予報 (`latestPerVolcano`) で段が 2 以上の火山と、選んだ報の火山。
 * 位置は電文の位置、無ければ活火山の一覧 (`volcano-points.json`) から引く。段の低いほうから並べる (高い段が上に描かれる)
 */
export function volcanoMarks(
  levels: Volcano[],
  selected: Volcano | null | undefined,
  points: Record<string, [number, number, string?]>,
): VolcanoMark[] {
  const out = new Map<string, VolcanoMark>();
  const put = (v: Volcano, isSelected: boolean) => {
    for (const a of v.volcanoes) {
      const p = points[a.code];
      const at: [number, number] | undefined =
        a.lat !== undefined && a.lon !== undefined
          ? [a.lon, a.lat]
          : p
            ? [p[0], p[1]]
            : undefined;
      if (!at) continue;
      const prev = out.get(a.code);
      out.set(a.code, {
        code: a.code,
        name: a.name,
        at,
        // 噴火速報には段が無いので、いまの段を残す
        level: a.level ?? prev?.level,
        kind: a.kind,
        selected: isSelected || prev?.selected === true,
      });
    }
  };
  for (const v of levels) if (volcanoTop(v) >= 2) put(v, false);
  if (selected && !selected.cancelled) put(selected, true);
  return [...out.values()].sort(
    (a, b) =>
      Number(a.selected) - Number(b.selected) ||
      (a.level ?? 0) - (b.level ?? 0),
  );
}

/** 下地と、データの無い層。データ (色の式・点) は地図を作ったあとで差し込む */
export function baseStyle(): Record<string, unknown> {
  return {
    version: 8,
    sources: {
      photo: {
        type: "raster",
        tiles: [`${GSI}/seamlessphoto/{z}/{x}/{y}.jpg`],
        tileSize: 256,
        minzoom: 2,
        maxzoom: 18,
        attribution: PHOTO_ATTRIBUTION,
      },
      faults: {
        type: "raster",
        tiles: [`${GSI}/afm/{z}/{x}/{y}.png`],
        tileSize: 256,
        minzoom: 11,
        maxzoom: 16,
        attribution: `<a href="${TILES}#afm" target="_blank" rel="noopener">国土地理院 (都市圏活断層図)</a>`,
      },
      "quake-areas": {
        type: "geojson",
        data: "/areas/quake-areas.geojson",
        attribution: JMA_GIS_ATTRIBUTION,
      },
      "tsunami-areas": {
        type: "geojson",
        data: "/areas/tsunami-areas.geojson",
      },
      "warning-areas": {
        type: "geojson",
        data: "/areas/warning-areas.geojson",
      },
      foreign: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: FOREIGN_ATTRIBUTION,
      },
      hypocenters: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
    },
    layers: [
      {
        id: "photo",
        type: "raster",
        source: "photo",
        // ズーム 8 までの世界衛星モザイクは、海に撮った時期の違う画像の継ぎ目 (暗い筋と四角) が目立つ。
        // 暗い所を少し持ち上げ、明暗の差と色を抑えて目立たなくする。陸の写真が細かくなる 10 からは元のまま
        paint: {
          "raster-brightness-min": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            0.05,
            10,
            0,
          ],
          "raster-contrast": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            -0.15,
            10,
            0,
          ],
          "raster-saturation": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            -0.1,
            10,
            0,
          ],
        },
      },
      // 活断層はいつも重ねる。タイルはズーム 11 からしか無いので、引いているときは読みに行かない
      {
        id: "faults",
        type: "raster",
        source: "faults",
        paint: { "raster-opacity": 0.9 },
      },
      // 気象警報・注意報は震度の下に塗る (地震のときは震度を見せる)
      {
        id: "warning-fill",
        type: "fill",
        source: "warning-areas",
        paint: { "fill-color": TRANSPARENT, "fill-opacity": 0.6 },
      },
      {
        id: "quake-fill",
        type: "fill",
        source: "quake-areas",
        paint: { "fill-color": TRANSPARENT, "fill-opacity": 0.75 },
      },
      {
        id: "eew-fill",
        type: "fill",
        source: "quake-areas",
        paint: { "fill-color": TRANSPARENT, "fill-opacity": 0.35 },
      },
      {
        id: "eew-line",
        type: "line",
        source: "quake-areas",
        paint: { "line-color": TRANSPARENT, "line-width": 2.5 },
      },
      {
        id: "quake-line",
        type: "line",
        source: "quake-areas",
        paint: { "line-color": "rgba(255,255,255,0.45)", "line-width": 0.6 },
      },
      {
        id: "longperiod-line",
        type: "line",
        source: "quake-areas",
        layout: { "line-join": "round" },
        paint: { "line-color": TRANSPARENT, "line-width": 3 },
      },
      {
        id: "tsunami",
        type: "line",
        source: "tsunami-areas",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": TRANSPARENT, "line-width": 0 },
      },
      {
        id: "hypocenters",
        type: "circle",
        source: "hypocenters",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "m"],
            1,
            3,
            5,
            7,
            8,
            16,
          ],
          "circle-color": depthColorExpr(),
          "circle-opacity": 0.8,
          "circle-stroke-color": "rgba(0,0,0,0.6)",
          "circle-stroke-width": 1,
        },
        layout: { "circle-sort-key": ["get", "order"] },
      },
      {
        id: "foreign",
        type: "circle",
        source: "foreign",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "m"],
            4,
            5,
            6,
            9,
            9,
            18,
          ],
          "circle-color": depthColorExpr(),
          "circle-opacity": 0.55,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1.5,
        },
        layout: { "circle-sort-key": ["get", "order"] },
      },
    ],
  };
}

/** 日本の全体が入る範囲 (南西・北東) */
export const JAPAN_BOUNDS: [[number, number], [number, number]] = [
  [122, 24],
  [149, 46],
];
