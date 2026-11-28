/**
 * 地図のタイルなどを、sonae のサーバーを通して読むための URL (docs/design.md の 2.14 「外のものをサーバーで中継する」)。
 * ブラウザは外の配信元へ直接つながず、`/relay/<源>/<道>` を読む。サーバーが配信元から取って覚え、家の中の端末で使い回す
 * (`#lib/server/relay.ts`)。どの源にどの道を通すかはサーバーの表が決め、表に無い道は 400 で断る。
 *
 * 地図のタイルは MapLibre が worker の中で読むものがあり、相対の URL では読めないので、ブラウザでは頭にいまの
 * origin を付ける。サーバーと試験 (origin が無い) では相対の URL のまま
 */

/** 中継の源の名前 (`#lib/server/relay.ts` の `RELAY_SOURCES` の鍵と同じ) */
export type RelaySourceId =
  | "jmatile"
  | "gsi"
  | "gsi-vector"
  | "disaportal"
  | "disaportal-legend"
  | "gibs"
  | "volcam"
  | "gsi-search";

/**
 * 中継の源ごとの、配信元との様子 (docs/design.md の 2.14 の「配信元が落ちたとき」)。受信の状態と地図の凡例に出す。
 * サーバーは SSE の `event: relay` で、変わったときと 30 秒ごとに送る
 */
export interface RelayStatus {
  id: RelaySourceId;
  /**
   * - `idle`: 起動してからまだ誰も読んでいない
   * - `ok`: 最後に取りに行ったとき、配信元から取れた
   * - `failing`: 配信元が落ちている・返らない・5xx (覚えた古いものがあれば、それを返している)
   * - `blocked`: 配信元に断られた (429・503) か、続けて失敗したので、取りに行くのを控えている
   */
  state: "idle" | "ok" | "failing" | "blocked";
  /** `failing`・`blocked` になった時刻 */
  since?: string;
  /** 最後に配信元から取れた (304 で確かめた時も含む) 時刻 */
  lastOkAt?: string;
  /** 次に取りに行く時刻 (`blocked` の間) */
  retryAt?: string;
  /** 最後に、覚えた古いものを返した時刻 (いまの `failing`・`blocked` の間に返したときだけ) */
  staleAt?: string;
}

/**
 * 中継の応答の見出し。`x-relay` は覚えたものか (`hit`・`miss`・`stale`。配信元が混んでいて待っている間の 503 は `busy`)、`x-relay-fetched-at` は、返したものを
 * 配信元から最後に取れた時刻 (ISO 8601)。`stale` のとき、画面は「◯時◯分に取ったもの」と出す
 */
export const RELAY_HEADER = "x-relay";
export const RELAY_FETCHED_HEADER = "x-relay-fetched-at";

/**
 * 中継の応答が、配信元が落ちていて覚えた古いものを返したものか。古くなければ undefined。
 * 古ければ、配信元から取った時刻 (ミリ秒)。時刻の見出しが読めなければ `fetchedAt` は無い (画面は時刻を出さない)
 */
export function relayStale(res: Response): { fetchedAt?: number } | undefined {
  if (res.headers.get(RELAY_HEADER) !== "stale") return undefined;
  const t = Date.parse(res.headers.get(RELAY_FETCHED_HEADER) ?? "");
  return Number.isFinite(t) ? { fetchedAt: t } : {};
}

/** 中継の道の頭 */
export const RELAY_PATH = "/relay";

/** 源の頭の URL (`<origin>/relay/<源>`)。後ろに配信元と同じ道を足して使う */
export function relayBase(source: RelaySourceId): string {
  const origin = typeof location === "undefined" ? "" : (location.origin ?? "");
  return `${origin}${RELAY_PATH}/${source}`;
}
