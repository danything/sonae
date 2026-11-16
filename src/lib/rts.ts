/**
 * 台湾の観測点のいまの揺れ (ExpTech の TREM-RTS)。サーバーと画面の両方で使う形と、地図に描く点
 * (docs/design.md の 2.9)。
 *
 * - 非公式の観測網 (TREM-net) の値で、中央氣象署の発表ではない。**地図に色で出すだけで、一覧にも知らせ
 *   (音・読み上げ・OS の通知・Web Push・Webhook) にも使わない** (ExpTech の規約: 予警報に使わない・安全の判断の
 *   唯一の根拠にしない)。そのため DB にも入れず、`SonaeEvent` にもしない
 * - どこからでも読むので、Bun や DOM にしか無いものは使わない
 */

import { INTENSITY_COLORS } from "./format.ts";

/** 観測点の位置 [経度, 緯度] */
export type RtsStation = [number, number];

/** 画面に送る観測点の表 (`event: rts-stations`)。使える観測点だけ */
export interface RtsStations {
  stations: RtsStation[];
}

/**
 * 画面に送るいまの揺れ (`event: rts`)。`at` はサーバーが受けた時刻 (ISO 8601)。
 * `points` は値の来た観測点の [経度, 緯度, 計測震度]。空なら、いま揺れの値は無い
 */
export interface RtsFrame {
  at: string;
  points: [number, number, number][];
}

/**
 * これより古い値は捨てる (ミリ秒)。ExpTech の既定 (sleep) は、地震の間だけ 0.5 秒ごとに送り、
 * 揺れが収まると送らなくなる。最後の色が残り続けないよう、10 秒届かなければ消す
 */
export const RTS_STALE_MS = 10_000;

/**
 * 計測震度から震度の階級 (気象庁の階級の境と同じ切り方) を引く。0.5 未満は無し。
 * TREM の値は TREM-net の観測で、気象庁の震度ではない。色を引くためだけに使う
 */
export function rtsClass(i: number): string | undefined {
  if (!Number.isFinite(i) || i < 0.5) return undefined;
  if (i < 1.5) return "1";
  if (i < 2.5) return "2";
  if (i < 3.5) return "3";
  if (i < 4.5) return "4";
  if (i < 5.0) return "5-";
  if (i < 5.5) return "5+";
  if (i < 6.0) return "6-";
  if (i < 6.5) return "6+";
  return "7";
}

/** 揺れの値が無い (届いていない・0.5 未満の) 観測点の色。控えた灰色 */
export const RTS_QUIET = "#9aa0a6";

/** 計測震度の色 (気象庁の配色の指針の震度の色。0.5 未満は灰色) */
export const rtsColor = (i: number | undefined) =>
  i === undefined
    ? RTS_QUIET
    : (INTENSITY_COLORS[rtsClass(i) ?? ""]?.bg ?? RTS_QUIET);

/**
 * 地図の点。観測点はいつも小さな灰色の点で置き、値の来た観測点は揺れの色で上に重ねる (大きい値ほど上)。
 * `frame` が無ければ全部灰色 (古くなった値は、画面が `RTS_STALE_MS` で消す。`live.svelte.ts` の `setRts`)
 */
export function rtsFeatures(
  stations: RtsStation[],
  frame: RtsFrame | null | undefined,
) {
  const key = (lon: number, lat: number) => `${lon},${lat}`;
  const value = new Map<string, number>();
  for (const [lon, lat, i] of frame?.points ?? []) {
    const k = key(lon, lat);
    // 同じ位置に何台もあるときは大きいほう
    value.set(k, Math.max(i, value.get(k) ?? -Infinity));
  }
  const at = new Map<string, RtsStation>();
  for (const s of stations) at.set(key(s[0], s[1]), s);
  for (const [lon, lat] of frame?.points ?? [])
    if (!at.has(key(lon, lat))) at.set(key(lon, lat), [lon, lat]);
  return {
    type: "FeatureCollection" as const,
    features: [...at.values()].map(([lon, lat]) => {
      const i = value.get(key(lon, lat));
      const shaking = i !== undefined && rtsClass(i) !== undefined;
      return {
        type: "Feature" as const,
        properties: {
          shaking,
          color: rtsColor(shaking ? i : undefined),
          order: shaking ? i : -10,
        },
        geometry: { type: "Point" as const, coordinates: [lon, lat] },
      };
    }),
  };
}
