/**
 * 台風の進路の予報を地図に描く (docs/map.md の「台風」)。中身は気象庁の台風解析・予報情報 (VPTW60〜65) の値のまま
 * (予報円の中心と半径・暴風警戒域の半径・実況の暴風域と強風域)。色と線は気象庁の台風の図の決まりに合わせる。
 *
 * - 予報円: 白の破線の円 (中心が 70% の確率で入る範囲)
 * - 予報円の中心を結ぶ線: 白の細い破線
 * - 暴風警戒域: 予報円の外側を囲む赤の実線 (実況の暴風域と、各予報の暴風警戒域の円をまとめた外周)
 * - 暴風域: 赤の太い実線の円 (実況)。強風域: 黄の実線の円 (実況)
 *
 * 円は電文の半径を中心から測って描くだけで、半径や中心を補ったり、予報の時刻の間を足したりはしない。
 * 暴風警戒域の外周は、気象庁の図と同じく、隣り合う円を接線でつないだ形 (凸包) を重ねた外周にする
 */

import type {
  CircleAxis,
  TyphoonForecast,
  TyphoonNow,
  WeatherInfo,
} from "#lib/model.ts";

/** 気象庁の台風の図の色。赤は配色の指針の赤 (255,40,0)、黄は強風域の黄 */
export const TYPHOON_RED = "#ff2800";
export const TYPHOON_YELLOW = "#ffe600";

/**
 * 地図に描く台風 (台風ごとにいちばん新しい報)。取消・訓練・試験・消滅の報と、新しい報が 12 時間より来ていない台風は
 * 描かない (古い予報をいまの予報と取り違えないため。台風解析・予報情報は 3〜6 時間ごとに出る)
 */
export const TYPHOON_STALE_MS = 12 * 3600_000;
export function typhoonsOnMap(
  infos: WeatherInfo[],
  now: number,
): WeatherInfo[] {
  const latest = new Map<string, WeatherInfo>();
  for (const w of infos) {
    if (w.kind !== "typhoon" || w.status !== "normal") continue;
    const prev = latest.get(w.series);
    if (!prev || Date.parse(w.reportedAt) > Date.parse(prev.reportedAt))
      latest.set(w.series, w);
  }
  return [...latest.values()].filter(
    (w) =>
      !w.cancelled &&
      w.typhoon !== undefined &&
      !/消滅/.test(w.typhoon.remark ?? "") &&
      now - Date.parse(w.reportedAt) <= TYPHOON_STALE_MS,
  );
}

const EARTH_KM = 6371.0088;
const RAD = Math.PI / 180;
/** 8 方位 (電文の「北東」など) の方位角 (度) */
const BEARING: Record<string, number> = {
  北: 0,
  北東: 45,
  東: 90,
  南東: 135,
  南: 180,
  南西: 225,
  西: 270,
  北西: 315,
};

/** 中心から方位と距離だけ進んだ所 (球面) */
function destination(
  lat: number,
  lon: number,
  bearing: number,
  km: number,
): [number, number] {
  const d = km / EARTH_KM;
  const t = bearing * RAD;
  const p1 = lat * RAD;
  const l1 = lon * RAD;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(t) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return [l2 / RAD, p2 / RAD];
}

/**
 * 円の中心と半径。全域で同じ半径なら中心のまま。「北東 200 km・南西 130 km」のように向かい合う 2 つの方向で
 * 違うときは、気象庁の図と同じく、その 2 つを直径の両端にした円 (中心を広いほうへずらす) にする。
 * それ以外の並び (方向が向かい合わない・3 つ以上) は、いちばん大きい半径で中心から描く (狭く描かない)
 */
export function circleOf(
  c: { lat: number; lon: number },
  axes: CircleAxis[],
): { lat: number; lon: number; km: number } {
  const [a, b] = axes;
  if (axes.length === 2 && a?.direction && b?.direction) {
    const ta = BEARING[a.direction];
    const tb = BEARING[b.direction];
    if (ta !== undefined && tb !== undefined && Math.abs(ta - tb) === 180) {
      const [lon, lat] = destination(c.lat, c.lon, ta, (a.km - b.km) / 2);
      return { lat, lon, km: (a.km + b.km) / 2 };
    }
  }
  return { lat: c.lat, lon: c.lon, km: Math.max(...axes.map((x) => x.km)) };
}

