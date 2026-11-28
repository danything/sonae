/**
 * 今後の雪 (気象庁の解析積雪深・解析降雪量と、降雪短時間予報)。docs/map.md の「今後の雪」。
 * 気象庁ホームページの「今後の雪」の画面が読むタイルを、sonae のサーバーの中継 (`#lib/relay.ts`) を通して読む。
 * 公式の API ではなく、予告なく変わる。気象庁が解析・予測した 1 枚を色も値も変えずに重ねるだけで、sonae が先の雪を
 * 予想することはしない (docs/design.md の 5 章)。気象庁は冬の間だけ配信する。DOM にも MapLibre にも触らない (試験できるように)
 */

import {
  JMATILE,
  type NowcFrame,
  rows,
  stampAge,
  stepLayerZoom,
} from "#lib/map/nowc.ts";

const SNOW = `${JMATILE}/snow`;
/** 時刻の表 (新しい順。1 時間ごとの解析の過去 24 時間と、いちばん新しい解析からの 1〜6 時間先の予測) */
export const SNOW_TIMES_URL = `${SNOW}/targetTimes.json`;
/** 気象庁ホームページの「今後の雪」の画面 (凡例と出典のリンク) */
export const SNOW_PAGE = "https://www.jma.go.jp/bosai/snow/";
export const SNOW_ATTRIBUTION = `<a href="${SNOW_PAGE}" target="_blank" rel="noopener">気象庁 今後の雪</a> を加工`;

/**
 * タイルのあるズーム。雨雲と同じく偶数の 4〜10 だけ (気象庁の画面の設定 `snow.properties` の `zoomUse="even"`・
 * `maxNativeZoom` 10。2026-11-28 に読んだ)。ほかのズームは何も塗っていないタイルが返る
 */
export const SNOW_TILE_ZOOMS = [4, 6, 8, 10] as const;

/** 段ごとの層を出す地図のズーム (`#lib/map/nowc.ts` の `stepLayerZoom`) */
export const snowLayerZoom = (n: (typeof SNOW_TILE_ZOOMS)[number]) =>
  stepLayerZoom(n, SNOW_TILE_ZOOMS);

/** 選べる降雪量の時間 (気象庁の画面と同じ 3・6・12・24・48・72 時間) */
export const SNOW_FALL_HOURS = [3, 6, 12, 24, 48, 72] as const;
export type SnowFallHours = (typeof SNOW_FALL_HOURS)[number];
/** 既定の降雪量の時間。大雪警報の基準の多くが 12 時間の降雪の深さなので */
export const SNOW_FALL_DEFAULT: SnowFallHours = 12;

/** 選べる今後の雪 */
export interface SnowKind {
  id: "snow-depth" | "snow-fall";
  /** タイルの要素の名前 (気象庁の画面の element。`snowd` か `snowf03h` など) */
  element: string;
  /** 選択肢の名前 */
  label: string;
  /** 選んでいる間のボタンの文字 */
  pill: string;
  /** 凡例の見出し */
  title: string;
  /** 凡例 (多いものから)。色はタイルのパレットのまま */
  legend: { color: string; label: string }[];
  about: string;
}

/** 凡例の色 (多いものから)。気象庁の凡例の SVG と少し違う 250,245,0 と 242,242,255 は、タイルのパレットに合わせる */
const SNOW_COLORS = [
  "rgb(180 0 104)",
  "rgb(255 40 0)",
  "rgb(255 153 0)",
  "rgb(250 245 0)",
  "rgb(0 65 255)",
  "rgb(33 140 255)",
  "rgb(160 210 255)",
  "rgb(242 242 255)",
];

/** 区切り (cm、多いものから) から凡例を作る。いちばん上は「以上」、いちばん下は「未満」 */
function scale(steps: number[]): SnowKind["legend"] {
  const out = steps.map((s, i) => ({
    color: SNOW_COLORS[i] ?? "",
    label: i === 0 ? `${s} 以上` : `${s}〜${steps[i - 1]}`,
  }));
  const last = steps.at(-1);
  if (last !== undefined)
    out.push({
      color: SNOW_COLORS[steps.length] ?? "",
      label: `${last} 未満`,
    });
  return out;
}

/**
 * 降雪量の区切り (cm、多いものから)。気象庁の画面の凡例 (`legend_normal_snowf03h.svg` など。2026-11-28 に読んだ)
 * のまま。どの時間も 8 色
 */
const SNOW_FALL_STEPS: Record<SnowFallHours, number[]> = {
  3: [30, 25, 20, 15, 10, 5, 3],
  6: [40, 30, 25, 20, 15, 10, 5],
  12: [50, 40, 30, 25, 20, 15, 7],
  24: [70, 60, 50, 40, 30, 20, 10],
  48: [100, 80, 60, 40, 30, 20, 10],
  72: [120, 100, 80, 60, 40, 20, 10],
};

