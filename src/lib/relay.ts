/**
 * 地図のタイルなどを、sonae のサーバーを通して読むための URL (docs/design.md の 2.14 「外のものをサーバーで中継する」)。
 * ブラウザは外の配信元へ直接つながず、`/relay/<源>/<道>` を読む。サーバーが配信元から取って覚え、家の中の端末で使い回す
 * (`#lib/server/relay.ts`)。どの源にどの道を通すかはサーバーの表が決め、表に無い道は 400 で断る。
 *
 * 地図のタイルは MapLibre が worker の中で読むものがあり、相対の URL では読めないので、ブラウザでは頭にいまの
 * origin を付ける。サーバーと試験 (origin が無い) では相対の URL のまま
 */

/** 中継の源の名前 (`#lib/server/relay.ts` の `RELAY_SOURCES` の鍵と同じ) */
export type RelaySourceId = "jmatile";

/** 中継の道の頭 */
export const RELAY_PATH = "/relay";

/** 源の頭の URL (`<origin>/relay/<源>`)。後ろに配信元と同じ道を足して使う */
export function relayBase(source: RelaySourceId): string {
  const origin = typeof location === "undefined" ? "" : (location.origin ?? "");
  return `${origin}${RELAY_PATH}/${source}`;
}
