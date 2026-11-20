/**
 * 雨雲 (気象庁の高解像度降水ナウキャストの、いまの降水強度)。docs/map.md の「雨雲」。
 * 気象庁ホームページの雨雲の動きの画面が読むタイルを、ブラウザから直接読む。公式の API ではなく、予告なく変わる。
 * 出すのは観測から作った「いま」の 1 枚だけで、気象庁の 1 時間先の予測も、自分で先を予想することもしない (docs/design.md の 5 章)。
 * DOM にも MapLibre にも触らない (試験できるように)
 */

export const NOWC = "https://www.jma.go.jp/bosai/jmatile/data/nowc";
/** いまと過去 3 時間の時刻の表 (5 分ごと。新しい順)。予測の表 (N2) は読まない */
export const RAIN_TIMES_URL = `${NOWC}/targetTimes_N1.json`;
/** 気象庁ホームページの雨雲の動きの画面 (凡例と出典のリンク) */
export const RAIN_PAGE = "https://www.jma.go.jp/bosai/nowc/";
export const RAIN_ATTRIBUTION = `<a href="${RAIN_PAGE}" target="_blank" rel="noopener">気象庁 高解像度降水ナウキャスト</a> を加工`;

/** 地図の隅の短い出典は「気象庁」をもう含むので足さない。凡例に出す出典 */
export const RAIN_CREDIT = "気象庁 (高解像度降水ナウキャスト)";

/**
 * タイルのあるズーム。偶数だけで、奇数のズームと 4 未満・10 より上は、雨の無い所と同じ空のタイルが返る
 * (2026-11-20 に確かめた)。そのため段ごとに source を分け、間のズームは下の段を引き伸ばす
 */
export const RAIN_TILE_ZOOMS = [4, 6, 8, 10] as const;
export type RainTileZoom = (typeof RAIN_TILE_ZOOMS)[number];

/**
 * 段ごとの層を出す地図のズーム。MapLibre の地図のズーム z は 256px のタイルの z + 1 を読むので、
 * タイルのズーム n の段は地図のズーム n − 1 から n + 1 の手前まで (n − 1 で引き伸ばさずにちょうど合う)
 */
export function rainLayerZoom(n: RainTileZoom): {
  minzoom?: number;
  maxzoom?: number;
} {
  const first = n === RAIN_TILE_ZOOMS[0];
  const last = n === RAIN_TILE_ZOOMS.at(-1);
  return {
    ...(first ? {} : { minzoom: n - 1 }),
    ...(last ? {} : { maxzoom: n + 1 }),
  };
}

/** 1 枚の雨雲。時刻は UTC の `YYYYMMDDhhmmss` (表のまま) */
export interface RainFrame {
  basetime: string;
  validtime: string;
}

const STAMP = /^\d{14}$/;

/** 時刻の表から、いちばん新しい観測 (いま) を選ぶ。読めなければ null */
export function latestRain(raw: unknown): RainFrame | null {
  if (!Array.isArray(raw)) return null;
  let best: RainFrame | null = null;
  for (const row of raw as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { basetime, validtime, elements } = row as Record<string, unknown>;
    if (typeof basetime !== "string" || typeof validtime !== "string") continue;
    if (!STAMP.test(basetime) || !STAMP.test(validtime)) continue;
    // 観測の 1 枚は basetime と validtime が同じ。予測 (validtime が先) は使わない
    if (basetime !== validtime) continue;
    if (Array.isArray(elements) && !elements.includes("hrpns")) continue;
    if (!best || validtime > best.validtime) best = { basetime, validtime };
  }
  return best;
}

/** タイルの URL の型 (`{z}/{x}/{y}` は MapLibre が埋める) */
export const rainTiles = (f: RainFrame) =>
  `${NOWC}/${f.basetime}/none/${f.validtime}/surf/hrpns/{z}/{x}/{y}.png`;

/** 観測の時刻 (ISO 8601。画面は `#lib/format.ts` の `jst` で出す) */
export function rainIso(f: RainFrame): string {
  const t = f.validtime;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`;
}

/** 更新の間隔 (5 分ごとの観測) */
export const RAIN_STEP_MS = 5 * 60_000;
/**
 * 観測の時刻から、その時刻の表が取れるまでの待ち。表は観測の時刻の約 20 秒後に書き換わり、配信の CDN が
 * 60 秒覚えるので、90 秒待てば取れる (2026-11-20 に確かめた)
 */
export const RAIN_PUBLISH_MS = 90_000;
/** 次の時刻がまだ無かったとき・読めなかったときに、取り直すまでの間 */
export const RAIN_RETRY_MS = 60_000;
/** 観測の時刻からこれより経ったら古いとみなし、凡例にそう書く (3 回続けて更新が取れていない) */
export const RAIN_STALE_MS = 15 * 60_000;

/**
 * 次に時刻の表を取るまでのミリ秒。いまの観測の次の時刻が出そろう頃 (観測の時刻 + 5 分 + 90 秒) に取り、
 * もう過ぎていれば (遅れている・まだ取れていない) 1 分後に取り直す
 */
export function nextRainPoll(frame: RainFrame | null, now: number): number {
  if (!frame) return RAIN_RETRY_MS;
  const due = Date.parse(rainIso(frame)) + RAIN_STEP_MS + RAIN_PUBLISH_MS;
  const wait = due - now;
  return wait > 0
    ? Math.min(wait, RAIN_STEP_MS + RAIN_PUBLISH_MS)
    : RAIN_RETRY_MS;
}

/** 観測が古いか (更新が取れていない) */
export const rainStale = (frame: RainFrame, now: number) =>
  now - Date.parse(rainIso(frame)) > RAIN_STALE_MS;

/**
 * 凡例 (mm/h。強いものから)。色はタイルの PNG のパレットのまま (2026-11-20 に読んだ)。区切りと色は、気象庁の配色の指針の
 * 表 2-1 の「降水量 (レーダー・ナウキャスト)」と同じ。
 * いちばん弱い 0〜1 の淡い色も塗られる
 */
export const RAIN_LEGEND: { color: string; label: string }[] = [
  { color: "rgb(180 0 104)", label: "80 以上" },
  { color: "rgb(255 40 0)", label: "50〜80" },
  { color: "rgb(255 153 0)", label: "30〜50" },
  { color: "rgb(250 245 0)", label: "20〜30" },
  { color: "rgb(0 65 255)", label: "10〜20" },
  { color: "rgb(33 140 255)", label: "5〜10" },
  { color: "rgb(160 210 255)", label: "1〜5" },
  { color: "rgb(242 242 255)", label: "0〜1" },
];
