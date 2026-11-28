/**
 * キキクル (気象庁の大雨の危険度分布)。docs/map.md の「キキクル」。
 * 気象庁ホームページのキキクルの画面が読むタイルを、ブラウザから直接読む。公式の API ではなく、予告なく変わる。
 * 気象庁が判定した危険度の 1 枚を、色も値も変えずに重ねるだけで、sonae が危険度を判定し直すことはしない
 * (docs/design.md の 5 章)。DOM にも MapLibre にも触らない (試験できるように)
 */

import { RAIN_TILE_ZOOMS } from "#lib/map/rain.ts";

export const RISK = "https://www.jma.go.jp/bosai/jmatile/data/risk";
/** 時刻の表 (10 分ごと。新しい順。いまと過去 6 時間ほど) */
export const RISK_TIMES_URL = `${RISK}/targetTimes.json`;
/** 気象庁ホームページのキキクルの画面 (凡例と出典のリンク) */
export const RISK_PAGE = "https://www.jma.go.jp/bosai/risk/";
export const RISK_ATTRIBUTION = `<a href="${RISK_PAGE}" target="_blank" rel="noopener">気象庁 キキクル</a> を加工`;

/** 地図の隅の短い出典は「気象庁」をもう含むので足さない。凡例に出す出典 */
export const RISK_CREDIT = "気象庁 (キキクル)";

/**
 * タイルのあるズーム。雨雲と同じく偶数の 4〜10 だけで、ほかのズームは何も塗っていない空のタイル (334 バイト) が返る
 * (2026-11-21 に確かめた。キキクルの画面の設定も `zoomUse="even"`)
 */
export const RISK_TILE_ZOOMS = RAIN_TILE_ZOOMS;

/**
 * 選べるキキクル。気象庁のキキクルの画面と同じ 4 つ (土砂・大雨・浸水・洪水) を同じ順に並べる (docs/map.md の
 * 「キキクル」)。土砂・大雨・浸水は格子を塗るタイル、洪水は川の線 (中小河川のベクトルタイルと、指定河川の GeoJSON)
 */
export interface RiskKind {
  id: "risk-land" | "risk-heavyrain" | "risk-inund" | "risk-flood";
  /** 時刻の表の `elements` の名前。格子のものはタイルの要素の名前と同じ */
  element: "land" | "rain_mesh" | "inund" | "flood";
  /** 格子を塗るタイル (`grid`) か、川の線 (`river`) か */
  draw: "grid" | "river";
  /** 選択肢の名前 (見出し「キキクル」の下) */
  label: string;
  /** 凡例の上に出す名前 */
  title: string;
  /** 凡例の下に出す、何の危険度か */
  about: string;
}

export const RISKS: RiskKind[] = [
  {
    id: "risk-land",
    element: "land",
    draw: "grid",
    label: "土砂",
    title: "土砂キキクル (土砂災害の危険度)",
    about:
      "土砂災害の危険度を、実況と 2 時間先までの雨の予測から気象庁が判定したものです。",
  },
  {
    id: "risk-heavyrain",
    element: "rain_mesh",
    draw: "grid",
    label: "大雨 (浸水・洪水)",
    title: "大雨キキクル (浸水・洪水の危険度)",
    about:
      "低地の浸水と中小河川の氾濫の危険度を、気象庁が浸水キキクルと洪水キキクルを重ねて判定したものです。大きな川の氾濫は「洪水 (川)」か、一覧の「気象」の指定河川洪水予報を見てください。",
  },
  {
    id: "risk-inund",
    element: "inund",
    draw: "grid",
    label: "浸水",
    title: "浸水キキクル (浸水害の危険度)",
    about:
      "短い時間の強い雨で低い土地が水につかる危険度を、実況と 1 時間先までの雨の予測から気象庁が判定したものです。",
  },
  {
    id: "risk-flood",
    element: "flood",
    draw: "river",
    label: "洪水 (川)",
    title: "洪水キキクル (川の氾濫の危険度)",
    about:
      "細い線 (灰色の縁) は中小河川の氾濫の危険度、太い線 (黒い縁) は洪水予報の出ている大きな川 (指定河川) の区間です。気象庁の判定のまま引いています。",
  },
];

export const riskOf = (id: string): RiskKind | undefined =>
  RISKS.find((r) => r.id === id);

/** 1 枚のキキクル。時刻は UTC の `YYYYMMDDhhmmss` (表のまま)。member はタイルの URL の途中の名前 */
export interface RiskFrame {
  basetime: string;
  validtime: string;
  member: string;
}

const STAMP = /^\d{14}$/;
const MEMBER = /^[a-z0-9_]+$/;