const STEPS = 96;
/** 円の周の点 (閉じた輪。経度は中心のそばに寄せる) */
function ring(c: { lat: number; lon: number; km: number }): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= STEPS; i++)
    pts.push(destination(c.lat, c.lon, (360 * i) / STEPS, c.km));
  return pts;
}

// ---- 暴風警戒域の外周 ----
// 平面 (Web メルカトル。地図と同じ) に移して、隣り合う円の凸包を作り、どの凸包の中にも入らない辺の部分だけを残す

type P = [number, number];
const toPlane = ([lon, lat]: P): P => [
  lon,
  Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / RAD,
];
const fromPlane = ([x, y]: P): P => [
  x,
  (2 * Math.atan(Math.exp(y * RAD)) - Math.PI / 2) / RAD,
];
const cross = (o: P, a: P, b: P) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** 凸包 (反時計回り。Andrew の方法) */
function hull(points: P[]): P[] {
  const ps = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (ps.length < 3) return ps;
  const lower: P[] = [];
  for (const p of ps) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2] as P, lower[lower.length - 1] as P, p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: P[] = [];
  for (const p of ps.reverse()) {
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2] as P, upper[upper.length - 1] as P, p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 点が凸包 (反時計回り) の内側にあるか。辺の上と、辺から eps より近い所は内側に数えない */
function inside(poly: P[], p: P, eps: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as P;
    const b = poly[(i + 1) % poly.length] as P;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    if (cross(a, b, p) / len <= eps) return false;
  }
  return true;
}

/**
 * 円 (周の点) の並びを、隣どうしの凸包でつないだ形の外周の線。返すのは経度・緯度の線の並び
 * (MultiLineString の座標)。円が 1 つならその円の周
 */
export function envelope(rings: P[][]): P[][] {
  const planes = rings.map((r) => r.map(toPlane));
  const first = planes[0];
  if (!first) return [];
  const pieces =
    planes.length === 1
      ? [hull(first)]
      : planes.slice(1).map((r, i) => hull([...(planes[i] ?? []), ...r]));
  const xs = pieces.flat().map((p) => p[0]);
  const ys = pieces.flat().map((p) => p[1]);
  const size = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
  const step = size / 600;
  const eps = size * 1e-6;
  const lines: P[][] = [];
  pieces.forEach((poly, k) => {
    const others = pieces.filter((_, j) => j !== k);
    let cur: P[] = [];
    const flush = () => {
      if (cur.length >= 2) lines.push(cur.map(fromPlane));
      cur = [];
    };
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as P;
      const b = poly[(i + 1) % poly.length] as P;
      const n = Math.max(
        1,
        Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step),
      );
      for (let s = 0; s < n; s++) {
        const p: P = [
          a[0] + ((b[0] - a[0]) * s) / n,
          a[1] + ((b[1] - a[1]) * s) / n,
        ];
        const q: P = [
          a[0] + ((b[0] - a[0]) * (s + 1)) / n,
          a[1] + ((b[1] - a[1]) * (s + 1)) / n,
        ];
        const mid: P = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (others.some((o) => inside(o, mid, eps))) {
          flush();
          continue;
        }
        if (cur.length === 0) cur.push(p);
        cur.push(q);
      }
    }
    flush();
  });
  return lines;
}

// ---- 地図の GeoJSON ----

export type TyphoonLineKind =
  "gale" | "storm" | "forecast" | "track" | "warning";

interface Feature {
  type: "Feature";
  geometry:
    | { type: "LineString"; coordinates: P[] }
    | { type: "MultiLineString"; coordinates: P[][] }
    | { type: "Point"; coordinates: P };
  properties: Record<string, string | number | boolean>;
}

