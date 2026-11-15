/**
 * 地図の現在地のボタンを、開いたときに自動で始めるかの決め方 (docs/map.md の「現在地」)。
 * オンにしたかどうかは端末に覚える (`sonae.map.locate`)。位置そのものは覚えず、サーバーにも送らない。
 */

/** 覚えるときの localStorage の名前 (`sonae.` は prefs.ts が足す) */
export const LOCATE_PREF = "map.locate";

/** 位置の許可の状態。`navigator.permissions.query` が無い・投げたときは "unknown" */
export type GeoPermission = PermissionState | "unknown";

/**
 * 開いたとき (と、許可が変わったとき) にすること。
 * - start: 自動で始める (許可がもうあるときだけ。許可の窓は出ない)
 * - wait: 始めない。オンは覚えたまま (押せば始まる。許可の窓は押したときだけ出す)
 * - forget: 許可が拒まれたので、覚えたオンを消す
 * - none: オンを覚えていない
 */
export type AutoLocate = "start" | "wait" | "forget" | "none";

export function autoLocate(
  remembered: boolean,
  permission: GeoPermission,
): AutoLocate {
  if (!remembered) return "none";
  if (permission === "granted") return "start";
  if (permission === "denied") return "forget";
  return "wait";
}

/** 覚えた値を読む。"on" のときだけオン (前の形や壊れた値はオフ) */
export const readLocate = (raw: string | null): boolean => raw === "on";