/** 時刻の表から、その要素のいちばん新しい 1 枚を選ぶ。読めなければ null */
export function latestRisk(
  raw: unknown,
  element: RiskKind["element"],
): RiskFrame | null {
  if (!Array.isArray(raw)) return null;
  let best: RiskFrame | null = null;
  for (const row of raw as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { basetime, validtime, member, elements } = row as Record<
      string,
      unknown
    >;
    if (typeof basetime !== "string" || typeof validtime !== "string") continue;
    if (!STAMP.test(basetime) || !STAMP.test(validtime)) continue;
    // 表の行は basetime と validtime が同じ (その時刻の判定)。違う行が来ても使わない
    if (basetime !== validtime) continue;
    // 新しい 3 枚は immed0〜2、それより前は none (2026-11-21 に読んだ)。URL に入れるので形を確かめる
    if (typeof member !== "string" || !MEMBER.test(member)) continue;
    if (!Array.isArray(elements) || !elements.includes(element)) continue;
    if (!best || validtime > best.validtime)
      best = { basetime, validtime, member };
  }
  return best;
}

/** タイルの URL の型 (`{z}/{x}/{y}` は MapLibre が埋める) */
export const riskTiles = (f: RiskFrame, element: RiskKind["element"]) =>
  `${RISK}/${f.basetime}/${f.member}/${f.validtime}/surf/${element}/{z}/{x}/{y}.png`;

