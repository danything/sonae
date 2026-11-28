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

/** 選べる今後の雪 */
export interface SnowKind {
  id: "snow-depth" | "snow-fall";
  /** タイルの要素の名前 (気象庁の画面の element) */
  element: "snowd" | "snowf12h";
  /** 選択肢とボタンの名前 */
  label: string;
  /** 凡例の見出し */
  title: string;
  /** 凡例 (多いものから)。色はタイルのパレットのまま */
  legend: { color: string; label: string }[];
  about: string;
}

/**
 * 選べる今後の雪。気象庁の画面の既定の「積雪の深さ」と、大雪警報の基準の多くが 12 時間の降雪の深さなので
 * 「降雪量 (12 時間)」の 2 つ。凡例の区切りは気象庁の画面の凡例 (`legend_normal_snowd.svg`・
 * `legend_normal_snowf12h.svg`)、色はタイルのパレット (凡例の SVG と少し違う 250,245,0 と 242,242,255 はタイルに合わせる)。
 * 2026-11-28 に読んだ
 */
export const SNOW_KINDS: SnowKind[] = [
  {
    id: "snow-depth",
    element: "snowd",
    label: "積雪の深さ",
    title: "積雪の深さ (cm)",
    legend: [
      { color: "rgb(180 0 104)", label: "200 以上" },
      { color: "rgb(255 40 0)", label: "150〜200" },
      { color: "rgb(255 153 0)", label: "100〜150" },
      { color: "rgb(250 245 0)", label: "50〜100" },
      { color: "rgb(0 65 255)", label: "20〜50" },
      { color: "rgb(33 140 255)", label: "5〜20" },
      { color: "rgb(160 210 255)", label: "5 未満" },
    ],
    about:
      "気象庁がアメダスや気象レーダーなどから解析した積雪の深さ (約 5km 四方ごと) と、その予測です。",
  },
  {
    id: "snow-fall",
    element: "snowf12h",
    label: "降雪量 (12 時間)",
    title: "降雪量 (12 時間に降った雪の深さ cm)",
    legend: [
      { color: "rgb(180 0 104)", label: "50 以上" },
      { color: "rgb(255 40 0)", label: "40〜50" },
      { color: "rgb(255 153 0)", label: "30〜40" },
      { color: "rgb(250 245 0)", label: "25〜30" },
      { color: "rgb(0 65 255)", label: "20〜25" },
      { color: "rgb(33 140 255)", label: "15〜20" },
      { color: "rgb(160 210 255)", label: "7〜15" },
      { color: "rgb(242 242 255)", label: "7 未満" },
    ],
    about:
      "その時刻までの 12 時間に降った雪の深さを、気象庁が解析・予測したものです (約 5km 四方ごと)。",
  },
];

export const snowOf = (id: string): SnowKind | undefined =>
  SNOW_KINDS.find((k) => k.id === id);

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