/** 押した点の中身を引くための印 (点の properties) */
export interface TyphoonPoint {
  /** 報の id (WeatherInfo の id) */
  id: string;
  /** -1 は実況の中心、0 から先は予報の並びの番号 */
  index: number;
}

/**
 * 地図に描く線 (`typhoon` の source) と点 (`typhoon-points` の source)。`selected` は一覧で選んだ台風の series
 * (その台風の線を少し太くする)
 */
export function typhoonFeatures(
  infos: WeatherInfo[],
  selected: string | null,
): {
  lines: { type: "FeatureCollection"; features: Feature[] };
  points: { type: "FeatureCollection"; features: Feature[] };
} {
  const lines: Feature[] = [];
  const points: Feature[] = [];
  for (const w of infos) {
    const t = w.typhoon;
    if (!t || t.lat === undefined || t.lon === undefined) continue;
    const sel = w.series === selected;
    const line = (kind: TyphoonLineKind, coords: P[][]) => {
      for (const c of coords)
        lines.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: c },
          properties: { kind, sel },
        });
    };
    const fcs = w.typhoonForecasts ?? [];
    // 暴風警戒域 (実況の暴風域と、予報ごとの暴風警戒域の円)。予報に暴風警戒域が 1 つも無ければ描かない
    const warn = fcs.flatMap((f) =>
      f.stormWarning ? [ring(circleOf(f.circle, f.stormWarning))] : [],
    );
    if (warn.length > 0) {
      const rings = t.storm
        ? [ring(circleOf(t.storm, t.storm.axes)), ...warn]
        : warn;
      line("warning", envelope(rings));
    }
    for (const f of fcs)
      line("forecast", [ring(circleOf(f.circle, f.circle.axes))]);
    if (fcs.length > 0)
      line("track", [
        [[t.lon, t.lat], ...fcs.map((f): P => [f.circle.lon, f.circle.lat])],
      ]);
    if (t.gale) line("gale", [ring(circleOf(t.gale, t.gale.axes))]);
    if (t.storm) line("storm", [ring(circleOf(t.storm, t.storm.axes))]);
    points.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [t.lon, t.lat] },
      properties: {
        id: w.id,
        index: -1,
        kind: "now",
        sel,
        label: typhoonName(t),
      },
    });
    fcs.forEach((f, i) =>
      points.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [f.circle.lon, f.circle.lat] },
        properties: {
          id: w.id,
          index: i,
          kind: "forecast",
          sel,
          // 24 時間ごとの予報 (気象庁の図で日付を添える円)。3 時間ごとの予報は寄せたときだけ時刻を書く
          major: f.hours % 24 === 0,
          label: dayHour(f.time),
        },
      }),
    );
  }
  return {
    lines: { type: "FeatureCollection", features: lines },
    points: { type: "FeatureCollection", features: points },
  };
}

/** 「台風第 15 号」。番号の上 2 桁は年。番号の無いもの (発達する熱帯低気圧) は種類の名前 */
export function typhoonName(
  t: Pick<TyphoonNow, "number" | "className">,
): string {
  if (t.number) return `台風第 ${Number(t.number.slice(2))} 号`;
  return t.className?.replace(/\(.*\)$/, "") || "台風";
}

