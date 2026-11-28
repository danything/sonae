/**
 * 地図の現在地のボタンを、開いたときに自動で始めるかの決め方 (docs/map.md の「現在地を自動で始めるとき」)。
 * 既定はオン (2026-11-16。持ち主の声「デフォルトで現在地を表示してほしい」)。人がオン・オフを選んだら
 * 端末に覚える (`sonae.map.locate`)。位置そのものは覚えず、サーバーにも送らない。
 */

/** 覚えるときの localStorage の名前 (`sonae.` は prefs.ts が足す) */
export const LOCATE_PREF = "map.locate";

/** 位置の許可の状態。`navigator.permissions.query` が無い・例外になったときは "unknown" */
export type GeoPermission = PermissionState | "unknown";

/** 覚えた選択。null はまだ選んでいない (既定のオン) */
type LocateChoice = "on" | "off" | null;

/**
 * 開いたとき (と、許可が変わったとき) にすること。
 * - start: 自動で始める (許可がもうあるときだけ。許可の窓は出ない)
 * - ask: 始めて、許可の窓を出す (まだ選んでいない端末で、許可をまだ聞いていないときだけ。断られたらオフを覚えるので、聞くのは許可か拒否が決まるまで)
 * - wait: 始めない。オンは覚えたまま (押せば始まる。許可の窓は押したときだけ出す)
 * - forget: 許可が拒まれたので、オフを覚える (聞き直さない)
 * - none: オフを選んである
 */
type AutoLocate = "start" | "ask" | "wait" | "forget" | "none";

export function autoLocate(
  choice: LocateChoice,
  permission: GeoPermission,
): AutoLocate {
  if (choice === "off") return "none";
  if (permission === "granted") return "start";
  if (permission === "denied") return "forget";
  // 人がオンにした端末で許可が消えていたら、いきなり窓を出さずに押すのを待つ (前からの決まり)。
  // まだ選んでいない端末は、既定のオンとして聞く (断られたらオフを覚え、聞き直さない)
  return choice === "on" ? "wait" : "ask";
}

/** 覚えた値を読む。"on"・"off" のほかは、まだ選んでいない (既定のオン) */
export const readLocate = (raw: string | null): LocateChoice =>
  raw === "on" || raw === "off" ? raw : null;