/** 判定の時刻 (ISO 8601。画面は `#lib/format.ts` の `jst` で出す) */
export function riskIso(f: RiskFrame): string {
  const t = f.validtime;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`;
}

/** 更新の間隔 (10 分ごと) */
export const RISK_STEP_MS = 10 * 60_000;
/**
 * 判定の時刻から、その時刻の表が取れるまでの待ち。表はその時刻の約 10 分 10 秒後に書き換わり、配信の CDN が
 * 60 秒覚えるので、11 分 30 秒待てば取れる (2026-11-21 に確かめた)
 */
export const RISK_PUBLISH_MS = 11.5 * 60_000;
/** 次の時刻がまだ無かったとき・読めなかったときに、取り直すまでの間 */
export const RISK_RETRY_MS = 60_000;
/**
 * 判定の時刻からこれより経ったら古いとみなし、凡例にそう書く。ふだんでも表に載るまでに 10 分ほど掛かり、
 * 次の時刻が載る直前には 21 分 30 秒ほど前のものになる。そこから 2 回続けて更新が取れていない
 */
export const RISK_STALE_MS = 40 * 60_000;

/**
 * 次に時刻の表を取るまでのミリ秒。いまの 1 枚の次の時刻が表に載る頃 (判定の時刻 + 10 分 + 11 分 30 秒) に取り、
 * もう過ぎていれば (遅れている・まだ取れていない) 1 分後に取り直す
 */
export function nextRiskPoll(frame: RiskFrame | null, now: number): number {
  if (!frame) return RISK_RETRY_MS;
  const due = Date.parse(riskIso(frame)) + RISK_STEP_MS + RISK_PUBLISH_MS;
  const wait = due - now;
  return wait > 0
    ? Math.min(wait, RISK_STEP_MS + RISK_PUBLISH_MS)
    : RISK_RETRY_MS;
}

/** 判定が古いか (更新が取れていない) */
export const riskStale = (frame: RiskFrame, now: number) =>
  now - Date.parse(riskIso(frame)) > RISK_STALE_MS;

/**
 * 凡例 (危険度の高いものから)。色はタイルの PNG のパレットのまま (2026-11-21 に読んだ)。気象庁の配色の指針の
 * 表 1-1 (大雨の警戒レベルと相当する情報) の 12,0,12・170,0,170・255,40,0・242,231,0 と同じで、言葉はキキクルの
 * 画面の凡例のまま (「警戒レベル」は凡例の幅に収めるため「レベル」と書く)。いちばん低い「今後の情報等に留意」(白) はタイルでは透明で、塗らない
 */
export const RISK_LEGEND: { color: string; label: string; level: string }[] = [
  { color: "rgb(12 0 12)", label: "災害切迫", level: "レベル 5 相当" },
  { color: "rgb(170 0 170)", label: "危険", level: "レベル 4 相当" },
  { color: "rgb(255 40 0)", label: "警戒", level: "レベル 3 相当" },
  { color: "rgb(242 231 0)", label: "注意", level: "レベル 2 相当" },
];

// ---- 洪水キキクルの川の線 (docs/map.md の「キキクル」の「洪水 (川)」) ----
// 描き方 (色・縁・太さ・ズーム) は、気象庁のキキクルの画面の設定 (`risk/table/risk.properties__*.xml` の
// element `flood`。2026-11-28 に読んだ) に合わせる。気象庁が判定した段をそのまま色にし、段を作り直さない

/** 川の地図 (変わらないもの) */
const RISK_MAP = "https://www.jma.go.jp/bosai/jmatile/data/map/none/none/none/surf";
/** 指定河川 (国と都道府県が洪水予報をする川、340 の区間) の線。gzip で 290KB ほど。いまの段は持たない */
export const RIVER_MAP_URL = `${RISK_MAP}/designated_river/data.geojson`;
/** 指定河川の地図・灰色の縁・区間の名前を出す地図のズーム (気象庁の画面の 8 は 256px のタイルのズームで、MapLibre の地図のズームでは 7) */
export const RIVER_MAP_MINZOOM = 7;

/** 中小河川の危険度のベクトルタイル (層 `flood`)。偶数のズームの 4〜10 だけを読む (気象庁の画面も `zoomUse="even"`) */
export const floodTiles = (f: RiskFrame) =>
  `${RISK}/${f.basetime}/${f.member}/${f.validtime}/surf/flood/{z}/{x}/{y}.pbf`;
/** 洪水予報の出ている指定河川の区間 (段のあるものだけ。出ていなければ空の FeatureCollection) */
export const designatedRiverUrl = (f: RiskFrame) =>
  `${RISK}/${f.basetime}/${f.member}/${f.validtime}/surf/designated_river/data.geojson`;

/**
 * 段の色 (気象庁の画面の設定のまま)。指定河川の段 (`level`) は 2〜5 (氾濫注意情報〜氾濫特別警報。警戒レベル 2〜5
 * 相当)、中小河川の段は 1〜4 (注意〜災害切迫。警戒レベル 2〜5 相当)。どちらも段の無いものは水色 (今後の情報等に留意)。
 * 色は配色の指針の表 1-1 と同じで、格子のキキクル (`RISK_LEGEND`) とそろう
 */
export const RIVER_LEVEL_COLORS = {
  5: "#0c000c",
  4: "#aa00aa",
  3: "#ff2800",
  2: "#f2e700",
} as const;
/** 指定河川の段の無い区間と川の地図の色 */
export const RIVER_CALM_COLOR = "#80ffff";
/** 中小河川の段の無い線の色 */
export const SMALL_RIVER_CALM_COLOR = "#3cffff";
/** 指定河川の縁 (災害切迫だけ明るい灰色。黒の線を写真の上で見分けるため) と、中小河川の縁 */
export const RIVER_CASING = "#333333";
export const RIVER_CASING_SEVERE = "#c4c4c4";
export const SMALL_RIVER_CASING = "#b4b4b4";

/** 地図に引く指定河川の区間 (段と名前)。線と、名前を置く 1 点 */
export interface RiverSegment {
  name: string;
  /** 段 (2〜5)。段の無い区間は描かない */
  level: 2 | 3 | 4 | 5;
  lines: [number, number][][];
  label: [number, number];
}

const lonLat = (p: unknown): [number, number] | null =>
  Array.isArray(p) &&
  typeof p[0] === "number" &&
  typeof p[1] === "number" &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1])
    ? [p[0], p[1]]
    : null;

/**
 * 気象庁の `designated_river` の GeoJSON から、段 (2〜5) のある区間を取り出す。読めない地物は捨てる。
 * 名前は `fcstAreaNameJP` (「最上川下流」)、置き場は `labelLat`・`labelLon` (無ければいちばん長い線の真ん中の点)
 */
export function riverSegments(raw: unknown): RiverSegment[] {
  const features = (raw as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: RiverSegment[] = [];
  for (const f of features as unknown[]) {
    if (typeof f !== "object" || f === null) continue;
    const { properties, geometry } = f as Record<string, unknown>;
    const p = (properties ?? {}) as Record<string, unknown>;
    const level = p.level;
    if (level !== 2 && level !== 3 && level !== 4 && level !== 5) continue;
    const g = (geometry ?? {}) as { type?: unknown; coordinates?: unknown };
    const parts =
      g.type === "LineString"
        ? [g.coordinates]
        : g.type === "MultiLineString" && Array.isArray(g.coordinates)
          ? g.coordinates
          : [];
    const lines = (parts as unknown[])
      .map((l) =>
        Array.isArray(l)
          ? l.map(lonLat).filter((q): q is [number, number] => q !== null)
          : [],
      )
      .filter((l) => l.length >= 2);
    if (lines.length === 0) continue;
    const given =
      typeof p.labelLon === "number" && typeof p.labelLat === "number"
        ? lonLat([p.labelLon, p.labelLat])
        : null;
    const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
    const label = given ?? longest[Math.floor(longest.length / 2)];
    if (!label) continue;
    out.push({
      name: typeof p.fcstAreaNameJP === "string" ? p.fcstAreaNameJP : "",
      level,
      lines,
      label,
    });
  }
  return out;
}

/** 指定河川の区間を、地図の GeoJSON (線と名前の点) にする */
export function riverFeatures(segments: RiverSegment[]): {
  type: "FeatureCollection";
  features: unknown[];
} {
  return {
    type: "FeatureCollection",
    features: segments.flatMap((s) => [
      {
        type: "Feature",
        properties: { level: s.level, name: s.name },
        geometry: { type: "MultiLineString", coordinates: s.lines },
      },
      {
        type: "Feature",
        properties: { level: s.level, name: s.name },
        geometry: { type: "Point", coordinates: s.label },
      },
    ]),
  };
}