const DAY_HOUR = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  day: "numeric",
  hour: "numeric",
  hourCycle: "h23",
});
/** 「22日 9時」(予報円のそばに書く時刻。日本時間) */
export function dayHour(iso: string): string {
  const parts = Object.fromEntries(
    DAY_HOUR.formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.day}日 ${parts.hour}時`;
}

/** 吹き出しの 1 行 (海しるの点と同じ形) */
export interface TyphoonPopupLine {
  text: string;
  cls?: string;
}

/**
 * 押した台風の中心か予報円の中心の吹き出し。名前と号数・中心気圧・最大風速 (最大瞬間風速)・時刻と、予報なら
 * 予報円と暴風警戒域の半径。いちばん下に出典と「予報円は中心が 70% の確率で入る範囲」
 */
export function typhoonPopup(
  w: WeatherInfo,
  index: number,
  fmt: (iso: string) => string,
): TyphoonPopupLine[] {
  const t = w.typhoon;
  if (!t) return [];
  const f: TyphoonForecast | undefined =
    index >= 0 ? w.typhoonForecasts?.[index] : undefined;
  const name = [typhoonName(t), t.name ? `(${t.name})` : ""]
    .filter(Boolean)
    .join(" ");
  const lines: TyphoonPopupLine[] = [{ text: name, cls: "bold" }];
  const s = f ?? t;
  lines.push({
    text: f
      ? `${fmt(f.time)} の予報 (${f.hours} 時間後)`
      : `${fmt(w.reportedAt)} 発表の実況`,
    cls: "small",
  });
  const cls = [s.areaClass, s.intensityClass].filter(Boolean).join("で");
  if (cls) lines.push({ text: cls, cls: "small muted" });
  const facts = [
    s.pressureHpa !== undefined ? `中心気圧 ${s.pressureHpa} hPa` : "",
    s.maxWindMs !== undefined
      ? `最大風速 ${s.maxWindMs} m/s${s.maxGustMs !== undefined ? ` (最大瞬間風速 ${s.maxGustMs} m/s)` : ""}`
      : "",
  ].filter(Boolean);
  for (const x of facts) lines.push({ text: x, cls: "small" });
  if (f) {
    const km = circleOf(f.circle, f.circle.axes).km;
    lines.push({
      text: `予報円の半径 ${Math.round(km)} km`,
      cls: "small muted",
    });
    if (f.stormWarning)
      lines.push({
        text: `暴風警戒域の半径 ${Math.round(circleOf(f.circle, f.stormWarning).km)} km`,
        cls: "small muted",
      });
    lines.push({
      text: "予報円は、台風の中心が 70% の確率で入る範囲です",
      cls: "tiny muted",
    });
  } else if (t.location) {
    lines.push({ text: t.location, cls: "small muted" });
  }
  lines.push({
    text: "出典：気象庁「台風解析・予報情報」を加工して作成",
    cls: "tiny muted",
  });
  return lines;
}

/**
 * 選んだ台風が収まる範囲 (実況の強風域と、`maxHours` 時間後までの予報円・暴風警戒域の外枠)。[西, 南, 東, 北]
 */
export function typhoonBounds(
  w: WeatherInfo,
  maxHours = Number.POSITIVE_INFINITY,
): [number, number, number, number] | null {
  const t = w.typhoon;
  if (!t || t.lat === undefined || t.lon === undefined) return null;
  const circles: { lat: number; lon: number; km: number }[] = [
    { lat: t.lat, lon: t.lon, km: 0 },
  ];
  if (t.gale) circles.push(circleOf(t.gale, t.gale.axes));
  for (const f of w.typhoonForecasts ?? []) {
    if (f.hours > maxHours) continue;
    circles.push(circleOf(f.circle, f.circle.axes));
    if (f.stormWarning) circles.push(circleOf(f.circle, f.stormWarning));
  }
  const pts = circles.flatMap((c) =>
    c.km === 0
      ? [[c.lon, c.lat] as P]
      : [0, 90, 180, 270].map((b) => destination(c.lat, c.lon, b, c.km)),
  );
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 押した所に近い点 (海しるの点と同じく、`d2` は押した所からの距離 (px) の 2 乗) */
export function nearestTyphoonPoint<T extends { d2: number; index: number }>(
  hits: readonly T[],
): T | undefined {
  let best: T | undefined;
  // 同じ近さなら実況の中心 (index -1) を先に
  for (const h of hits)
    if (!best || h.d2 < best.d2 || (h.d2 === best.d2 && h.index < best.index))
      best = h;
  return best;
}

// ---- 地図の層 (`#lib/map/style.ts` が差し込む) ----

/** 地図の source の出典 (気象庁の電文の値をそのまま描く) */
export const TYPHOON_ATTRIBUTION = "気象庁 (台風解析・予報情報)";

const empty = { type: "FeatureCollection", features: [] };
/** 線 (`typhoon`) と点 (`typhoon-points`) の source */
export function typhoonSources(): Record<string, unknown> {
  return {
    typhoon: { type: "geojson", data: empty, attribution: TYPHOON_ATTRIBUTION },
    "typhoon-points": { type: "geojson", data: empty },
  };
}

const kindIs = (kind: TyphoonLineKind) => ["==", ["get", "kind"], kind];
/** 一覧で選んだ台風は線を 1.5 倍に */
const width = (w: number) => ["case", ["get", "sel"], w * 1.5, w];

/**
 * 線の層。警報・注意報の塗りの上、道路・地名・震源の丸の下に置く (押しても何も出さない)。
 * 実線 (暴風警戒域・暴風域・強風域) は写真の上で読めるよう、黒い細い縁を下に引く
 */
export function typhoonLineLayers(): Record<string, unknown>[] {
  const solid = [
    "in",
    ["get", "kind"],
    ["literal", ["warning", "storm", "gale"]],
  ];
  return [
    {
      id: "typhoon-casing",
      type: "line",
      source: "typhoon",
      filter: solid,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "rgba(0,0,0,0.45)",
        "line-width": [
          "case",
          ["==", ["get", "kind"], "storm"],
          width(5),
          width(3.5),
        ],
      },
    },
    {
      id: "typhoon-gale",
      type: "line",
      source: "typhoon",
      filter: kindIs("gale"),
      layout: { "line-join": "round" },
      paint: { "line-color": TYPHOON_YELLOW, "line-width": width(1.75) },
    },
    {
      id: "typhoon-storm",
      type: "line",
      source: "typhoon",
      filter: kindIs("storm"),
      layout: { "line-join": "round" },
      paint: { "line-color": TYPHOON_RED, "line-width": width(3) },
    },
    {
      id: "typhoon-warning",
      type: "line",
      source: "typhoon",
      filter: kindIs("warning"),
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": TYPHOON_RED, "line-width": width(1.75) },
    },
    {
      id: "typhoon-forecast",
      type: "line",
      source: "typhoon",
      filter: kindIs("forecast"),
      paint: {
        "line-color": "#ffffff",
        "line-width": width(1.5),
        "line-dasharray": [3, 2],
      },
    },
    {
      id: "typhoon-track",
      type: "line",
      source: "typhoon",
      filter: kindIs("track"),
      paint: {
        "line-color": "#ffffff",
        "line-opacity": 0.85,
        "line-width": width(1),
        "line-dasharray": [1.5, 2],
      },
    },
  ];
}