/** 積雪の深さ。気象庁の画面の既定。凡例は `legend_normal_snowd.svg` の 7 色 (いちばん下は 5 未満) */
const SNOW_DEPTH: SnowKind = {
  id: "snow-depth",
  element: "snowd",
  label: "積雪の深さ",
  pill: "今後の雪: 積雪の深さ",
  title: "積雪の深さ (cm)",
  legend: scale([200, 150, 100, 50, 20, 5]),
  about:
    "気象庁がアメダスや気象レーダーなどから解析した積雪の深さ (約 5km 四方ごと) と、その予測です。",
};

/** 降雪量 (その時刻までの `hours` 時間に降った雪の深さ) */
export function snowFallKind(hours: SnowFallHours): SnowKind {
  return {
    id: "snow-fall",
    element: `snowf${String(hours).padStart(2, "0")}h`,
    label: "降雪量",
    pill: `今後の雪: 降雪量 (${hours} 時間)`,
    title: `降雪量 (${hours} 時間に降った雪の深さ cm)`,
    legend: scale(SNOW_FALL_STEPS[hours]),
    about: `その時刻までの ${hours} 時間に降った雪の深さを、気象庁が解析・予測したものです (約 5km 四方ごと)。`,
  };
}

/** 重ねる図の選択肢に並べる今後の雪 (降雪量の時間は凡例の上で選ぶ) */
export const SNOW_KINDS: SnowKind[] = [
  SNOW_DEPTH,
  snowFallKind(SNOW_FALL_DEFAULT),
];

/** 端末に覚えた降雪量の時間を読む。知らない値は既定 (12 時間) */
export function readSnowHours(raw: string | null): SnowFallHours {
  const h = Number(raw);
  return (SNOW_FALL_HOURS as readonly number[]).includes(h)
    ? (h as SnowFallHours)
    : SNOW_FALL_DEFAULT;
}

/** 選んでいる今後の雪 (降雪量は時間で要素と凡例が替わる)。今後の雪でなければ undefined */
export function snowOf(
  id: string,
  hours: SnowFallHours = SNOW_FALL_DEFAULT,
): SnowKind | undefined {
  if (id === "snow-depth") return SNOW_DEPTH;
  if (id === "snow-fall") return snowFallKind(hours);
  return undefined;
}

/** 今後の雪の 1 枚。予測なら何時間先か (解析は 0) */
export interface SnowFrame extends NowcFrame {
  /** 解析 (basetime と validtime が同じ) か、予測か */
  forecast: boolean;
}

/**
 * 時刻の表から、見せる枚の並びを作る。0 枚目はいちばん新しい解析 (いま)、その後に同じ解析からの予測を先の時刻の順に
 * 並べる。その要素の無い行は使わない。解析が無ければ空 (冬でない間は表が空か、要素が無い)
 */
export function snowFrames(
  raw: unknown,
  element: SnowKind["element"],
): SnowFrame[] {
  const rs = rows(raw).filter((r) => r.elements.includes(element));
  let now: NowcFrame | null = null;
  for (const r of rs)
    if (r.basetime === r.validtime && (!now || r.validtime > now.validtime))
      now = { basetime: r.basetime, validtime: r.validtime, member: r.member };
  if (!now) return [];
  const base = now.basetime;
  const fc = rs
    .filter((r) => r.basetime === base && r.validtime > r.basetime)
    .map(({ basetime, validtime, member }) => ({
      basetime,
      validtime,
      member,
      forecast: true,
    }))
    .sort((a, b) => a.validtime.localeCompare(b.validtime));
  return [{ ...now, forecast: false }, ...fc];
}

/** タイルの URL の型 (`{z}/{x}/{y}` は MapLibre が埋める) */
export const snowTiles = (f: NowcFrame, element: SnowKind["element"]) =>
  `${SNOW}/${f.basetime}/${f.member}/${f.validtime}/surf/${element}/{z}/{x}/{y}.png`;

/** 時刻の表を取り直す間 (解析は 1 時間ごと。出している間だけ) */
export const SNOW_POLL_MS = 10 * 60_000;
/** 解析の時刻からこれより経ったら古いとみなし、凡例にそう書く (1 時間ごとの更新が 2 回続けて取れていない) */
const SNOW_STALE_MS = 150 * 60_000;
export const snowStale = (f: NowcFrame, now: number) =>
  stampAge(f.basetime, now) > SNOW_STALE_MS;

/**
 * 配信のある時期か (選択肢に「今後の雪」を出すか) を確かめ直す間。気象庁は冬の間だけ配信するので、開いている間に
 * 季節が替わることはまれ。6 時間ごとに時刻の表を 1 度読む
 */
export const SNOW_SEASON_MS = 6 * 3_600_000;