/**
 * 点の層 (実況の中心と予報円の中心、そばの名前と時刻)。通行止めの線の上、海しるの点の下 (押すと吹き出し)。
 * 実況の中心は白い縁の赤い丸、予報円の中心は黒い縁の白い小さな丸。字は重なれば MapLibre が間引く
 */
export function typhoonPointLayers(): Record<string, unknown>[] {
  const isNow = ["==", ["get", "kind"], "now"];
  return [
    {
      id: "typhoon-center",
      type: "circle",
      source: "typhoon-points",
      paint: {
        "circle-radius": ["case", isNow, 6, 3],
        "circle-color": ["case", isNow, TYPHOON_RED, "#ffffff"],
        "circle-stroke-color": ["case", isNow, "#ffffff", "rgba(0,0,0,0.7)"],
        "circle-stroke-width": ["case", isNow, 2, 1],
      },
      layout: { "circle-sort-key": ["case", isNow, 1, 0] },
    },
    {
      id: "typhoon-label",
      type: "symbol",
      source: "typhoon-points",
      // 引いているときは、いまの中心と 24 時間ごとの予報だけ (3 時間ごとの予報の時刻が中心のまわりで重なるため)
      filter: [
        "step",
        ["zoom"],
        ["any", isNow, ["==", ["get", "major"], true]],
        6,
        true,
      ],
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans JP", "sans-serif"],
        "text-size": ["case", isNow, 13, 11],
        "text-anchor": "top",
        "text-offset": [0, 0.8],
        "symbol-sort-key": ["case", isNow, 0, 1],
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.85)",
        "text-halo-width": 1.6,
      },
    },
  ];
}
